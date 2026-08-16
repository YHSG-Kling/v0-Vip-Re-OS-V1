

import { createClient } from "@/lib/supabase/server"
import { isValidUUID, validateEmail, validatePhone } from "@/lib/validations"
import { LEAD_SOURCES } from "@/lib/constants"
import { scoreToLeadTemperature } from "@/lib/data-steward/value-normalizer"
import { handleError, ValidationError, NotFoundError } from "@/lib/errors"
import {
  summarizeBehavioralEvents,
  priorityTier,
  type BehavioralSummary,
} from "@/lib/lead-scoring/behavioral-events"

// ============================================
// UNIFIED LEAD MANAGEMENT SERVICE
// Consolidates all lead operations across the app
// Replaces duplicates in: leads.ts, crm.ts, lead-intelligence.ts, ai-insights.ts
// ============================================

export interface LeadScoringParams {
  id: string // Can be contactId or leadId
  /**
   * OPTIONAL, and deliberately unused by the scoring itself.
   *
   * It was required, and the implementation never read it — so every caller passed
   * an agent id that changed nothing. It stays only as caller context, because the
   * one place ownership matters (the lead_scores snapshot's NOT NULL agent_id) must
   * use the OWNER ON THE RECORD, not whoever asked for the score. A caller-supplied
   * id that disagreed with contacts.agent_id would file the snapshot under the wrong
   * agent and put the lead in the wrong person's hot-lead list.
   */
  agentId?: string
  recalculate?: boolean
  table?: "contacts" | "leads" // Which table to score
}

export interface LeadScoringResult {
  score: number
  temperature: string
  factors: {
    engagement: number
    recency: number
    intent: number
    fit: number
    responsiveness: number
  }
  recommendations: string[]
}

/**
 * CANONICAL LEAD SCORE ORCHESTRATOR — sole writer of `lead_score` column.
 *
 * Pipeline:
 *   1. Fetch record + relations from contacts/leads
 *   2. Run Layer 1 (multi-factor deterministic scorer) for the canonical
 *      baseline — `lib/lead-governance/multi-factor-scorer.ts`
 *   3. Layer in behavioral signals (engagement, recency, intent, fit,
 *      responsiveness) as a refinement on top of the baseline
 *   4. Persist the combined score to `lead_score` + temperature + history
 *
 * EVERY write to `contacts.lead_score` and `leads.lead_score` MUST go through
 * this function. Layer 2 (AI scoring) refines AI-nuanced columns only and
 * does not bypass this. Layer 3 (signal extensions) only pushes UP via
 * `applySignalDelta`. See `lib/lead-scoring/LAYERING.md`.
 *
 * Combination formula (deterministic):
 *   final_score = clamp(0, 100, multi_factor_baseline × 0.7 + behavioral × 0.3)
 *
 * The 70/30 split keeps the multi-factor baseline as the dominant signal —
 * static lead data is more reliable than behavioral inference. Behavioral
 * refinement bumps the score for high-engagement contacts and dampens for
 * stale ones, but cannot single-handedly invert the baseline.
 */
