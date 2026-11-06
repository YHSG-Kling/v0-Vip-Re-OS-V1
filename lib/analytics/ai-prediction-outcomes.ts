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
// Module-private since 2026-09-08 — no importer outside this file (category B tranche).
function buildTerminalOutcomePayload(outcome: TerminalDealOutcome): Record<string, unknown> {
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

  // TENANT-SCOPED, and NOT because RLS handles it. The other two functions in
  // this module are only ever reached from lib/transactions/stage-progression,
  // which builds a SERVICE client (BYPASSRLS). This one is not: its sole caller
  // is app/actions/ai-transaction-coordinator.ts, which passes the SESSION server
  // client — so this read runs under `ai_predictions_select`, which is the
  // migration-029 escape (`… OR (brokerage_id IS NULL) OR has_brokerage_access(…)`)
  // and therefore admits any untenanted row from any brokerage.
  //
  // That matters here beyond visibility: this read decides whether the claim is
  // "unchanged", so a foreign untenanted snapshot carrying the same probability
  // would SUPPRESS this tenant's frozen snapshot and silently cost the accuracy
  // rail an observation. `input.brokerageId` is already required and is what the
  // insert below stamps — the dedupe now asks about the same rows it writes.
  //
  // The error is destructured because supabase-js RESOLVES a refusal, and a
  // refused dedupe read must not be mistaken for "no prior snapshot".
  const { data: latest, error: latestError } = await svc
    .from("ai_predictions")
    .select("prediction_value")
    .eq("brokerage_id", input.brokerageId)
    .eq("prediction_type", WIN_PROBABILITY_PREDICTION_TYPE)
    .eq("entity_type", "transaction")
    .eq("entity_id", input.transactionId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (latestError) {
    return { captured: false, reason: `prior-snapshot lookup refused: ${latestError.message}` }
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// WAVE 150 (lane 150JNAD — directive 150N + 150AD, contract C37): THE DECISION-WINDOW FORECAST. A window the movement manager
// placed (lib/intent/moving-moments.ts buildMovingMoment — 0_30 / 31_90 / 91_180 / 181_365 / over_365) is a CLAIM, frozen here in
// THE one prediction ledger (never a second store) and graded by what actually happened:
//   · a CONFIRMED move (listed / purchased / moved) → the days it took, the window it fell in, hit = same window;
//   · an appointment / engagement is NOT a closing — it never grades a forecast (it stays open);
//   · a negative close (declined / false_positive / opted_out / no_change) → a validated MISS only once the forecast window has
//     fully elapsed; before that it is recorded as `no_move_early` and NOT counted as validated (a person can still move inside it).
// Calibration (lib/intelligence/strategy-learning.ts calibrateDecisionWindows) reads ONLY validated grades, and a probability is
// published per window only past its sample floor. UNKNOWN windows are never frozen — there is nothing to grade.
// ─────────────────────────────────────────────────────────────────────────────

const DECISION_WINDOW_PREDICTION_TYPE = "decision_window"

/** The window upper bounds a negative close must outlast to count as a validated miss (over_365 never does). */
const WINDOW_UPPER: Readonly<Record<string, number | null>> = Object.freeze({ "0_30": 30, "31_90": 90, "91_180": 180, "181_365": 365, over_365: null })
const CONFIRMED_MOVES: ReadonlySet<string> = new Set(["listed", "purchased", "moved"])
const NEGATIVE_CLOSES: ReadonlySet<string> = new Set(["declined", "false_positive", "opted_out", "no_change"])

/**
 * Freeze ONE decision-window forecast (tenant-pinned). Skips when the latest UNGRADED forecast for the subject already carries the
 * same window and basis (no new information — a re-evaluation never pads the ledger). Reads every { error }.
 */
export async function freezeDecisionWindowForecast(
  svc: Svc,
  input: {
    brokerageId: string; entityType: "contact" | "lead"; entityId: string
    moment: { decision_window: { window: string; basis: string; uncertainty: string; why: string }; buyer_readiness: { level: string }; seller_readiness: { level: string }; desire_to_move: { level: string }; expects_to_move: { level: string }; ability_to_act: { level: string } }
    holdoutArm: string | null; evidenceIds: string[]; now?: Date
  },
): Promise<{ captured: boolean; reason: string }> {
  const w = input.moment.decision_window
  if (!input.brokerageId || !input.entityId) return { captured: false, reason: "no tenant or subject" }
  if (!(w.window in WINDOW_UPPER)) return { captured: false, reason: "an unknown window is never a forecast — nothing frozen" }
  const { data: latest, error: lErr } = await svc.from("ai_predictions").select("prediction_value")
    .eq("brokerage_id", input.brokerageId).eq("prediction_type", DECISION_WINDOW_PREDICTION_TYPE).eq("entity_type", input.entityType).eq("entity_id", input.entityId)
    .is("actual_outcome", null).order("created_at", { ascending: false }).limit(1).maybeSingle()
  if (lErr) return { captured: false, reason: `prior-forecast lookup refused: ${lErr.message}` }
  const prev = (latest?.prediction_value ?? null) as { window?: string; basis?: string } | null
  if (prev && prev.window === w.window && prev.basis === w.basis) return { captured: false, reason: "unchanged forecast — the open one already carries this window" }
  const at = (input.now ?? new Date()).toISOString()
  const { error } = await svc.from("ai_predictions").insert({
    prediction_type: DECISION_WINDOW_PREDICTION_TYPE, entity_type: input.entityType, entity_id: input.entityId, brokerage_id: input.brokerageId,
    prediction_value: { window: w.window, basis: w.basis, uncertainty: w.uncertainty, buyer: input.moment.buyer_readiness.level, seller: input.moment.seller_readiness.level, holdout_arm: input.holdoutArm, forecast_at: at, evidence_ids: input.evidenceIds.slice(0, 50), confidence_stated: false },
    // No separately-stated confidence on a window (a reporting interval, not a probability) — null, never minted.
    confidence_score: null,
    prediction_factors: { why: w.why.slice(0, 400), desire: input.moment.desire_to_move.level, expects: input.moment.expects_to_move.level, ability: input.moment.ability_to_act.level },
    model_version: "moving-moments@wave150",
  })
  if (error) return { captured: false, reason: `forecast insert failed: ${error.message}` }
  return { captured: true, reason: "frozen" }
}

/** PURE. One outcome against one forecast → the grade (null = not gradable — an appointment is never a closing). */
function gradeOfOutcome(forecast: { window?: string; forecast_at?: string } | null, createdAt: string, outcome: string, outcomeAt: string, decisionWindowForDays: (d: number) => string): Record<string, unknown> | null {
  const from = Date.parse(forecast?.forecast_at ?? createdAt)
  const elapsedDays = Math.max(0, Math.floor((Date.parse(outcomeAt) - from) / 86_400_000))
  if (!Number.isFinite(elapsedDays)) return null
  const window = String(forecast?.window ?? "")
  if (CONFIRMED_MOVES.has(outcome)) {
    // ONE interval rule (lib/intent/moving-moments.ts decisionWindowForDays) — the grader never restates the boundaries.
    const actual = decisionWindowForDays(elapsedDays)
    return { kind: "confirmed_move", outcome, actual_days: elapsedDays, actual_window: actual, hit: actual === window, validated: true }
  }
  if (NEGATIVE_CLOSES.has(outcome)) {
    const upper = WINDOW_UPPER[window]
    const outlasted = typeof upper === "number" && elapsedDays > upper
    return { kind: outlasted ? "no_move" : "no_move_early", outcome, actual_days: elapsedDays, actual_window: null, hit: false, validated: outlasted }
  }
  return null
}

/**
 * GRADE the subject's open decision-window forecasts by a real movement outcome (recordMovementOutcome's own close). Idempotent
 * (`actual_outcome IS NULL`), tenant-pinned, every update counted. An appointment / engagement grades nothing.
 */
export async function gradeDecisionWindowForecasts(
  svc: Svc,
  input: { brokerageId: string; entityType: "contact" | "lead"; entityId: string; outcome: string; outcomeAt: string; signalId: string },
): Promise<{ graded: number; error?: string }> {
  if (!CONFIRMED_MOVES.has(input.outcome) && !NEGATIVE_CLOSES.has(input.outcome)) return { graded: 0 }
  const { data, error } = await svc.from("ai_predictions").select("id, prediction_value, created_at")
    .eq("brokerage_id", input.brokerageId).eq("prediction_type", DECISION_WINDOW_PREDICTION_TYPE).eq("entity_type", input.entityType).eq("entity_id", input.entityId)
    .is("actual_outcome", null).limit(20)
  if (error) return { graded: 0, error: error.message }
  let graded = 0
  // Lazily imported: this module sits in the transaction / close graphs, which never need the movement modules eagerly.
  const { decisionWindowForDays } = await import("@/lib/intent/moving-moments")
  for (const r of (data ?? []) as Array<{ id: string; prediction_value: Record<string, unknown> | null; created_at: string }>) {
    const g = gradeOfOutcome(r.prediction_value as { window?: string; forecast_at?: string } | null, r.created_at, input.outcome, input.outcomeAt, decisionWindowForDays)
    if (!g) continue
    const { data: upd, error: uErr } = await svc.from("ai_predictions")
      .update({ actual_outcome: { ...g, signal_id: input.signalId, source: "movement_signals.outcome", graded_by: "movement_outcome_grader", graded_at: new Date().toISOString() }, outcome_date: input.outcomeAt.slice(0, 10), updated_at: new Date().toISOString() })
      .eq("id", r.id).eq("brokerage_id", input.brokerageId).is("actual_outcome", null).select("id")
    if (uErr) return { graded, error: uErr.message }
    graded += (upd ?? []).length
  }
  return { graded }
}

/** The tenant's decision-window calibration from its own GRADED forecasts (validated grades only). A refused read is said. */
export async function loadDecisionWindowCalibration(svc: Svc, brokerageId: string): Promise<{ ok: true; calibration: import("@/lib/intelligence/strategy-learning").DecisionWindowCalibration } | { ok: false; error: string }> {
  if (!brokerageId) return { ok: false, error: "no tenant" }
  const { data, error } = await svc.from("ai_predictions").select("prediction_value, actual_outcome")
    .eq("brokerage_id", brokerageId).eq("prediction_type", DECISION_WINDOW_PREDICTION_TYPE).not("actual_outcome", "is", null).limit(5000)
  if (error) return { ok: false, error: `ai_predictions: ${error.message}` }
  const { calibrateDecisionWindows } = await import("@/lib/intelligence/strategy-learning")
  return { ok: true, calibration: calibrateDecisionWindows(((data ?? []) as Array<{ prediction_value: Record<string, unknown> | null; actual_outcome: Record<string, unknown> | null }>).map((r) => ({
    forecast: String(r.prediction_value?.window ?? "unknown"), validated: r.actual_outcome?.validated === true, hit: r.actual_outcome?.hit === true, kind: String(r.actual_outcome?.kind ?? ""),
  }))) }
}
