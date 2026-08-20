"use server"

import { createClient } from "@/lib/supabase/server"
import { handleError } from "@/lib/errors"
import { generateObject } from "@/lib/ai/generate"
import { z } from "zod"

/**
 * The caller, and the tenant they may score inside.
 *
 * MERGED IN from app/actions/ai-lead-nurturing.ts:aiCalculateLeadScore (deleted;
 * see the tombstone there). This file is a `"use server"` module — every export
 * is a public HTTP endpoint — and it had NO gate at all: any authenticated user
 * could name any contactId and this would read the row, spend paid inference on
 * it and write scores back, with only RLS between them and another brokerage's
 * book. The duplicate had the gate; the survivor did not. Merging the two the
 * other way round would have lost it.
 */
async function requireCaller(): Promise<
  | { ok: true; userId: string; brokerageId: string }
  | { ok: false; error: string }
> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { ok: false, error: "Unauthorized" }
  const { data: u } = await supabase
    .from("users")
    .select("brokerage_id")
    .eq("id", user.id)
    .maybeSingle()
  if (!u?.brokerage_id) return { ok: false, error: "Unauthorized" }
  return { ok: true, userId: user.id, brokerageId: u.brokerage_id }
}

/**
 * The scoring contract, as a SCHEMA rather than as a hope.
 *
 * MERGED IN from aiCalculateLeadScore. The survivor asked for JSON in prose and
 * then regex-matched a `{ … }` out of the reply — which throws on a fenced or
 * chatty response, and silently yields whatever shape the model felt like on a
 * well-formed one. `overallScore`, `engagement` and `intent` kept their original
 * names so the CRM's "Run AI Score" button (app/crm/page.tsx:1244 reads
 * `result.scores.overallScore`) and this file's own `lead_score_history` write
 * are unchanged; the five dimensions below them are what the duplicate had and
 * this one did not.
 */
const LeadScoreSchema = z.object({
  overallScore: z.number().min(0).max(100),
  engagement: z.number().min(0).max(100),
  intent: z.number().min(0).max(100),
  qualification: z.number().min(0).max(100),
  motivation: z.number().min(0).max(100),
  readiness: z.enum(["cold", "warm", "hot"]),
  // ── the merge payload: dimensions the duplicate produced and this one did not
  timelineScore: z.number().min(0).max(100),
  financialReadinessScore: z.number().min(0).max(100),
  buyerPersona: z.enum(["first_time_buyer", "move_up_buyer", "investor", "downsizer", "relocating", "unknown"]),
  predictedTimeline: z.enum(["immediate", "1_3_months", "3_6_months", "6_12_months", "12_plus_months"]),
  riskOfLoss: z.enum(["low", "medium", "high"]),
  factors: z.object({
    positive: z.array(z.string()),
    negative: z.array(z.string()),
    neutral: z.array(z.string()),
  }),
  nextBestAction: z.string(),
  reasoning: z.string(),
  priorities: z.array(z.string()),
})

