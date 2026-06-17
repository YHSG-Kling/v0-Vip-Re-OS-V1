// lib/intelligence/predictor-outcome.ts
//
// PREDICTOR OUTCOME (pure) — closes the predictor learning loop. A predictor fired a gated play
// (buyer-stall recalibrate, listing-stall marketing refresh, stuck-stage nudge); did it WORK? The
// honest signal is re-engagement: after the play, did the contact reply, tour, or write an offer? If
// so within the evaluation window → WIN. If the window passes with no re-engagement → LOSS. If we're
// still inside the window with no re-engagement yet → not settled (wait). This decides that, and maps
// a predictor signal_type back to its learning namespace. Pure (no I/O), unit-tested directly.

import type { PredictorName } from "./predictor-learning-runner"

export const PREDICTOR_EVAL_WINDOW_DAYS = 14
const DAY = 86_400_000

/** Map a predictor signal_type to its learning predictor name (null = not a learnable predictor). */
export function predictorNameForSignal(signalType: string | null | undefined): PredictorName | null {
  switch ((signalType ?? "").trim()) {
    case "buyer_stall_predicted":    return "buyer_stall"
    case "listing_stall_predicted":  return "listing_stall"
    case "stage_stalled":            return "stuck_stage"
    case "dual_transaction_timing":  return "dual_transaction"
    default:                         return null
  }
}

export interface PredictorOutcomeDecision {
  /** has the outcome resolved (record it) or are we still waiting? */
  settled: boolean
  won: boolean
  reason: string
}

/**
 * Decide a predictor play's outcome. reengagedAtMs is the timestamp of the FIRST genuine re-engagement
 * AFTER the play (a reply / tour / offer), or null if none. Pure.
 */
export function decidePredictorOutcome(
  playAtMs: number, reengagedAtMs: number | null, nowMs: number, windowDays = PREDICTOR_EVAL_WINDOW_DAYS,
): PredictorOutcomeDecision {
  if (typeof reengagedAtMs === "number" && reengagedAtMs > playAtMs) {
    return { settled: true, won: true, reason: "the contact re-engaged after the play (reply / tour / offer)" }
  }
  if (nowMs - playAtMs >= windowDays * DAY) {
    return { settled: true, won: false, reason: `${windowDays}d passed with no re-engagement after the play` }
  }
  return { settled: false, won: false, reason: "still inside the evaluation window — no re-engagement yet, wait" }
}