export async function calculateLeadScore(params: LeadScoringParams): Promise<LeadScoringResult> {
  try {
    if (!isValidUUID(params.id)) {
      throw new ValidationError("Invalid ID")
    }

    const table = params.table || "contacts"
    const supabase = await createClient()

    let record: any
    let error: any

    if (table === "contacts") {
      // TWO of the three embeds this read carried could never resolve, and ONE
      // unresolvable embed refuses the WHOLE query (PGRST200) — so no contact has
      // ever been scored here; every call fell through to the NotFoundError below.
      //   · `buyer_persona(*)` — there is NO public.buyer_persona table and no such
      //     column on contacts. A phantom; do not restore it. The real per-contact
      //     persona is client_detailed_personas, which DOES declare
      //     client_detailed_personas.contact_id -> contacts.id, so it is embeddable and
      //     is embedded below — calculateFitScore genuinely consumes it.
      //   · `lead_intelligence(*)` — keyed on lead_id, declares NO foreign key to
      //     contacts (pg_constraint carries brokerage_id only), exactly like its
      //     sibling lead_behavioral_data. Fetched below by the link that does exist.
      // property_interactions IS a declared relationship (contact_id -> contacts.id)
      // and stays. Every embed names its columns — never `*` inside an embed, which
      // hides drift from the schema guard (defect #214). Only the persona's EXISTENCE
      // is scored, so only its key is named.
      const result = await supabase
        .from("contacts")
        .select(`
          *,
          property_interactions(id, interaction_type),
          client_detailed_personas(id)
        `)
        .eq("id", params.id)
        .single()
      record = result.data
      error = result.error
      // The two relations that cannot be embedded on contacts, fetched by the link that
      // does exist. lead_behavioral_data was never fetched here either, despite the old
      // comment saying so, so every behavioural factor was computed from `undefined`
      // for CONTACTS while the leads branch did fetch it.
      // lead_id is the PRE-CONVERSION id class: a contact that was never a scraped lead
      // legitimately has no intelligence/behaviour row, and that is an absence, not an
      // error. Same lookup app/actions/ai-predictions.ts uses for these two tables.
      if (record) {
        // `location_preferences` is NEW to this select and it is the fix for the
        // dead +10 in calculateFitScore — see the note at that branch.
        const { data: intelligence, error: intelligenceError } = await supabase
          .from("lead_intelligence")
          .select("id, timeline, pre_approved, location_preferences")
          .eq("lead_id", params.id)
        if (intelligenceError) {
          console.error("[lead-management] lead_intelligence read failed:", intelligenceError.message)
        }
        record.lead_intelligence = intelligence || []

        const { data: behavioral, error: behavioralError } = await supabase
          .from("lead_behavioral_data")
          .select("event_type, event_data, occurred_at")
          .eq("lead_id", params.id)
        if (behavioralError) {
          console.error("[lead-management] lead_behavioral_data read failed:", behavioralError.message)
        }
        record.lead_behavioral_data = behavioral || []
      }
    } else {
      // Same defect on the leads side, and it was equally fatal: NEITHER
      // lead_intelligence NOR lead_motivated_seller_signals declares a foreign key to
      // leads (pg_constraint carries brokerage_id only for both), so this read was
      // refused too and no scraped lead has been scored either. Fixing one sibling and
      // not the other is how a defect class survives being found.
      const result = await supabase
        .from("leads")
        .select("*")
        .eq("id", params.id)
        .single()
      record = result.data
      error = result.error
      // All three are keyed on lead_id and fetched by that link instead.
      if (record) {
        const { data: intelligence } = await supabase
          .from("lead_intelligence")
          .select("id, timeline, pre_approved")
          .eq("lead_id", params.id)
        record.lead_intelligence = intelligence || []

        // REPOINTED to the survivor. `lead_motivated_seller_signals` is the RETIRED
        // twin: it has readers and NO WRITER anywhere in the tree, so this scoring
        // component was structurally always zero — the writer-less-read sweep is what
        // said so out loud. `motivated_seller_signals` is the live table: written by
        // app/actions/lead-intelligence.ts:1245 and :2363, read by
        // app/actions/ai-predictions.ts:204, and named as the target of this exact
        // repoint in the eight-legacy-twin burn-down already recorded in
        // scripts/doc-kernel-simulator.ts:2144. This file was the straggler.
        //
        // Both tables carry `lead_id` and `signal_strength`, which is all this scorer
        // reads, so the threshold below is unchanged — it can simply now be met.
        const { data: sellerSignals, error: sellerSignalsError } = await supabase
          .from("motivated_seller_signals")
          .select("id, signal_strength")
          .eq("lead_id", params.id)
        if (sellerSignalsError) {
          console.error("[lead-management] motivated_seller_signals read failed:", sellerSignalsError.message)
        }
        record.motivated_seller_signals = sellerSignals || []

        const { data: behavioral } = await supabase
          .from("lead_behavioral_data")
          .select("event_type, event_data, occurred_at")
          .eq("lead_id", params.id)
        record.lead_behavioral_data = behavioral || []
      }
    }

    if (error || !record) {
      throw new NotFoundError(`${table === "contacts" ? "Contact" : "Lead"} not found`)
    }

    // ── Layer 1: Multi-factor deterministic baseline ────────────────────
    // Single source of truth for the static-data score. Returns 0-100.
    const { calculateLeadScore: multiFactorScorer } = await import(
      "@/lib/lead-governance/multi-factor-scorer"
    )
    const multiFactorResult = multiFactorScorer(record)
    const baselineScore = multiFactorResult.finalScore

    // ── Behavioral refinement (additive layer on the baseline) ─────────
    // These factors capture in-app behavior that multi-factor doesn't see.
    //
    // The event log is folded ONCE, by the one module that understands its shape
    // (lib/lead-scoring/behavioral-events). It replaces reads of four columns that
    // do not exist on lead_behavioral_data — email_open_count, site_visit_count,
    // response_rate, avg_response_time_hours — which made 45 of engagement's 100
    // points unreachable and pinned responsiveness at a constant 50.
    const behavior = summarizeBehavioralEvents(record.lead_behavioral_data ?? [])
    const engagementScore = calculateEngagementScore(record, table, behavior)
    const recencyScore = Math.max(calculateRecencyScore(record), behavior.recency)
    const intentScore = Math.max(calculateIntentScore(record, table), behavior.intent)
    const fitScore = calculateFitScore(record, table)
    const responsivenessScore = behavior.responsiveness
    const behavioralScore = Math.round(
      engagementScore * 0.25 + recencyScore * 0.2 + intentScore * 0.3 + fitScore * 0.15 + responsivenessScore * 0.1
    )

    // ── Combined final score (70% baseline + 30% behavioral refinement) ─
    const totalScore = Math.max(0, Math.min(100, Math.round(baselineScore * 0.7 + behavioralScore * 0.3)))

    const temperature = scoreToLeadTemperature(totalScore)
    const recommendations = generateLeadRecommendations(record, {
      engagement: engagementScore,
      recency: recencyScore,
      intent: intentScore,
      fit: fitScore,
      responsiveness: responsivenessScore,
    })

    // Update appropriate database table
    if (table === "contacts") {
      await supabase
        .from("contacts")
        .update({
          lead_score: totalScore,
          lead_temperature: temperature,
          last_scored_at: new Date().toISOString(),
        })
        .eq("id", params.id)

      // ── CONTACT-SIDE SNAPSHOT: lead_scores ────────────────────────────
      // contacts.lead_score is the score ON the contact; lead_scores carries the
      // EXPLANATION beside it — score_factors, ai_confidence, computed_at. Live
      // schema: UNIQUE (contact_id), so it is one current row per contact, not a
      // history (a nearby-looking table, lead_engagement_scores on the leads branch
      // below, IS append-only — do not assume the two behave alike). Both are kept
      // and synced, per the owner's ruling on the commission ledgers.
      //
      // Why this write has to exist: getHotLeads — the hot-lead list on the agent
      // dashboard AND /leads — queries lead_scores where score >= 70. Nothing on the
      // authoritative path ever wrote that table; only the deprecated
      // ai-auto-response scorer did, and its floor(points/10) put 70 at 700 raw
      // event points. So the surface was empty by arithmetic while the real scores
      // sat in a column it does not read. contact-intelligence's "latest_lead_score"
      // read the same stale table beside contacts.last_scored_at from this path —
      // two numbers from two formulas in one panel.
      //
      // agent_id is NOT NULL on lead_scores, so an unowned contact is skipped rather
      // than failing the whole scoring call: a snapshot is a bonus, never the point.
      if (record.agent_id) {
        // UPSERT ON contact_id, explicitly. A plain insert violates
        // lead_scores_contact_id_key on the SECOND scoring run, so the snapshot
        // would freeze at whatever the first run said — and PostgREST's default
        // conflict target is the primary key (id), which never collides on an
        // insert, so an unqualified .upsert() fails exactly the same way. The
        // deprecated scorer this replaces did precisely that.
        await supabase.from("lead_scores").upsert({
          contact_id: params.id,
          agent_id: record.agent_id,
          brokerage_id: record.brokerage_id ?? null,
          score: totalScore,
          score_factors: {
            engagement: engagementScore,
            recency: recencyScore,
            intent: intentScore,
            fit: fitScore,
            responsiveness: responsivenessScore,
            temperature,
            priority: priorityTier(totalScore, intentScore, engagementScore),
            multi_factor_baseline: baselineScore,
            behavioral_events: behavior.eventCount,
          },
          // The multi-factor baseline is deterministic and explainable; the
          // behavioural layer is inference over an event log. Confidence reflects
          // whether there was any behaviour to infer from, instead of a flat 0.8.
          ai_confidence: behavior.eventCount > 0 ? 0.9 : 0.7,
          computed_at: new Date().toISOString(),
        }, { onConflict: "contact_id" })
      }
    } else {
      // Update leads table
      await supabase
        .from("leads")
        .update({
          lead_score: totalScore,
          // leads uses lead_temperature (not temperature) and has no last_scored_at —
          // the old keys PGRST204-failed, so scraped-lead scores never persisted.
          lead_temperature: temperature,
          last_activity_at: new Date().toISOString(),
        })
        .eq("id", params.id)

      // Store scoring snapshot in lead_engagement_scores (live: overall_score + per-factor
      // int columns + score_breakdown jsonb; no score_type/score_value/factors columns).
      //
      // ── TENANT: `record.brokerage_id`, AND NOTHING ELSE ────────────────────
      // lead_engagement_scores carries the same live policy as the rest of this
      // family — `FOR ALL … USING ((brokerage_id IS NULL) OR (brokerage_id =
      // current_user_brokerage_id()))` — so an unstamped snapshot is not hidden,
      // it is readable AND writable by every brokerage on the platform.
      //
      // It is taken from THE RECORD BEING SCORED, which this function already
      // read by primary key and refused on absence above (NotFoundError). Not
      // from the caller: `params.agentId` is explicitly documented as inert
      // caller context, and `record.agent_id` is an owner, not a tenant —
      // agents.id and brokerages.id are disjoint id spaces.
      //
      // MIRRORS RATHER THAN INVENTS. This branch scores the pre-conversion lane,
      // where a record that has not been distributed to a brokerage genuinely has
      // no tenant. `?? null` reproduces the parent's tenancy exactly: a
      // distributed record's snapshot is scoped to its brokerage, an
      // undistributed one's stays platform-level like the record it describes.
      // Stamping anything else here would attribute a platform record to a
      // tenant that does not own it.
      const { error: engagementScoreError } = await supabase.from("lead_engagement_scores").insert({
        lead_id: params.id,
        brokerage_id: record.brokerage_id ?? null,
        overall_score: totalScore,
        email_engagement_score: engagementScore,
        property_interest_score: intentScore,
        response_rate_score: responsivenessScore,
        recency_score: recencyScore,
        score_breakdown: {
          engagement: engagementScore,
          recency: recencyScore,
          intent: intentScore,
          fit: fitScore,
          responsiveness: responsivenessScore,
        },
      })
      // supabase-js RESOLVES a failed write, so `const { }` with no `error`
      // turns a refusal into a silent no-op. Report it.
      if (engagementScoreError) {
        console.error("[lead-management] lead_engagement_scores insert error:", engagementScoreError)
      }
    }

    return {
      score: totalScore,
      temperature,
      factors: {
        engagement: engagementScore,
        recency: recencyScore,
        intent: intentScore,
        fit: fitScore,
        responsiveness: responsivenessScore,
      },
      recommendations,
    }
  } catch (error) {
    handleError(error, "calculateLeadScore")
    return {
      score: 0,
      temperature: "cold",
      factors: { engagement: 0, recency: 0, intent: 0, fit: 0, responsiveness: 0 },
      recommendations: [],
    }
  }
}

