/**
 * lib/lead-intelligence/signal-extensions.ts
 *
 * Three new signal types layered on top of the EXISTING lead scoring engine
 * (`scoreLeadWithAI` in app/actions/ai-lead-scoring.ts). The existing
 * scoring writes the canonical `lead_score`, `engagement_score`,
 * `intent_score`, `qualification_score`, `motivation_score`, and
 * `readiness_level` columns; this module produces signal *deltas* that the
 * caller can either:
 *   • merge into the next scoring run (preferred — keeps the AI as the
 *     final arbiter), OR
 *   • apply directly via applySignalDelta() when the AI run isn't due
 *     until tomorrow but the signal is hot today.
 *
 * Hard rules:
 *   • Never overwrite an existing higher score. Deltas only push UP.
 *   • Never replace the underlying scoring logic — these are additive
 *     boosters that get logged to lead_score_history with a `factors`
 *     entry naming the signal source.
 *   • Each signal is idempotent per (contact_id, signal_key, day) so a
 *     re-run of the predictive pipeline doesn't double-credit.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export type SignalSource =
  | "offer_lost"
  | "open_house_attendee"
  | "predictive_seller"

export interface SignalDelta {
  contactId: string
  source: SignalSource
  /** Reason string surfaced in lead_score_history.factors */
  reason: string
  /** Per-bucket boost; positive integers only. */
  boosts: Partial<{
    overall: number
    engagement: number
    intent: number
    motivation: number
    qualification: number
  }>
  /** Optional readiness override — only applied if it lifts the current value. */
  setReadinessAtLeast?: "cold" | "warming" | "hot" | "ready_now"
  /** Source row id for audit trail. */
  evidenceId?: string | null
  /** Optional metadata to attach to the score history row. */
  evidence?: Record<string, unknown>
}

const READINESS_RANK: Record<string, number> = {
  cold: 0,
  warming: 1,
  warm: 1,
  hot: 2,
  ready_now: 3,
  ready: 3,
}

// ─── Signal builders ────────────────────────────────────────────────────────

/**
 * Buyer just submitted an offer that LOST. They're highly motivated, fully
 * pre-approved, and almost certainly going to buy soon — the existing
 * scoring engine doesn't capture this transition (the contact looks the
 * same on paper) so we boost it explicitly.
 */
export function buildOfferLostSignal(input: {
  contactId: string
  offerId: string
  offerAmount: number
  losingMargin?: number
}): SignalDelta {
  return {
    contactId: input.contactId,
    source: "offer_lost",
    reason: `Lost offer (${input.offerAmount ? `$${input.offerAmount.toLocaleString()}` : "amount unknown"}) — buyer remains in market, likely to re-submit within 14 days.`,
    boosts: { overall: 12, intent: 18, motivation: 15, qualification: 8 },
    setReadinessAtLeast: "hot",
    evidenceId: input.offerId,
    evidence: { losingMargin: input.losingMargin ?? null },
  }
}

/**
 * Open-house attendee who left actual contact info. Even a single
 * open-house visit is a strong intent signal that's often missed because
 * scraped/raw leads don't go through the regular AI scoring pass quickly
 * enough.
 */
export function buildOpenHouseAttendeeSignal(input: {
  contactId: string
  attendeeId: string
  listingId: string
  interestLevel?: 1 | 2 | 3 | 4 | 5
}): SignalDelta {
  const interest = input.interestLevel ?? 3
  return {
    contactId: input.contactId,
    source: "open_house_attendee",
    reason: `Open-house attendee (interest ${interest}/5).`,
    boosts: {
      overall: 4 + interest,
      engagement: 6 + interest * 2,
      intent: 4 + interest,
    },
    setReadinessAtLeast: interest >= 4 ? "hot" : interest >= 3 ? "warming" : undefined,
    evidenceId: input.attendeeId,
    evidence: { listingId: input.listingId, interestLevel: interest },
  }
}

/**
 * Predictive-seller signal coming OUT of the existing lead-scraping
 * pipeline (life events: divorce filing, equity threshold passed,
 * neighbour listing sold high, vacancy, expired listing, FSBO listing
 * pulled, etc.). The pipeline already surfaces these; this builder is the
 * normalised entry point so any pipeline contributor can write a single
 * delta and not have to know the scoring schema.
 */
export function buildPredictiveSellerSignal(input: {
  contactId: string
  signalKey: string  // e.g. "neighbor_sold_high", "equity_75pct", "expired_listing"
  signalLabel: string
  confidence: number // 0..1
  evidenceId?: string | null
  evidence?: Record<string, unknown>
}): SignalDelta {
  const c = Math.max(0, Math.min(1, input.confidence))
  return {
    contactId: input.contactId,
    source: "predictive_seller",
    reason: `Predictive seller signal: ${input.signalLabel} (confidence ${(c * 100).toFixed(0)}%).`,
    boosts: {
      overall: Math.round(8 * c) + 2,
      motivation: Math.round(15 * c) + 3,
      intent: Math.round(10 * c) + 2,
    },
    setReadinessAtLeast: c >= 0.75 ? "hot" : c >= 0.5 ? "warming" : undefined,
    evidenceId: input.evidenceId ?? null,
    evidence: { signalKey: input.signalKey, confidence: c, ...input.evidence },
  }
}

