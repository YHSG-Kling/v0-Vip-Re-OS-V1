// lib/lead-pipeline/variant-winner.ts
//
// VARIANT WINNER selection (pure) — the "reply-rate picks the winner" brain for the self-improving
// copy loop. When the source diagnostic flags a WORDING issue, a second ai_intent variant is run on
// the reactivation step; this decides — once there's enough data — which intent phrasing actually
// earns replies, so the team's copy improves per segment. Sample-size + margin gated (mirrors the
// existing video format-learning pattern) so the winner never flips on noise.
//
// Pure (no I/O), unit-tested directly. Returns null = "keep testing / keep current" — the safe
// default until a variant CLEARLY wins.

export interface VariantStat {
  variant: string
  sent: number
  replies: number
}

export interface VariantWinner {
  winner: string | null
  reason: string
  /** reply rate of the chosen winner (0–1), for logging. */
  winnerRate?: number
}

export const DEFAULT_MIN_SAMPLE = 30
/** Relative margin the leader must beat the runner-up by (0.2 = 20% better reply rate). */
export const DEFAULT_MARGIN = 0.2

/** Pick the winning copy variant by reply rate, gated on sample size + a clear margin. Pure. */
export function pickWinningVariant(
  variants: VariantStat[],
  opts?: { minSample?: number; margin?: number },
): VariantWinner {
  const minSample = opts?.minSample ?? DEFAULT_MIN_SAMPLE
  const margin = opts?.margin ?? DEFAULT_MARGIN

  const eligible = (variants ?? [])
    .filter((v) => v.sent >= minSample)
    .map((v) => ({ variant: v.variant, rate: v.sent > 0 ? v.replies / v.sent : 0 }))
    .sort((a, b) => b.rate - a.rate)

  if (eligible.length < 2) {
    return { winner: null, reason: `need ≥2 variants with ≥${minSample} sends each — only ${eligible.length} qualify; keep testing` }
  }
  const [lead, runnerUp] = eligible
  if (lead.rate <= 0) {
    return { winner: null, reason: "no variant has earned a reply yet — keep testing" }
  }
  // Relative margin: the leader's rate must exceed the runner-up's by at least `margin`.
  if (lead.rate < runnerUp.rate * (1 + margin)) {
    return { winner: null, reason: `leader (${(lead.rate * 100).toFixed(1)}%) not clearly ahead of runner-up (${(runnerUp.rate * 100).toFixed(1)}%) by ${(margin * 100).toFixed(0)}% — too close, keep testing` }
  }
  return { winner: lead.variant, winnerRate: lead.rate, reason: `variant '${lead.variant}' wins at ${(lead.rate * 100).toFixed(1)}% reply vs ${(runnerUp.rate * 100).toFixed(1)}% — promote it` }
}
