-- ── APPLIED LIVE 2026-11-06 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 150, lane 150JNAD ──
--
-- m971 — ai_predictions: the CALIBRATION SAMPLES of the decision-window forecaster live in THE one prediction ledger (contract C37:
-- "never a second prediction store"). No new table and no new column: a forecast is an ai_predictions row with
-- prediction_type 'decision_window' (entity contact | lead, brokerage_id set explicitly), prediction_value
-- { window, basis, uncertainty, buyer, seller, holdout_arm, forecast_at, evidence_ids, confidence_stated:false }, confidence_score NULL
-- (a reporting interval states no confidence), graded into actual_outcome
-- { kind confirmed_move | no_move | no_move_early, outcome, actual_days, actual_window, hit, validated, signal_id, ... } by
-- lib/analytics/ai-prediction-outcomes.ts gradeDecisionWindowForecasts when the movement outcome lands.
-- Writers: freezeDecisionWindowForecast (lib/intent/movement-signals.ts evaluateMovementSubject) and gradeDecisionWindowForecasts
-- (recordMovementOutcome). Reader: loadDecisionWindowCalibration → lib/intelligence/strategy-learning.ts calibrateDecisionWindows.
-- The existing dealOutcomeAdapter (lib/analytics/prediction-accuracy.ts) reads entity_type 'transaction' only, so these rows never
-- enter the deal-outcome rail.
--
-- Two partial indexes: the open-forecast dedupe / grading lookup per subject, and the tenant's graded set for calibration.

CREATE INDEX IF NOT EXISTS ai_predictions_decision_window_open_idx
  ON public.ai_predictions (brokerage_id, entity_type, entity_id, created_at DESC)
  WHERE prediction_type = 'decision_window' AND actual_outcome IS NULL;

CREATE INDEX IF NOT EXISTS ai_predictions_decision_window_graded_idx
  ON public.ai_predictions (brokerage_id, created_at DESC)
  WHERE prediction_type = 'decision_window' AND actual_outcome IS NOT NULL;
