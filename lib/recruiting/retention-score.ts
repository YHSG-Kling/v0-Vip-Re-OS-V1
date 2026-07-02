// lib/recruiting/retention-score.ts
//
// AGENT RETENTION SCORE — the defensive mirror of the switch-propensity scout. Where that scores which
// EXTERNAL agents to recruit, this scores YOUR OWN agents' flight risk so a slipping agent gets a save
// play BEFORE they walk. Built from REAL engagement signals the live app already has — no fabricated
// telemetry: activity recency (assistant/platform use), production drought (days since last closing),
// active pipeline, and onboarding ramp. HONEST: a signal with no data is neutral (0.5), not counted as
// a failure, and the weights renormalize over the signals we actually have. Pure + unit-tested.

export interface RetentionSignals {
  /** Days since the agent's last platform/assistant activity (null = unknown → neutral). */
  daysSinceActivity: number | null
  /** Days since the agent's last CLOSED deal (null = never closed / unknown). */
  daysSinceClosing: number | null
  /** Count of the agent's ACTIVE in-flight transactions. */
  activePipeline: number | null
  /** Onboarding completion 0..100 (null = not onboarding / unknown → neutral). */
  onboardingPct: number | null
  /** Days since the agent joined (young agents in a production drought aren't as alarming). */
  tenureDays: number | null
}

export type RetentionTier = "engaged" | "healthy" | "watch" | "at_risk" | "critical"

export interface RetentionScore {
  /** 0 (about to leave) .. 100 (fully engaged). */
  score: number
  tier: RetentionTier
  /** The lowest sub-scores dragging the agent down (human-readable). */
  drivingSignals: string[]
  /** Per-signal sub-scores (0..1) for the score row's breakdown. */
  breakdown: Record<string, number>
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n))

/** Recency → 0..1 (fresh = 1). null → neutral 0.5 (unknown, not a failure). */
function recencyScore(days: number | null, fullByDays: number): number | null {
  if (days == null || !Number.isFinite(days)) return null
  if (days <= 0) return 1
  return clamp01(1 - days / fullByDays)
}

/**
 * PURE: composite retention score from the signals we can honestly source. Each present signal is a
 * 0..1 sub-score; absent signals are dropped and the remaining weights renormalize (so an agent isn't
 * punished for data we don't have). Production drought is softened for brand-new agents (tenure < 60d),
 * who haven't had time to close.
 */
export function computeRetentionScore(sig: RetentionSignals): RetentionScore {
  const parts: Array<{ key: string; label: string; weight: number; sub: number | null }> = []

  // 1. Activity recency — the strongest engagement signal (haven't logged in ⇒ checked out).
  parts.push({ key: "activity", label: "Low platform activity", weight: 0.32, sub: recencyScore(sig.daysSinceActivity, 21) })

  // 2. Production drought — days since last closing; softened for very new agents.
  let droughtSub = recencyScore(sig.daysSinceClosing, 180)
  const isNew = sig.tenureDays != null && sig.tenureDays < 60
  if (droughtSub != null && isNew) droughtSub = clamp01(droughtSub * 0.4 + 0.6) // new agents: floor the penalty
  parts.push({ key: "production", label: "In a production drought", weight: 0.28, sub: droughtSub })

  // 3. Active pipeline — has something in flight (0 = concerning).
  const pipeSub = sig.activePipeline == null ? null : clamp01(Math.min(1, sig.activePipeline / 2))
  parts.push({ key: "pipeline", label: "Empty pipeline", weight: 0.25, sub: pipeSub })

  // 4. Onboarding ramp — a stalled ramp is an early flight signal.
  const rampSub = sig.onboardingPct == null ? null : clamp01(sig.onboardingPct / 100)
  parts.push({ key: "onboarding", label: "Stalled onboarding", weight: 0.15, sub: rampSub })

  const present = parts.filter((p) => p.sub != null)
  const totalWeight = present.reduce((s, p) => s + p.weight, 0) || 1
  const composite = present.reduce((s, p) => s + p.weight * (p.sub as number), 0) / totalWeight
  const score = Math.round(clamp01(composite) * 100)

  const breakdown: Record<string, number> = {}
  for (const p of parts) if (p.sub != null) breakdown[p.key] = Math.round((p.sub as number) * 100) / 100

  // Driving signals = the lowest present sub-scores (only genuinely weak ones, < 0.5).
  const drivingSignals = present
    .filter((p) => (p.sub as number) < 0.5)
    .sort((a, b) => (a.sub as number) - (b.sub as number))
    .slice(0, 3)
    .map((p) => p.label)

  return { score, tier: scoreTier(score), drivingSignals, breakdown }
}

/** PURE: bucket a score into a retention tier. */
export function scoreTier(score: number): RetentionTier {
  if (score >= 80) return "engaged"
  if (score >= 60) return "healthy"
  if (score >= 40) return "watch"
  if (score >= 20) return "at_risk"
  return "critical"
}

/** PURE: is this an at-risk agent worth a broker save play? (watch tier and below.) */
export const AT_RISK_THRESHOLD = 40
export function isAtRisk(score: number): boolean {
  return score < AT_RISK_THRESHOLD
}

/** PURE: trend from the previous day's score. */
export function scoreTrendOf(current: number, previous: number | null): "improving" | "stable" | "declining" {
  if (previous == null) return "stable"
  if (current > previous + 2) return "improving"
  if (current < previous - 2) return "declining"
  return "stable"
}
