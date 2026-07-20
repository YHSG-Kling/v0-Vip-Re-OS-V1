// lib/analytics/ai-prediction-outcomes.ts
//
// THE ai_predictions OUTCOME WRITER (owner round 36) — the ledger has carried an
// actual_outcome / outcome_date column pair since day one, but NO writer ever set
// them, which is exactly why the accuracy flywheel excluded it. This module is
// that writer, and it is honest by construction:
//
//   1. CLOSE-TIME GRADER — when a transaction reaches a TERMINAL stage
//      (CLOSED / LOST via lib/transactions/stage-progression), every ungraded
//      transaction-entity prediction for that deal gets its actual_outcome
//      stamped from the REAL event. Nothing is graded from assumptions, decay,
//      or the passage of time.
//   2. WIN-PROBABILITY FREEZER — transactions.win_probability is a live mutable
//      column that converges toward the outcome (the reason the flywheel refused
//      to grade it). Every time the AI writes a new value, the claim is FROZEN
//      as an immutable ai_predictions snapshot row (prediction_type
//      'win_probability') at that moment. The deal_outcome accuracy rail then
//      grades the FIRST pre-outcome claim per deal — hindsight-proof.
//      The single live writer of the column is the AI health analysis
//      (app/actions/ai-transaction-coordinator); a weekly freeze cadence would
//      ride the cron rail, which is owned elsewhere this round — documented,
//      not stubbed.
//   3. LEAD-CONVERSION COMPLETION — when a deal closes, lead_conversion
//      predictions for the deal's contacts are marked converted (a real event).
//      This is LEDGER COMPLETENESS ONLY: the accuracy rail deliberately skips
//      lead_conversion rows because only the positive outcome is observable
//      event-driven (grading positives-only would be survivorship, not
//      accuracy). The negative needs a horizon sweep on the cron rail.
//
// Every writer here is best-effort at its call sites (a grading hiccup never
// blocks a close) and idempotent (actual_outcome IS NULL guards regrading).

import type { SupabaseClient } from "@supabase/supabase-js"
import { normalizeProbability } from "@/lib/analytics/prediction-accuracy"

type Svc = SupabaseClient<any, any, any>

export type TerminalDealOutcome = "closed" | "lost"

export const WIN_PROBABILITY_PREDICTION_TYPE = "win_probability"

/** The provenance stamp written into actual_outcome — outcomes trace to the real event. */
export function buildTerminalOutcomePayload(outcome: TerminalDealOutcome): Record<string, unknown> {
  return {
    outcome,
    source: "transactions.stage_progression",
    graded_by: "close_time_grader",
    graded_at: new Date().toISOString(),
  }
}

export interface WinProbabilitySnapshotInput {
  transactionId: string
  brokerageId: string
  /** The raw value the writer is about to persist on transactions.win_probability (0..1 or 0..100). */
  winProbability: unknown
  /** The moment that produced the claim — named so the ledger reads honestly. */
  moment: "ai_health_analysis" | "offer_submitted" | "manual"
  modelVersion?: string | null
}

/**
 * Freeze the mutable win-probability claim as an immutable snapshot row.
 * Refuses unusable values (never stores a claim it can't grade later) and
 * skips when the latest frozen claim for the deal is identical (no new
 * information — reruns don't pad the ledger).
 */
export async function captureWinProbabilitySnapshot(
  svc: Svc,
  input: WinProbabilitySnapshotInput,
): Promise<{ captured: boolean; reason: string }> {
  const p = normalizeProbability(input.winProbability)
  if (p == null) return { captured: false, reason: "no usable probability value — nothing frozen" }

  const { data: latest } = await svc
    .from("ai_predictions")
    .select("prediction_value")
    .eq("prediction_type", WIN_PROBABILITY_PREDICTION_TYPE)
    .eq("entity_type", "transaction")
    .eq("entity_id", input.transactionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  const last = (latest?.prediction_value as Record<string, unknown> | null)?.win_probability
  if (typeof last === "number" && Math.abs(last - p) < 1e-9) {
    return { captured: false, reason: "unchanged claim — latest frozen snapshot already carries this probability" }
  }

  const { error } = await svc.from("ai_predictions").insert({
    prediction_type: WIN_PROBABILITY_PREDICTION_TYPE,
    entity_type: "transaction",
    entity_id: input.transactionId,
    brokerage_id: input.brokerageId,
    prediction_value: {
      win_probability: p,
      moment: input.moment,
      // The AI states no separate confidence for this figure — say so rather than mint one.
      confidence_stated: false,
    },
    confidence_score: 0, // no separately-stated confidence; flagged above, never invented
    model_version: input.modelVersion ?? "transactions.win_probability@v1",
  })
  if (error) return { captured: false, reason: `snapshot insert failed: ${error.message}` }
  return { captured: true, reason: "frozen" }
}

/**
 * CLOSE-TIME GRADER: stamp the real terminal outcome onto every ungraded
 * transaction-entity prediction for this deal (win_probability snapshots AND
 * the deal_close_probability rows the transaction-detail surface writes).
 * Idempotent — already-graded rows are never rewritten.
 */
export async function gradeTransactionPredictionOutcomes(
  svc: Svc,
  input: { transactionId: string; outcome: TerminalDealOutcome; outcomeDate?: string | null },
): Promise<{ graded: number; error?: string }> {
  const outcomeDate = input.outcomeDate ?? new Date().toISOString()
  const { data, error } = await svc
    .from("ai_predictions")
    .update({
      actual_outcome: buildTerminalOutcomePayload(input.outcome),
      outcome_date: outcomeDate,
      updated_at: new Date().toISOString(),
    })
    .eq("entity_type", "transaction")
    .eq("entity_id", input.transactionId)
    .is("actual_outcome", null)
    .select("id")
  if (error) return { graded: 0, error: error.message }
  return { graded: (data ?? []).length }
}

/**
 * LEAD-CONVERSION COMPLETION (positive event only): when a deal closes, mark the
 * lead_conversion predictions for its contacts as converted. Ledger completeness,
 * NOT rail-graded — see the module header for why positives-only never becomes a
 * hit rate.
 */
export async function markLeadConversionOutcomes(
  svc: Svc,
  input: { contactIds: Array<string | null | undefined>; transactionId: string; outcomeDate?: string | null },
): Promise<{ graded: number; error?: string }> {
  const ids = [...new Set(input.contactIds.filter((c): c is string => !!c))]
  if (ids.length === 0) return { graded: 0 }
  const outcomeDate = input.outcomeDate ?? new Date().toISOString()
  const { data, error } = await svc
    .from("ai_predictions")
    .update({
      actual_outcome: {
        outcome: "converted",
        source: "transactions.stage_progression",
        transaction_id: input.transactionId,
        graded_by: "close_time_grader",
        graded_at: new Date().toISOString(),
        // Positive-only capture: NOT graded by the accuracy rail (survivorship guard).
        rail_graded: false,
      },
      outcome_date: outcomeDate,
      updated_at: new Date().toISOString(),
    })
    .eq("entity_type", "lead")
    .eq("prediction_type", "lead_conversion")
    .in("entity_id", ids)
    .is("actual_outcome", null)
    .select("id")
  if (error) return { graded: 0, error: error.message }
  return { graded: (data ?? []).length }
}
