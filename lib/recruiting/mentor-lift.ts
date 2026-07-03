// lib/recruiting/mentor-lift.ts
//
// MENTOR PRODUCTION-LIFT (recruiting_manager) — proves mentorship WORKS by comparing mentored vs
// unmentored newer agents' production + retention. The broker KPI: "Mentored agents average X% more
// transactions and Y% higher retention." Pure + honest: with too small a cohort on either side there's no
// verdict (thin data is never a fabricated lift).

/** Below this many agents in a cohort, the comparison is not meaningful. */
export const MIN_COHORT = 3

export interface CohortStats {
  count: number
  avgTransactions: number
  avgRetention: number
}

export interface MentorLift {
  mentored: CohortStats
  unmentored: CohortStats
  /** % more transactions the mentored cohort averages (null when either cohort is too thin). */
  liftTransactionsPct: number | null
  /** Percentage-point higher retention the mentored cohort averages (null when thin). */
  liftRetentionPts: number | null
  hasVerdict: boolean
}

const avg = (nums: number[]): number => (nums.length ? Math.round((nums.reduce((a, b) => a + b, 0) / nums.length) * 100) / 100 : 0)

/**
 * PURE: cohort comparison. Inputs are per-agent {transactions, retention} for each cohort. Honest: needs
 * MIN_COHORT on BOTH sides for a verdict; otherwise lifts are null and hasVerdict is false.
 */
export function computeMentorLift(
  mentored: Array<{ transactions: number; retention: number }>,
  unmentored: Array<{ transactions: number; retention: number }>,
): MentorLift {
  const mStats: CohortStats = { count: mentored.length, avgTransactions: avg(mentored.map((a) => a.transactions)), avgRetention: avg(mentored.map((a) => a.retention)) }
  const uStats: CohortStats = { count: unmentored.length, avgTransactions: avg(unmentored.map((a) => a.transactions)), avgRetention: avg(unmentored.map((a) => a.retention)) }
  const hasVerdict = mStats.count >= MIN_COHORT && uStats.count >= MIN_COHORT
  const liftTransactionsPct = hasVerdict && uStats.avgTransactions > 0
    ? Math.round(((mStats.avgTransactions - uStats.avgTransactions) / uStats.avgTransactions) * 100)
    : null
  const liftRetentionPts = hasVerdict ? Math.round(mStats.avgRetention - uStats.avgRetention) : null
  return { mentored: mStats, unmentored: uStats, liftTransactionsPct, liftRetentionPts, hasVerdict }
}
