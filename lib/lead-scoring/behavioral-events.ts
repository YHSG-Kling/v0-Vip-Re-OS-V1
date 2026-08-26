// lib/lead-scoring/behavioral-events.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE BEHAVIOURAL LAYER READ COLUMNS THAT DO NOT EXIST.
//
// lead_behavioral_data is an EVENT LOG. Live schema, verified:
//
//   id · lead_id · event_type · event_data(jsonb) · page_url · referrer
//   device_type · session_id · ip_address · user_agent · occurred_at
//   created_at · brokerage_id
//
// There is no email_open_count, no site_visit_count, no response_rate, no
// avg_response_time_hours. The canonical scorer's behavioural refinement — 30% of
// every lead's final score — read all four of them off `record.lead_behavioral_data[0]`
// as though the log were a single pre-aggregated row. Every one resolved to
// undefined, so:
//
//   engagement          45 of its 100 points were structurally unreachable
//   responsiveness      pinned at exactly 50 for every lead and contact, forever
//                       (base 50, response_rate 0, avg_response_time defaulted to
//                       48h which falls through every branch) — a factor with zero
//                       discriminating power, weighted at 10% of the refinement
//
// Worse on the contacts side: the contacts branch never LOADED the log at all (only
// the leads branch fetched it), while a comment claimed it was "fetched separately".
// And the leads branch collapsed the whole log to `event_type ? 1 : 0` — one page
// view and a thousand showing requests scored identically.
//
// The irony is that a THIRD scorer, in app/actions/ai-auto-response.ts and marked
// deprecated, was the only implementation that read the table correctly: per
// event_type weights, real occurred_at recency, event_data.points_awarded as a
// fallback. Its weights are ported here verbatim, because they are the asset — what
// made it unusable was where it wrote (lead_scores, which no authoritative path
// touches) and a `floor(points / 10)` normalisation that put a "hot" score of 70 at
// 700 raw points: roughly 24 CMA requests or 28 showing requests from one person.
// Unreachable in practice, so the hot-leads surface reading it was empty by
// arithmetic.
//
// PURE — no I/O — so every branch is unit-tested without a database.

// Type-only import: erased at compile time, so this module stays pure and adds
// nothing to the runtime graph.
import type { LeadTemperature } from "@/lib/constants"

/** One row of the event log. Only the fields that actually exist. */
export interface BehavioralEvent {
  event_type: string
  event_data?: Record<string, unknown> | null
  occurred_at?: string | null
}

/**
 * Per-event-type weights, ported verbatim from the deprecated scorer. These are a
 * real judgement about buying intent (a showing request is worth five website
 * visits) and were the only place in the codebase that expressed it.
 */
export const EVENT_POINTS: Readonly<Record<string, number>> = {
  website_visit: 5,
  email_open: 3,
  email_click: 10,
  form_submit: 15,
  property_view: 8,
  property_save: 12,
  showing_request: 25,
  call_answered: 20,
  sms_reply: 10,
  cma_request: 30,
  document_download: 15,
}

/** Actions that mean "this person is transacting", not merely browsing. */
export const HIGH_INTENT_EVENTS: ReadonlySet<string> = new Set([
  "showing_request",
  "cma_request",
  "document_download",
])

/** Events that are the CONTACT replying to us — a responsiveness signal. */
export const REPLY_EVENTS: ReadonlySet<string> = new Set([
  "sms_reply",
  "call_answered",
  "email_click",
  "form_submit",
])

export const RECENT_WINDOW_DAYS = 30
export const HOT_WINDOW_DAYS = 7

/**
 * SATURATION POINTS — where a sub-score reaches 100.
 *
 * The deprecated scorer's `floor(total / 10)` is what made its output useless, so
 * these are stated as explicit, reviewable thresholds instead of an arbitrary
 * divisor. Engagement saturates at 120 points inside 30 days (≈ 5 showing requests,
 * or 4 CMA requests, or 15 property views); recency at 60 points inside 7 days
 * (≈ 2 showing requests this week). Both are reachable by a genuinely active
 * person, which is the whole point of a score.
 */
export const ENGAGEMENT_SATURATION = 120
export const RECENCY_SATURATION = 60

/** Points for one event: its weight, else an explicit points_awarded, else zero. */
export function pointsForEvent(event: BehavioralEvent): number {
  const weighted = EVENT_POINTS[event.event_type]
  if (typeof weighted === "number") return weighted
  const awarded = event.event_data?.points_awarded
  return typeof awarded === "number" && Number.isFinite(awarded) ? awarded : 0
}