/**
 * LAYER 2 — AI Scoring (nuance refinement of conversational/behavioral signals).
 *
 * Refines the AI-nuanced score columns that ACTUALLY EXIST on `contacts`:
 * `engagement_score` and `intent_score` (plus a `last_scored_at` stamp). When
 * called via explicit agent UI action ("Run AI Score" button on the CRM), this
 * also overrides `lead_score` — that's the documented agent-driven override.
 *
 * `qualification_score`, `motivation_score` and `readiness_level` are NOT columns
 * on `contacts`, despite what the table in `lib/lead-scoring/LAYERING.md` still
 * says (that table is wrong on all three names — verified against the committed
 * live-schema cache scripts/schema-snapshot.ts). Those three dimensions are
 * persisted to `lead_score_history` instead; readiness rides in its `factors`
 * blob, matching Layer 3 in lib/lead-intelligence/signal-extensions.ts.
 *
 * Background / cron callers should NOT overwrite `lead_score` (Layer 1 owns
 * the deterministic baseline). A future commit will add a `mode: 'override'
 * | 'refine'` parameter so background callers can opt into refine-only.
 *
 * See `lib/lead-scoring/LAYERING.md` for full layering rules and the four
 * scoring systems that touch these columns.
 *
 * ── THE SURVIVOR OF A MERGE (orphan burn-down, category C) ──────────────────
 * `app/actions/ai-lead-nurturing.ts:aiCalculateLeadScore` was a SECOND Layer-2
 * scorer with no caller anywhere, standing against LAYERING.md rule 4 ("Do not
 * create a fifth top-level scorer"). Two successive waves recorded the verdict —
 * merge onto this function, then delete — and left it undone because this file
 * was outside their lane. It is done now. Everything the duplicate had and this
 * did not came across first, and only then was it deleted (tombstone in place):
 *
 *   · AN AUTH GATE AND A TENANT PREDICATE. This module is `"use server"`, so
 *     every export is a public endpoint, and this function had NO caller check at
 *     all — any authenticated user could name any contact id and have paid
 *     inference spent on it and scores written back. requireCaller() + the
 *     `brokerage_id` predicate on the contact read AND the update are the
 *     duplicate's, moved here.
 *   · A SCHEMA INSTEAD OF A REGEX. It asked for JSON in prose and pulled a
 *     `{ … }` out of the reply with a regex; now generateObject + LeadScoreSchema.
 *   · BEHAVIOURAL INPUTS. It scored engagement off `messages` alone — no logged
 *     call, no showing, no email open. `activities` and `email_tracking` are now
 *     read too. (The duplicate's third read, `lead_property_searches`, was NOT
 *     carried: it filed a contact id in a lead column and could only ever return
 *     nothing — see the note at its former call site below.)
 *   · FIVE MORE DIMENSIONS — timelineScore, financialReadinessScore,
 *     buyerPersona, predictedTimeline, riskOfLoss — plus the positive/negative/
 *     neutral factor split, persisted to `contacts.ai_insights` and into the
 *     `lead_score_history.factors` blob.
 *
 * The public contract is unchanged: `result.scores.overallScore` still exists and
 * still means what the CRM's "Run AI Score" button (app/crm/page.tsx:1244) reads.
 */