/**
 * Calculate engagement score (0-100)
 * Works for both contacts and leads tables
 */
function calculateEngagementScore(record: any, table: string, behavior: BehavioralSummary): number {
  let score = 0

  if (table === "contacts") {
    const interactions = record.property_interactions || []

    // Property views
    const views = interactions.filter((i: any) => i.interaction_type === "view").length
    score += Math.min(views * 5, 30)

    // Saved properties
    const saves = interactions.filter((i: any) => i.interaction_type === "save").length
    score += Math.min(saves * 10, 25)

    // Logged behaviour — opens, clicks, visits, form submits and the rest, from the
    // EVENT LOG. This replaced `behavioralData?.email_open_count` (max 20) and
    // `behavioralData?.site_visit_count` (max 25): 45 of these 100 points read
    // columns lead_behavioral_data does not have, so they were always zero.
    score += Math.min(Math.round(behavior.engagement * 0.45), 45)
  } else {
    // For leads table - use external behavior signals
    // IDX property interactions are no longer a component of this score (wave 18).
    // Property search is a CONTACTS capability by owner ruling; the table that
    // carried this signal is keyed on the pre-conversion id, has no contacts
    // column, and has no writer. Left in place it contributed a permanent ZERO
    // out of a possible 30 — every pre-conversion record silently scored up to
    // 30 points lower for a signal the product does not collect about them,
    // which is worse than not scoring it at all.
    const sellerSignals = record.motivated_seller_signals || []

    // Motivated seller signals
    const strongSignals = sellerSignals.filter((s: any) => s.signal_strength > 0.7).length
    score += Math.min(strongSignals * 15, 30)

    // External behavioural events. Was `event_type ? 1 : 0` — a single boolean over
    // the whole log, so one page view and a thousand showing requests scored the
    // same 10 points. Now weighted by event type and recency.
    score += Math.min(Math.round(behavior.engagement * 0.2), 20)

    // Scraping recency (more recent = more engagement)
    if (record.scraped_at) {
      const daysSinceScrape = Math.floor(
        (Date.now() - new Date(record.scraped_at).getTime()) / (1000 * 60 * 60 * 24)
      )
      if (daysSinceScrape <= 7) score += 20
      else if (daysSinceScrape <= 30) score += 10
    }
  }

  return Math.min(score, 100)
}

