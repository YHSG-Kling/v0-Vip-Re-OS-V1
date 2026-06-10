// lib/ai-isa/transaction-propensity.ts
//
// SIGNAL FUSION — the AI ISA's edge. The spine already enriches every contact with
// independent signals (intent_score, engagement_score, equity_estimate, life events,
// referral_score, activity recency). Individually they're noisy; FUSED into one
// transparent, weighted "likely to transact in the next 90 days" score they tell the
// ISA WHO to re-engage first. No black box — the weights are explicit and every score
// carries its top contributing reasons, so a human can trust (and audit) the ranking.
//
// Owned by AI ISA (lead qualification / nurture / re-engagement). Pure scorer is
// unit-tested; the ranker is live-probed.

export interface PropensitySignals {
  /** 0-100 buying/selling intent (scraped + conversational). */
  intentScore: number | null
  /** 0-100 recent engagement (opens, portal visits, replies). */
  engagementScore: number | null
  /** Estimated home equity ($) — higher equity → more able/likely to move. */
  equityEstimate: number | null
  /** Days since a life event was detected (move, marriage, job change…); null = none. */
  lifeEventDaysAgo: number | null
  /** 0-100 referral propensity (warm network signal). */
  referralScore: number | null
  /** Days since last meaningful activity; null = never / unknown. */
  lastActivityDaysAgo: number | null
}

export type PropensityBand = "hot" | "warm" | "cool" | "cold"

export interface PropensityResult {
  /** 0-100 fused score. */
  score: number
  band: PropensityBand
  /** The 1-3 signals that contributed most, broker-readable. */
  topReasons: string[]
}

// Transparent weights (sum = 1.0). Tuned for "transact in 90 days": intent leads, then
// engagement + a recent life event (the classic move trigger), equity, recency, referral.
const WEIGHTS = {
  intent:     0.30,
  engagement: 0.20,
  lifeEvent:  0.20,
  equity:     0.12,
  recency:    0.13,
  referral:   0.05,
} as const

/** Equity contribution saturates — $500k+ of equity reads as "fully mobile". */
function equityComponent(equity: number | null): number {
  if (equity == null || equity <= 0) return 0
  return Math.min(100, (equity / 500_000) * 100)
}

/** A life event decays over 180 days — fresh trigger = 100, 6 months old ≈ 0. */
function lifeEventComponent(daysAgo: number | null): number {
  if (daysAgo == null || daysAgo < 0) return 0
  return Math.max(0, 100 - (daysAgo / 180) * 100)
}

/** Activity recency: active in the last week = 100, decays to 0 over 120 days. */
function recencyComponent(daysAgo: number | null): number {
  if (daysAgo == null) return 0
  if (daysAgo <= 7) return 100
  return Math.max(0, 100 - ((daysAgo - 7) / 120) * 100)
}

function bandFor(score: number): PropensityBand {
  if (score >= 75) return "hot"
  if (score >= 50) return "warm"
  if (score >= 25) return "cool"
  return "cold"
}

/** Pure: fuse the signals into a 0-100 propensity score + band + top reasons. */
export function computeTransactionPropensity(s: PropensitySignals): PropensityResult {
  const components: Array<{ key: string; label: string; value: number; weight: number }> = [
    { key: "intent",     label: "high buying/selling intent",   value: Math.max(0, Math.min(100, s.intentScore ?? 0)),     weight: WEIGHTS.intent },
    { key: "engagement", label: "active engagement",            value: Math.max(0, Math.min(100, s.engagementScore ?? 0)), weight: WEIGHTS.engagement },
    { key: "lifeEvent",  label: "recent life event",            value: lifeEventComponent(s.lifeEventDaysAgo),             weight: WEIGHTS.lifeEvent },
    { key: "equity",     label: "strong home equity",           value: equityComponent(s.equityEstimate),                 weight: WEIGHTS.equity },
    { key: "recency",    label: "recent activity",              value: recencyComponent(s.lastActivityDaysAgo),           weight: WEIGHTS.recency },
    { key: "referral",   label: "warm referral signal",         value: Math.max(0, Math.min(100, s.referralScore ?? 0)),  weight: WEIGHTS.referral },
  ]

  const score = Math.round(components.reduce((acc, c) => acc + c.value * c.weight, 0))
  // Top reasons = the components contributing the most weighted points, that actually fired.
  const topReasons = [...components]
    .filter((c) => c.value > 0)
    .sort((a, b) => b.value * b.weight - a.value * a.weight)
    .slice(0, 3)
    .map((c) => c.label)

  return { score, band: bandFor(score), topReasons }
}

export interface RankedContact {
  contactId: string
  name: string
  result: PropensityResult
}

/**
 * Rank a brokerage's contacts by fused transaction propensity (highest first). Reads the
 * enriched signal columns + activity recency; computes the transparent fused score. Returns
 * the top `limit` so the AI ISA knows who to re-engage first.
 */
export async function rankContactsByPropensity(
  params: { brokerageId: string; limit?: number; minScore?: number },
  client?: ReturnType<typeof import("@/lib/supabase/service").createServiceClient>,
): Promise<RankedContact[]> {
  const { createServiceClient } = await import("@/lib/supabase/service")
  const supabase = client ?? createServiceClient()
  const limit = params.limit ?? 50
  const minScore = params.minScore ?? 0

  const { data } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, intent_score, engagement_score, equity_estimate, referral_score, last_life_event_detected, updated_at")
    .eq("brokerage_id", params.brokerageId)
    .limit(4000)

  const now = Date.now()
  const daysSince = (iso: string | null | undefined): number | null =>
    iso ? Math.floor((now - new Date(iso).getTime()) / 86_400_000) : null

  const ranked = ((data ?? []) as Array<{
    id: string; first_name: string | null; last_name: string | null
    intent_score: number | null; engagement_score: number | null; equity_estimate: number | null
    referral_score: number | null; last_life_event_detected: string | null
    updated_at: string | null
  }>).map((c) => {
    const result = computeTransactionPropensity({
      intentScore: c.intent_score,
      engagementScore: c.engagement_score,
      equityEstimate: c.equity_estimate,
      lifeEventDaysAgo: daysSince(c.last_life_event_detected),
      referralScore: c.referral_score,
      lastActivityDaysAgo: daysSince(c.updated_at),
    })
    return { contactId: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(" ").trim() || "Contact", result }
  })
    .filter((r) => r.result.score >= minScore)
    .sort((a, b) => b.result.score - a.result.score)
    .slice(0, limit)

  return ranked
}
