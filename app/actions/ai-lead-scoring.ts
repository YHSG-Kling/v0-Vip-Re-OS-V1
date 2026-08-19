"use server"

import { createClient } from "@/lib/supabase/server"
import { handleError } from "@/lib/errors"
import { generateTextRouted as generateText } from "@/lib/ai/models"

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
    const supabase = await createClient()

    // Get contact data (simple select — embedded relation tables may not exist)
    const { data: contact, error: contactError } = await supabase
      .from("contacts")
      .select("*")
      .eq("id", params.contactId)
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

    // AI scoring analysis
    const { text: analysis } = await generateText({
      model: "openai/gpt-4o-mini",
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
- Recent Interactions: ${interactions?.length || 0}
- Last Contact: ${contact.last_contacted_at || "Never"}

Provide a JSON response with:
{
  "overallScore": 0-100,
  "engagement": 0-100,
  "intent": 0-100,
  "qualification": 0-100,
  "motivation": 0-100,
  "readiness": "cold" | "warm" | "hot",
  "nextBestAction": "specific recommendation",
  "reasoning": "brief explanation",
  "priorities": ["priority1", "priority2", "priority3"]
}`,
    })

    // Extract JSON robustly — the AI may wrap output in markdown code blocks
    const jsonMatch = analysis.match(/```(?:json)?\s*([\s\S]*?)```/) ?? analysis.match(/(\{[\s\S]*\})/)
    const jsonText = jsonMatch ? (jsonMatch[1] ?? jsonMatch[0]) : analysis
    const scores = JSON.parse(jsonText.trim())

    // The model is free text, not a schema. `contacts.engagement_score` and
    // `contacts.intent_score` are INTEGER (scripts/010-create-contacts-schema.sql)
    // — a 72.5 from the model is rejected by Postgres and, because PostgREST
    // refuses the update as a WHOLE, it takes every other column in the same
    // statement down with it. Coerce to a clamped integer, and drop the key
    // entirely when the model returned something unusable rather than writing a
    // fabricated 0 over a real prior score.
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
    const { data: updatedRows, error: contactUpdateError } = await supabase
      .from("contacts")
      .update(updates)
      .eq("id", params.contactId)
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