/**
 * Calculate recency score (0-100)
 */
function calculateRecencyScore(contact: any): number {
  const lastContact = contact.last_contacted_at || contact.created_at
  const daysSince = Math.floor((Date.now() - new Date(lastContact).getTime()) / (1000 * 60 * 60 * 24))

  if (daysSince <= 1) return 100
  if (daysSince <= 3) return 90
  if (daysSince <= 7) return 75
  if (daysSince <= 14) return 60
  if (daysSince <= 30) return 40
  if (daysSince <= 60) return 20
  return 10
}

/**
 * Calculate intent score (0-100)
 * Works for both contacts and leads tables
 */
function calculateIntentScore(record: any, table: string): number {
  let score = 0

  const intelligence = record.lead_intelligence?.[0]

  // Urgency signals
  if (intelligence?.timeline === "immediate") score += 40
  else if (intelligence?.timeline === "1-3_months") score += 30
  else if (intelligence?.timeline === "3-6_months") score += 20
  else if (intelligence?.timeline === "6-12_months") score += 10

  // Pre-approval status. `preapproval_status` is NOT a column on lead_intelligence —
  // the live table carries a boolean `pre_approved` (plus `pre_approval_amount` and a
  // free-text `financial_readiness`). Both branches below were therefore unreachable,
  // which went unnoticed because the embed above meant `intelligence` was never
  // populated at all. Mapped onto the column that exists; the old "in_process" branch
  // is DELETED rather than guessed at, because no column carries that state — inventing
  // a value for it would be inventing a score.
  if (intelligence?.pre_approved === true) score += 30

  if (table === "contacts") {
    // Budget alignment
    const hasBudget = record.budget_min && record.budget_max
    if (hasBudget) score += 20

    // Viewing requests
    const viewingRequests = record.property_interactions?.filter((i: any) => i.interaction_type === "tour_request")
      .length
    score += Math.min(viewingRequests * 10, 10)
  } else {
    // For leads - use intent type and motivation score
    if (record.intent_type === "buyer") score += 20
    if (record.intent_type === "seller") score += 25
    if (record.motivation_score) score += Math.min(record.motivation_score * 0.2, 20)

    // Property interest signals
    if (record.property_interest && Object.keys(record.property_interest).length > 0) {
      score += 15
    }
  }

  return Math.min(score, 100)
}