// ─── Application ────────────────────────────────────────────────────────────

/**
 * Apply a signal delta directly. Idempotent per (contactId, source,
 * evidenceId, day). Only pushes scores UP, never overwrites a higher
 * existing value.
 *
 * Schema notes (verified against live DB on 2026-05-05):
 *   • contacts                — has engagement_score + intent_score ONLY
 *     (no lead_score / motivation_score / qualification_score / readiness_level)
 *   • lead_score_history      — carries the FULL score set
 *     (overall_score / engagement_score / intent_score / motivation_score /
 *      qualification_score / factors / ai_recommendations / scored_at)
 *
 * So: writes the full delta to lead_score_history (the audit log source of
 * truth) and only updates the two columns that exist on contacts. This
 * preserves the existing AI scoring model — we never overwrite higher
 * values, never invent contact columns.
 */
export async function applySignalDelta(delta: SignalDelta): Promise<{ applied: boolean; reason?: string }> {
  const supabase = createServiceClient()
  const today = new Date().toISOString().slice(0, 10)
  const idempotencyKey = `${delta.source}:${delta.evidenceId ?? "noevidence"}:${today}`

  // Idempotency: did we already log this exact signal today?
  const { data: existing } = await supabase
    .from("lead_score_history")
    .select("id")
    .eq("contact_id", delta.contactId)
    .gte("scored_at", `${today}T00:00:00.000Z`)
    .contains("factors", { idempotency_key: idempotencyKey })
    .maybeSingle()
  if (existing) return { applied: false, reason: "already_applied_today" }

  // Read the previous full scoring snapshot from history (it carries every
  // bucket); fall back to whatever's on contacts when there's no history.
  const [{ data: contact }, { data: lastHistory }] = await Promise.all([
    supabase
      .from("contacts")
      .select("engagement_score, intent_score")
      .eq("id", delta.contactId)
      .maybeSingle(),
    supabase
      .from("lead_score_history")
      .select(
        "overall_score, engagement_score, intent_score, motivation_score, qualification_score",
      )
      .eq("contact_id", delta.contactId)
      .order("scored_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])
  if (!contact) return { applied: false, reason: "contact_not_found" }

  const prev = {
    overall: Number(lastHistory?.overall_score ?? 0),
    engagement: Number(lastHistory?.engagement_score ?? contact.engagement_score ?? 0),
    intent: Number(lastHistory?.intent_score ?? contact.intent_score ?? 0),
    motivation: Number(lastHistory?.motivation_score ?? 0),
    qualification: Number(lastHistory?.qualification_score ?? 0),
  }

  const next = {
    overall: Math.min(100, Math.max(prev.overall, prev.overall + (delta.boosts.overall ?? 0))),
    engagement: Math.min(100, Math.max(prev.engagement, prev.engagement + (delta.boosts.engagement ?? 0))),
    intent: Math.min(100, Math.max(prev.intent, prev.intent + (delta.boosts.intent ?? 0))),
    motivation: Math.min(100, Math.max(prev.motivation, prev.motivation + (delta.boosts.motivation ?? 0))),
    qualification: Math.min(100, Math.max(prev.qualification, prev.qualification + (delta.boosts.qualification ?? 0))),
  }

  // contacts has only the two scalar score columns. Update them — and only
  // them — so we don't overwrite higher existing values.
  const contactUpdate: Record<string, unknown> = {}
  if (next.engagement > Number(contact.engagement_score ?? 0)) {
    contactUpdate.engagement_score = next.engagement
  }
  if (next.intent > Number(contact.intent_score ?? 0)) {
    contactUpdate.intent_score = next.intent
  }
  if (Object.keys(contactUpdate).length) {
    await supabase.from("contacts").update(contactUpdate).eq("id", delta.contactId)
  }

  // Write the full audit snapshot. Readiness lives in factors only (no
  // column on contacts) — a later reader can derive it from overall_score.
  const nextReadiness = delta.setReadinessAtLeast
  const proposedReadinessRank = nextReadiness ? READINESS_RANK[nextReadiness] ?? 0 : -1

  await supabase.from("lead_score_history").insert({
    contact_id: delta.contactId,
    overall_score: next.overall,
    engagement_score: next.engagement,
    intent_score: next.intent,
    motivation_score: next.motivation,
    qualification_score: next.qualification,
    factors: {
      source: delta.source,
      reason: delta.reason,
      idempotency_key: idempotencyKey,
      evidence: delta.evidence ?? null,
      evidence_id: delta.evidenceId ?? null,
      delta_boosts: delta.boosts,
      readiness_signal: nextReadiness ?? null,
      readiness_rank: proposedReadinessRank >= 0 ? proposedReadinessRank : null,
    },
    ai_recommendations: null,
    scored_at: new Date().toISOString(),
  })

  return { applied: true }
}
