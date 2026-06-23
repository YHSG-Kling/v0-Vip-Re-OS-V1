// lib/managers/eval-scoring.ts
// PURE scoring for the Manager Trust Scorecard — the differentiator surface that
// turns the egress/governance story into a *certifiable* one: every AI manager is
// continuously graded by Anthropic Managed Agents' rubric grader (results land in
// agent_outcome_evaluations), and this computes each manager's trust tier + a
// recommended autonomy posture (auto-act vs. require human approval).
//
// No DB, no I/O — the action and the simulator both grade through these functions
// so the trust tier the broker sees == the one we'd gate autonomy on.

/** Live CHECK on agent_outcome_evaluations.result. */
export const EVAL_RESULTS = ["satisfied", "needs_revision", "max_iterations_reached", "failed", "interrupted"] as const
export type EvalResult = (typeof EVAL_RESULTS)[number]

/** The rubric grader's "this output met the bar" verdict. */
export const PASS_RESULT: EvalResult = "satisfied"
export function isPassResult(r: string): boolean { return r === PASS_RESULT }

export type TrustTier = "trusted" | "monitored" | "probation" | "insufficient_data"
export type AutonomyPosture = "autonomous" | "review_recommended" | "approval_required"

export const AUTONOMY_POSTURES: readonly AutonomyPosture[] = ["autonomous", "review_recommended", "approval_required"]
export function isAutonomyPosture(x: unknown): x is AutonomyPosture {
  return typeof x === "string" && (AUTONOMY_POSTURES as readonly string[]).includes(x)
}

/**
 * The EFFECTIVE posture a manager operates under: a broker's explicit override
 * (governance policy of record, stored on managed_agents.config) always wins over
 * the eval-derived recommendation. This is what the dispatch autonomy gate enforces.
 */
export function effectiveAutonomy(recommended: AutonomyPosture, override?: AutonomyPosture | null): AutonomyPosture {
  return isAutonomyPosture(override) ? override : recommended
}

/** Below this many graded outcomes we don't claim a trust tier (small-sample guard). */
export const MIN_EVALS_FOR_TIER = 5

export interface ManagerEvalScore {
  total: number
  satisfied: number
  /** integer 0–100 */
  passRate: number
  /** count by raw result, for transparency */
  byResult: Record<string, number>
  tier: TrustTier
  autonomy: AutonomyPosture
}

export function tierFor(passRate: number, total: number): TrustTier {
  if (total < MIN_EVALS_FOR_TIER) return "insufficient_data"
  if (passRate >= 90) return "trusted"
  if (passRate >= 70) return "monitored"
  return "probation"
}

/**
 * Recommended autonomy posture per tier. Conservative by construction: anything
 * short of a proven track record requires a human in the loop. The Command Center
 * surfaces this, and it is now ENFORCED at the egress: lib/managers/autonomy-gate.ts
 * resolves this posture (persisted to managed_agents.config.autonomy_recommended; a
 * broker override on .autonomy_tier wins) and dispatch.ts HOLDS an autonomous send
 * from a manager on `approval_required`.
 */
export function autonomyFor(tier: TrustTier): AutonomyPosture {
  switch (tier) {
    case "trusted": return "autonomous"
    case "monitored": return "review_recommended"
    case "probation": return "approval_required"
    case "insufficient_data": return "approval_required"
  }
}

export function scoreEvals(evals: Array<{ result: string }>): ManagerEvalScore {
  const total = evals.length
  const byResult: Record<string, number> = {}
  let satisfied = 0
  for (const e of evals) {
    byResult[e.result] = (byResult[e.result] ?? 0) + 1
    if (isPassResult(e.result)) satisfied += 1
  }
  const passRate = total === 0 ? 0 : Math.round((satisfied / total) * 100)
  const tier = tierFor(passRate, total)
  return { total, satisfied, passRate, byResult, tier, autonomy: autonomyFor(tier) }
}

/** Team-level rollup across managers (weights by graded-outcome volume). */
export function teamTrust(scores: ManagerEvalScore[]): { passRate: number; total: number; trustedCount: number } {
  const total = scores.reduce((s, m) => s + m.total, 0)
  const satisfied = scores.reduce((s, m) => s + m.satisfied, 0)
  return {
    total,
    passRate: total === 0 ? 0 : Math.round((satisfied / total) * 100),
    trustedCount: scores.filter((m) => m.tier === "trusted").length,
  }
}