/**
 * Calculate fit score (0-100)
 * Works for both contacts and leads tables
 */
function calculateFitScore(record: any, table: string): number {
  let score = 50 // Base score

  if (table === "contacts") {
    // Was `record.buyer_persona?.[0]` — a relation that DOES NOT EXIST (no
    // public.buyer_persona table, no such column on contacts), so this was always
    // undefined even before the embed naming it refused the whole read. The real
    // per-contact persona is client_detailed_personas, fetched in calculateLeadScore.
    const persona = record.client_detailed_personas?.[0]

    // Has complete profile
    if (record.email && record.phone) score += 10
    if (record.budget_min && record.budget_max) score += 10

    // Persona match. The second 15 points hung on `persona.confidence_score > 0.8`;
    // client_detailed_personas has NO confidence_score column (nor did the phantom it
    // was read off). DELETED, not repaired — the same call made for
    // calculateResponsivenessScore below. Persona PRESENCE is the signal the schema
    // actually supports, and it is now reachable for the first time.
    if (persona) score += 15

    // Location preferences.
    //
    // WAS `record.preferred_cities`. `contacts` has NO `preferred_cities` column
    // (its only location columns are city / mailing_city / location_id), so this
    // was permanently undefined and the +10 was UNREACHABLE — the contacts fit
    // score could never exceed 85 of the 100 the scale implies.
    //
    // REPOINTED to lead_intelligence.location_preferences, which is a real column
    // with a real writer: app/actions/lead-intelligence.ts:1341 upserts it as a
    // de-duplicated array of location strings, and app/components/intelligence/
    // LeadIntelligencePanel.tsx reads `.length` off it the same way. It is fetched
    // above by `lead_id` — the pre-conversion id class this file already uses for
    // lead_intelligence and lead_behavioral_data — so no new linkage is invented
    // here. A contact that was never a scraped lead simply has no row, and that
    // absence correctly scores nothing rather than erroring.
    //
    // It is jsonb, so guard the shape before trusting `.length`: a jsonb object or
    // scalar would otherwise read `.length` as undefined and silently score zero.
    const locationPrefs = record.lead_intelligence?.[0]?.location_preferences
    if (Array.isArray(locationPrefs) && locationPrefs.length > 0) score += 10
  } else {
    // For leads - check data completeness
    if (record.email) score += 10
    if (record.phone) score += 10
    if (record.address && record.city && record.state) score += 15

    // Contact persona match
    if (record.contact_persona) score += 15

    // Property ownership signals (seller leads)
    const propertyOwnership = record.lead_property_ownership || []
    if (propertyOwnership.length > 0) {
      score += 10
      // High equity is good fit
      const hasHighEquity = propertyOwnership.some((p: any) => (p.equity_estimate || 0) > 100000)
      if (hasHighEquity) score += 10
    }
  }

  return Math.min(score, 100)
}

