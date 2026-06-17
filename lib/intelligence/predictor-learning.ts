// lib/intelligence/predictor-learning.ts
//
// PREDICTOR LEARNING (pure) — turns the heuristic manager predictors (buyer-stall, listing-stall,
// dual-transaction timing, stuck-stage) into SELF-IMPROVING ones, the same way the Video Director and
// the consensus huddle already learn. Each time a predictor fires a gated play and the outcome is
// later known (the contact re-engaged → win; went cold/withdrew → loss), it's recorded onto the
// existing ai_feedback_log. This reads that accumulated record back and decides, PER BROKERAGE,
// whether to keep firing at the normal bar or RAISE the bar (require a stronger signal) when a
// predictor's plays haven't been landing. Honest on thin data: an unproven predictor fires normally
// (it earns its track record). Pure (no I/O), unit-tested directly.

export type PredictorConfidence = "unproven" | "reliable" | "mixed" | "unreliable"

export interface PredictorAccuracy {
  fired: number
  wins: number
  accuracy: number // 0–1
}

export interface PredictorTuning {
  confidence: PredictorConfidence
  accuracy: number
  fired: number
  /** how much stronger the signal must be before firing (1.0 = normal; >1 = raise the bar). */
  thresholdMultiplier: number
  /** when true, only fire on the STRONGEST severity (the predictor has been wrong too often). */
  requireStrongest: boolean
  why: string
}

export const PREDICTOR_MIN_SAMPLE = 5

/** Fold recorded wins/losses into an accuracy. Pure. */
export function predictorAccuracy(wins: number, losses: number): PredictorAccuracy {
  const fired = Math.max(0, wins) + Math.max(0, losses)
  return { fired, wins: Math.max(0, wins), accuracy: fired > 0 ? Math.max(0, wins) / fired : 0 }
}

/** Decide how to tune a predictor from its accumulated record. Pure. */
export function predictorTuning(wins: number, losses: number, opts?: { minSample?: number }): PredictorTuning {
  const acc = predictorAccuracy(wins, losses)
  const minSample = opts?.minSample ?? PREDICTOR_MIN_SAMPLE

  if (acc.fired < minSample) {
    return { confidence: "unproven", accuracy: acc.accuracy, fired: acc.fired, thresholdMultiplier: 1.0, requireStrongest: false, why: `unproven (${acc.fired} fired) — firing at the normal bar to earn a track record` }
  }
  if (acc.accuracy >= 0.7) {
    return { confidence: "reliable", accuracy: acc.accuracy, fired: acc.fired, thresholdMultiplier: 1.0, requireStrongest: false, why: `reliable (${Math.round(acc.accuracy * 100)}% over ${acc.fired}) — keep firing at the normal bar` }
  }
  if (acc.accuracy <= 0.4) {
    return { confidence: "unreliable", accuracy: acc.accuracy, fired: acc.fired, thresholdMultiplier: 1.5, requireStrongest: true, why: `unreliable (${Math.round(acc.accuracy * 100)}% over ${acc.fired}) — raise the bar; only fire on the strongest signal` }
  }
  return { confidence: "mixed", accuracy: acc.accuracy, fired: acc.fired, thresholdMultiplier: 1.2, requireStrongest: false, why: `mixed (${Math.round(acc.accuracy * 100)}% over ${acc.fired}) — nudge the bar up` }
}

/** Severity rank shared by the predictors (higher = stronger signal). */
export const SEVERITY_RANK: Record<string, number> = { high: 3, overdue: 3, elevated: 2, watch: 1, none: 0 }

/**
 * Given a predictor's severity label and the brokerage tuning, decide whether to FIRE. When the
 * predictor has been unreliable, only the strongest severity passes. Pure.
 */
export function shouldFireWithTuning(severity: string, tuning: PredictorTuning): boolean {
  const rank = SEVERITY_RANK[severity] ?? 0
  if (rank === 0) return false
  if (tuning.requireStrongest) return rank >= 3
  return true
}