export async function scoreLeadWithAI(params: {
  contactId: string
  agentId: string
  /**
   * Write mode (default 'refine'):
   *   - 'refine'   — write only AI-nuanced columns (engagement_score,
   *                  intent_score) plus the lead_score_history audit row.
   *                  DOES NOT touch lead_score baseline.
   *                  Use for background/cron callers.
   *   - 'override' — same as refine PLUS overwrite lead_score with the AI
   *                  overall score. Use ONLY when an agent explicitly
   *                  triggers this from the UI ("Run AI Score" button on
   *                  the CRM contact card). Never from background work.
   */
  mode?: "refine" | "override"
}) {
  try {
    const auth = await requireCaller()
    if (!auth.ok) return { success: false, error: auth.error }

    const supabase = await createClient()

    // Get contact data (simple select — embedded relation tables may not exist).
    // TENANT PREDICATE merged in from the deleted duplicate: without it this
    // action would read, and spend inference on, any contact id a caller cared to
    // name.
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", params.contactId)
      .eq("brokerage_id", auth.brokerageId)
      .maybeSingle()

    if (contactError) throw contactError
    if (!contact) throw new Error("Contact not found")

    // Get interaction history
    const { data: interactions } = await supabase
      .from("messages")
      .select("*")
      .eq("contact_id", params.contactId)
      .order("created_at", { ascending: false })
      .limit(20)

    // ── BEHAVIOURAL INPUTS — merged in from aiCalculateLeadScore ──────────────
    // This scorer read `messages` ALONE, so it judged engagement without ever
    // seeing a logged call, a showing, or an email open. Two of the duplicate's
    // three behavioural reads come across intact.
    const { data: activityLog } = await supabase
      .from("activities")
      .select("activity_type, title, outcome, channel, status, created_at")
      .eq("contact_id", params.contactId)
      .eq("brokerage_id", auth.brokerageId)
      .order("created_at", { ascending: false })
      .limit(50)

    const { data: emailActivity } = await supabase
      .from("email_tracking")
      .select("event_type, event_at, url")
      .eq("contact_id", params.contactId)
      .eq("brokerage_id", auth.brokerageId)
      .order("event_at", { ascending: false })
      .limit(50)

    // ── THE THIRD READ IS DELIBERATELY NOT MERGED ────────────────────────────
    // aiCalculateLeadScore also read `lead_property_searches` with
    // `.eq("lead_id", params.contactId)` — a CONTACT id in a LEAD column. That is
    // the exact defect wave 18 ruled on and removed elsewhere: the table is keyed
    // on the pre-conversion lead id, has no contacts column, and its writer was
    // deleted for filing a contacts id there (see app/actions/ai-predictions.ts
    // :355 extractFactors, which records the same finding). The read therefore
    // returns nothing, always, for every contact — carrying it forward would move
    // a known-dead query onto the survivor and make the prompt claim "0 property
    // searches" as if that were an observation about the person. Property-search
    // interest is not collected on contacts today; when it is, it belongs here.

    const { object: scores } = await generateObject({
      model: "openai/gpt-4o-mini",
      schema: LeadScoreSchema,
      prompt: `You are an AI real estate lead scoring expert. Analyze this lead comprehensively.

Contact Details:
- Name: ${contact.first_name} ${contact.last_name}
- Email: ${contact.email}
- Phone: ${contact.phone || "Not provided"}
- Current Stage: ${contact.lifecycle_state || "New"}
- Source: ${contact.source || "Unknown"}
- Budget: ${contact.budget_min ? `$${contact.budget_min} - $${contact.budget_max}` : "Not specified"}
- Preferred Areas: ${contact.preferred_areas?.join(", ") || "Not specified"}
- Timeline: ${contact.buying_timeline || "Unknown"}

Behavioral Data:
- Recent Messages: ${interactions?.length || 0}
- Last Contact: ${contact.last_contacted_at || "Never"}
- Logged Activities (${activityLog?.length || 0}):
${JSON.stringify(activityLog?.slice(0, 10) ?? [], null, 2)}
- Email Engagement Events (${emailActivity?.length || 0}):
${JSON.stringify(emailActivity?.slice(0, 10) ?? [], null, 2)}

Score every dimension 0-100, split the evidence into positive/negative/neutral
factors, and name the single next best action.`,
    })

    // The schema bounds each score to 0-100 but NOT to an integer, and
    // `contacts.engagement_score` / `contacts.intent_score` are INTEGER
    // (scripts/010-create-contacts-schema.sql) — a 72.5 is rejected by Postgres
    // and, because PostgREST refuses the update as a WHOLE, it takes every other
    // column in the same statement down with it. So the coercion stays exactly as
    // it was: clamp and round, and drop the key entirely when the value is
    // unusable rather than writing a fabricated 0 over a real prior score.
    const asScore = (v: unknown): number | undefined => {
      const n = typeof v === "number" ? v : Number(v)
      if (!Number.isFinite(n)) return undefined
      return Math.max(0, Math.min(100, Math.round(n)))
    }
    const engagement = asScore(scores.engagement)
    const intent = asScore(scores.intent)
    const qualification = asScore(scores.qualification)
    const motivation = asScore(scores.motivation)
    const overall = asScore(scores.overallScore)
    const readiness = typeof scores.readiness === "string" ? scores.readiness.trim().toLowerCase() : null

    // Update contact with scores. Write boundaries per layering rules:
    //   - 'override' mode (explicit agent action): writes lead_score baseline
    //   - 'refine' mode (background, default): only AI-nuanced columns
    //
    // ── WHY THIS UPDATE NAMES ONLY COLUMNS THAT EXIST ───────────────────────
    // It used to also name `qualification_score`, `motivation_score` and
    // `readiness_level`. NONE OF THE THREE EXISTS on `contacts` (verified against
    // the committed live-schema cache, scripts/schema-snapshot.ts: the table has
    // engagement_score, intent_score, lead_score, isa_qualification_score,
    // referral_score, confidence_score — and no readiness column at all).
    // PostgREST refuses an UPDATE naming an unknown column ENTIRELY (PGRST204),
    // so the two REAL columns beside them were never written either; and because
    // this call site DOES destructure the error and throw it, the whole action
    // threw and the CRM's "Run AI Score" button has failed 100% of the time since
    // it was wired. This was a thrown refusal, not a swallowed one.
    //
    // The three dimensions are NOT lost — they persist to `lead_score_history`
    // below, which layering rule 5 names as the single audit log for all score
    // changes, and which really does have qualification_score/motivation_score.
    // Readiness has no column anywhere, so it goes in the history `factors` blob
    // — exactly what Layer 3 already does (lib/lead-intelligence/signal-extensions.ts:
    // "Readiness lives in factors only (no column on contacts)").
    const mode = params.mode ?? "refine"
    const updates: Record<string, unknown> = { last_scored_at: new Date().toISOString() }
    if (engagement !== undefined) updates.engagement_score = engagement
    if (intent !== undefined) updates.intent_score = intent
    if (mode === "override" && overall !== undefined) {
      updates.lead_score = overall
    }
    // ── ai_insights — merged in from aiCalculateLeadScore ────────────────────
    // The five extra dimensions have no column of their own on `contacts`, and
    // this is where the duplicate put them so an agent looking at the card can
    // see WHY the number moved. `contacts.ai_insights` is a **text** column, not
    // jsonb (verified live) — the duplicate's own header records that assigning
    // it an object made PostgREST refuse the whole update — so it is serialised.
    updates.ai_insights = JSON.stringify({
      lastScored: new Date().toISOString(),
      aiOverallScore: overall ?? null,
      engagementScore: engagement ?? null,
      intentScore: intent ?? null,
      timelineScore: scores.timelineScore,
      financialReadinessScore: scores.financialReadinessScore,
      buyerPersona: scores.buyerPersona,
      predictedTimeline: scores.predictedTimeline,
      riskOfLoss: scores.riskOfLoss,
      nextBestAction: scores.nextBestAction,
      factors: scores.factors,
    })
    const { data: updatedRows, error: contactUpdateError } = await supabase
      .from("contacts")
      .update(updates)
      .eq("id", params.contactId)
      // Tenant anchor on the WRITE as well as the read — merged in from the
      // deleted duplicate, which had it on both and this one had it on neither.
      .eq("brokerage_id", auth.brokerageId)
      .select("id")
    if (contactUpdateError) throw contactUpdateError
    // A zero-row update is a refusal wearing the shape of success: supabase-js
    // RESOLVES an RLS-filtered update with no error and no rows.
    if (!updatedRows || updatedRows.length === 0) {
      throw new Error(`Scoring wrote no row for contact ${params.contactId} (not visible to this caller)`)
    }

    // Log scoring event.
    //
    // TENANT — from the CONTACT this history row is filed against, read at the
    // top of this function (`select("*")`, so brokerage_id is already in hand)
    // and never from `params.agentId`, which is an agents.id and not a tenant.
    // The other three lead_score_history writers — contact-capture.ts,
    // lead-acquisition-handlers.ts, enrichment-orchestrator.ts — all stamp
    // brokerage_id; this one did not, so the same table has been taking rows
    // with and without a tenant, and any reader that narrows to
    // `.eq("brokerage_id", …)` hides exactly the unstamped half.
    const scoreBrokerageId = (contact.brokerage_id as string | null) ?? null
    if (!scoreBrokerageId) {
      // Honest rather than invented: an untenanted contact has no tenant to
      // inherit, and agent_id is not one.
      console.warn(
        `[ai-lead-scoring] contact ${params.contactId} carries no brokerage_id — lead_score_history row written untenanted`,
      )
    }
    const { error: historyError } = await supabase.from("lead_score_history").insert({
      brokerage_id: scoreBrokerageId,
      contact_id: params.contactId,
      lead_id: null,
      overall_score: overall,
      engagement_score: engagement,
      intent_score: intent,
      qualification_score: qualification,
      motivation_score: motivation,
      // `factors` is jsonb (Layer 3 writes an object into it). Readiness has no
      // column on `contacts`, so this blob is its only home — same convention as
      // signal-extensions.ts, so one reader can serve both writers.
      factors: {
        source: "ai-lead-scoring",
        mode,
        reason: typeof scores.reasoning === "string" ? scores.reasoning : null,
        readiness_signal: readiness,
        next_best_action: typeof scores.nextBestAction === "string" ? scores.nextBestAction : null,
        // Merged in from aiCalculateLeadScore: the audit row now carries the same
        // five dimensions the contact card shows, so the history explains the
        // score instead of only recording it.
        timeline_score: scores.timelineScore,
        financial_readiness_score: scores.financialReadinessScore,
        buyer_persona: scores.buyerPersona,
        predicted_timeline: scores.predictedTimeline,
        risk_of_loss: scores.riskOfLoss,
        evidence: scores.factors,
      },
      ai_recommendations: Array.isArray(scores.priorities) ? scores.priorities : null,
      scored_at: new Date().toISOString(),
    })
    // supabase-js RESOLVES a refused insert, so an unread error here is a
    // scoring event that silently never happened.
    if (historyError) throw historyError

    return {
      success: true,
      scores,
    }
  } catch (error) {
    return handleError(error, "scoreLeadWithAI")
  }
}