// calculateResponsivenessScore was DELETED, not repaired. It read
// behavioral.response_rate and behavioral.avg_response_time_hours off
// lead_behavioral_data; neither column exists, so it returned exactly 50 for every
// lead and contact in the system — base 50, rate 0, and a 48h default that falls
// through every branch. A factor that cannot vary is not a factor. Responsiveness
// now comes from summarizeBehavioralEvents, which counts real reply events and says
// plainly that it is a reply-presence signal rather than a rate (the log carries no
// outbound count, so a true rate is not computable from it).

/**
 * Generate actionable recommendations
 */
function generateLeadRecommendations(contact: any, factors: any): string[] {
  const recommendations: string[] = []

  // Engagement recommendations
  if (factors.engagement < 40) {
    recommendations.push("Send personalized property recommendations to increase engagement")
  }

  // Recency recommendations
  if (factors.recency < 50) {
    recommendations.push("Schedule a follow-up call or send a check-in email")
  }

  // Intent recommendations
  if (factors.intent > 70) {
    recommendations.push("High intent detected - schedule viewing or offer consultation")
  } else if (factors.intent < 30) {
    recommendations.push("Nurture with market updates and educational content")
  }

  // Fit recommendations
  if (factors.fit < 50) {
    recommendations.push("Complete contact profile to improve matching")
  }

  // Responsiveness recommendations
  if (factors.responsiveness < 40) {
    recommendations.push("Try alternative communication channels (text vs email)")
  }

  return recommendations
}

/**
 * Batch recalculate scores for contacts table
 */