export interface BehavioralSummary {
  /** Events considered (unparseable timestamps still count toward totals). */
  eventCount: number
  /** Raw weighted points across the whole log — diagnostic, never a score. */
  totalPoints: number
  /** 0-100. Weighted points inside RECENT_WINDOW_DAYS against saturation. */
  engagement: number
  /** 0-100. Weighted points inside HOT_WINDOW_DAYS against saturation. */
  recency: number
  /** 0-100. High-intent action count × 20 (ported), capped. */
  intent: number
  /**
   * 0-100, 50 = neutral/unknown.
   *
   * Deliberately a reply-PRESENCE signal, not a reply RATE: a true rate needs the
   * outbound count, which this log does not carry. The previous implementation
   * invented a `response_rate` column to get a rate and silently got 0 — a
   * constant is worse than an honest partial signal.
   */
  responsiveness: number
  /** Event count per type — feeds the explanation, not the score. */
  byType: Record<string, number>
}

const EMPTY: BehavioralSummary = {
  eventCount: 0,
  totalPoints: 0,
  engagement: 0,
  recency: 0,
  intent: 0,
  responsiveness: 50,
  byType: {},
}

/**
 * Fold an event log into 0-100 behavioural factors. Never throws: an unparseable
 * occurred_at counts toward totals but earns no recency credit, because guessing a
 * timestamp would invent engagement that never happened.
 */
export function summarizeBehavioralEvents(
  events: readonly BehavioralEvent[] | null | undefined,
  now: Date = new Date(),
): BehavioralSummary {
  if (!events?.length) return { ...EMPTY, byType: {} }

  const nowMs = now.getTime()
  const recentCutoff = nowMs - RECENT_WINDOW_DAYS * 86_400_000
  const hotCutoff = nowMs - HOT_WINDOW_DAYS * 86_400_000

  let totalPoints = 0
  let recentPoints = 0
  let hotPoints = 0
  let highIntent = 0
  let replies = 0
  const byType: Record<string, number> = {}

  for (const e of events) {
    if (!e?.event_type) continue
    const points = pointsForEvent(e)
    totalPoints += points
    byType[e.event_type] = (byType[e.event_type] ?? 0) + 1
    if (HIGH_INTENT_EVENTS.has(e.event_type)) highIntent++
    if (REPLY_EVENTS.has(e.event_type)) replies++

    const at = e.occurred_at ? Date.parse(e.occurred_at) : NaN
    if (Number.isNaN(at)) continue
    if (at >= recentCutoff) recentPoints += points
    if (at >= hotCutoff) hotPoints += points
  }

  const pct = (points: number, saturation: number) =>
    Math.max(0, Math.min(100, Math.round((points / saturation) * 100)))

  return {
    eventCount: events.length,
    totalPoints,
    engagement: pct(recentPoints, ENGAGEMENT_SATURATION),
    recency: pct(hotPoints, RECENCY_SATURATION),
    // Ported multiplier from the deprecated scorer.
    intent: Math.min(100, highIntent * 20),
    responsiveness: replies === 0 ? 50 : Math.min(100, 50 + replies * 15),
    byType,
  }
}

/** Priority tier, ported from the deprecated scorer so the hot/warm/cold language
 *  the UI already uses keeps its meaning — now over an authoritative score.
 *
 *  WIRED 2026-08-26 (orphan burn-down, lane BC, §1.2): the return type was
 *  hand-spelled `"hot" | "warm" | "cold"` here, and in twelve other places, while
 *  the declared 3-band vocabulary — LEAD_TEMPERATURES / LeadTemperature at
 *  lib/constants/index.ts:124 — sat exported with no importer at all. That is
 *  the §6 defect from the writer's side: the canon existed and every reader
 *  re-typed it, so the canon could never bind anything. The scorer now names it.
 *  LEAD_TEMPERATURES mirrors the lead_temperature CHECK on contacts / leads /
 *  communication_audit_log (hot/warm/cold — "cool" belongs to the 4-band
 *  urgency_level scale and would be refused), so this tier can no longer drift
 *  out of what the column accepts. The remaining inline spellings are UI props
 *  owned by other lanes and are reported, not touched. */
export function priorityTier(score: number, intent: number, engagement: number): LeadTemperature {
  if (score >= 70 || intent >= 60) return "hot"
  if (score >= 40 || engagement >= 50) return "warm"
  return "cold"
}