/**
 * Get lead insights and score breakdown
 */
export async function getLeadInsights(contactId: string) {
  try {
    const supabase = await createClient()

    // Two reads, not a PostgREST embed. The embed this used to attempt —
    // `lead_score_history(* order by scored_at desc limit 5)` — is not PostgREST
    // syntax (ordering/limiting an embedded resource goes through .order()/.limit()
    // with `referencedTable`, never inside the select string), so the request was
    // rejected and this action threw on every call.
    const { data: rawContact, error: contactError } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", contactId)
      .maybeSingle()
    if (contactError) throw contactError
    const contact = rawContact as any

    const { data: history, error: historyError } = await supabase
      .from("lead_score_history")
      .select("*")
      .eq("contact_id", contactId)
      .order("scored_at", { ascending: false })
      .limit(5)
    if (historyError) throw historyError

    // `qualification_score`, `motivation_score` and `readiness_level` are NOT
    // columns on `contacts` (see scripts/schema-snapshot.ts). Reading them off the
    // contact row silently yielded 0/0/"cold" for every lead — a confident-looking
    // lie. They live on the newest `lead_score_history` row instead, with readiness
    // inside its `factors` blob.
    const latest = (history?.[0] ?? null) as any
    const latestFactors = latest && typeof latest.factors === "object" ? latest.factors : null

    return {
      success: true,
      currentScore: {
        overall: contact?.lead_score ?? latest?.overall_score ?? 0,
        engagement: contact?.engagement_score ?? latest?.engagement_score ?? 0,
        intent: contact?.intent_score ?? latest?.intent_score ?? 0,
        qualification: latest?.qualification_score ?? 0,
        motivation: latest?.motivation_score ?? 0,
        readiness: latestFactors?.readiness_signal ?? "cold",
      },
      history: history ?? [],
      contact,
    }
  } catch (error) {
    return handleError(error, "getLeadInsights")
  }
}

/**
 * Bulk score multiple leads
 */
export async function bulkScoreLeads(params: {
  agentId: string
  contactIds?: string[]
  leadStage?: string
}) {
  try {
    const supabase = await createClient()

    let query = supabase
      .from("contacts")
      .select("id, first_name, last_name")
      .eq("agent_id", params.agentId)

    if (params.contactIds) {
      query = query.in("id", params.contactIds)
    } else if (params.leadStage) {
      query = query.eq("lifecycle_state", params.leadStage)
    } else {
      // Score all active leads by default
      query = query.in("lifecycle_state", ["new", "nurturing", "qualified"])
    }

    const { data: contacts, error } = await query.limit(50)

    if (error) throw error

    const results = []
    for (const contact of contacts || []) {
      const result = await scoreLeadWithAI({
        contactId: contact.id,
        agentId: params.agentId,
      })
      results.push({
        contactId: contact.id,
        name: `${contact.first_name} ${contact.last_name}`,
        ...result,
      })
    }

    return {
      success: true,
      totalScored: results.length,
      results,
    }
  } catch (error) {
    return handleError(error, "bulkScoreLeads")
  }
}