export async function bulkRecalculateLeadScores(agentId: string): Promise<{ updated: number; failed: number }> {
  try {
    if (!isValidUUID(agentId)) {
      throw new ValidationError("Invalid agent ID")
    }

    const supabase = await createClient()

    const { data: contacts } = await supabase.from("contacts").select("id").eq("agent_id", agentId).eq("status", "active")

    let updated = 0
    let failed = 0

    for (const contact of contacts || []) {
      const result = await calculateLeadScore({
        id: contact.id,
        agentId,
        recalculate: true,
        table: "contacts",
      })

      if (result.score) {
        updated++
      } else {
        failed++
      }

      // Rate limiting
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    return { updated, failed }
  } catch (error) {
    console.error("[v0] Bulk recalculate error:", error)
    return { updated: 0, failed: 0 }
  }
}

/**
 * Batch recalculate scores for leads table (external scraped leads)
 */
export async function bulkRecalculateScrapedLeadScores(filters?: {
  lead_source?: string
  temperature?: string
  limit?: number
}): Promise<{ updated: number; failed: number }> {
  try {
    const supabase = await createClient()

    let query = supabase.from("leads").select("id, agent_id")

    if (filters?.lead_source) {
      query = query.eq("source", filters.lead_source)
    }
    if (filters?.temperature) {
      query = query.eq("lead_temperature", filters.temperature)
    }
    if (filters?.limit) {
      query = query.limit(filters.limit)
    }

    const { data: leads } = await query

    let updated = 0
    let failed = 0

    for (const lead of leads || []) {
      const result = await calculateLeadScore({
        id: lead.id,
        agentId: lead.agent_id || "system",
        recalculate: true,
        table: "leads",
      })

      if (result.score) {
        updated++
      } else {
        failed++
      }

      // Rate limiting
      await new Promise((resolve) => setTimeout(resolve, 200))
    }

    return { updated, failed }
  } catch (error) {
    console.error("[v0] Bulk recalculate scraped leads error:", error)
    return { updated: 0, failed: 0 }
  }
}

/**
 * Score both contacts AND leads tables for complete coverage
 */
export async function bulkRecalculateAllScores(agentId: string): Promise<{
  contacts: { updated: number; failed: number }
  leads: { updated: number; failed: number }
}> {
  console.log("[v0] Recalculating scores for both contacts and leads tables")

  const contactsResult = await bulkRecalculateLeadScores(agentId)
  const leadsResult = await bulkRecalculateScrapedLeadScores({ limit: 100 })

  return {
    contacts: contactsResult,
    leads: leadsResult,
  }
}

/**
 * Get top leads for an agent
 */
export async function getTopLeads(agentId: string, limit = 20) {
  try {
    if (!isValidUUID(agentId)) {
      return []
    }

    const supabase = await createClient()

    // `buyer_persona(*)` named a relation that DOES NOT EXIST (no public.buyer_persona
    // table, no such column on contacts), and `lead_intelligence` is keyed on lead_id
    // with NO foreign key to contacts. Either one refuses the WHOLE query (PGRST200),
    // so this list has never returned a lead — the catch below turned that into an
    // empty array, i.e. "this agent has no top leads". Nothing downstream read either
    // embed off this result, so both are dropped rather than repointed; the real
    // per-contact persona is client_detailed_personas (contact_id -> contacts.id) and
    // is embeddable if a consumer ever needs it.
    const { data, error } = await supabase
      .from("contacts")
      .select("*")
      .eq("agent_id", agentId)
      .eq("status", "active")
      .order("lead_score", { ascending: false })
      .limit(limit)

    if (error) throw error

    return data || []
  } catch (error) {
    console.error("[v0] Get top leads error:", error)
    return []
  }
}

/**
 * Get leads needing attention (low recency, high intent)
 */
export async function getLeadsNeedingAttention(agentId: string) {
  try {
    if (!isValidUUID(agentId)) {
      return []
    }

    const supabase = await createClient()

    // Get leads that haven't been contacted in 7+ days but have high scores
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()

    const { data, error } = await supabase
      .from("contacts")
      .select("*")
      .eq("agent_id", agentId)
      .eq("status", "active")
      .gte("lead_score", 60)
      .lt("last_contacted_at", sevenDaysAgo)
      .order("lead_score", { ascending: false })
      .limit(10)

    if (error) throw error

    return data || []
  } catch (error) {
    console.error("[v0] Get leads needing attention error:", error)
    return []
  }
}
