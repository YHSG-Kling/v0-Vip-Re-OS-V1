-- m302 — ONE per-step ledger for the campaign-sequence engine.
-- ─────────────────────────────────────────────────────────────────────────────
-- THE TWO ENGINES WERE NEVER THE OVERLAP. THE LEDGER WAS.
--
-- The platform has two step-running systems and they are correctly separate:
--
--   · WORKFLOW ORCHESTRATOR — workflow_runs + workflow_run_steps. Chain_key
--     driven, fires off kernel events, anchored to a contact/listing/
--     transaction, advances by step INDEX. The "increments" engine.
--   · CAMPAIGN SEQUENCES — campaign_sequences + campaign_sequence_steps +
--     sequence_enrollments. Per-contact multi-channel outbound with delays
--     between steps. The "sequences" engine.
--
-- Two earlier passes (sequences_workflow_nav, workflow_engine_consolidation)
-- both examined workflow_step_runs, compared it to the ORCHESTRATOR tables,
-- correctly concluded "genuinely a different concern", and left it alone. Both
-- were right about the comparison they made and both missed the real one:
-- workflow_step_runs is not an orchestrator table at all. It is keyed on
-- enrollment_id + step_id — it belongs to the SEQUENCE engine, which already
-- has a per-step ledger called sequence_step_executions.
--
-- So the sequence engine has been writing TWO ledgers for the SAME step, from
-- adjacent lines of step-executor.ts:
--
--     void Promise.resolve(supabase.from("workflow_step_runs").update({...}))  -- step 10
--     await supabase.from("sequence_step_executions").insert({...})            -- step 11
--
-- And the name is why the two ENGINES looked like they overlapped:
--     workflow_run_steps  → the orchestrator's steps
--     workflow_step_runs  → the sequence engine's steps
-- Two tables, two systems, the same three words in a different order.
--
-- ── WHAT THE DUPLICATE ACTUALLY COST ────────────────────────────────────────
-- 1. THE WORKFLOW REPORT'S CONVERSION NUMBERS WERE STRUCTURALLY ZERO.
--    workflow_step_runs.converted_at / conversion_value_cents /
--    attribution_source were declared by scripts/1026-workflow-os-sprint-a.sql
--    ("per-step audit + revenue attribution") and NOTHING has ever written one
--    of them. /dashboard/campaigns/workflow-reports and the admin dashboard
--    widget both read them and both display "Conversions: 0 · $0" for every
--    brokerage, permanently — a hardcoded zero wearing the costume of a metric.
--    The revenue-attribution half of that table was never built; the real
--    attribution engine (lib/marketing/attribution.ts, 4 models, closed-
--    transaction GCI, idempotent) was built campaign-side instead. A second
--    scheme next to a complete one is duplication, so it is dropped rather
--    than resurrected, and the report is repointed at signals that are real.
--
-- 2. THE BLOCKED-STEP COUNT EXCLUDED EVERY COMPLIANCE BLOCK.
--    The workflow_step_runs row was inserted immediately BEFORE dispatch, so
--    every step stopped at a gate ahead of it — the authority/compliance gate
--    and the lead-only-channel restriction, both of which write
--    sequence_step_executions — was invisible to it. A broker reading "blocked
--    steps" saw over-touch deferrals only and no sign that the compliance gate
--    was doing anything at all.
--
-- 3. It carried NO brokerage_id, so it was the one sequence table with no
--    tenant anchor of its own (reachable only by joining out to enrollments).
--
-- ── THE MERGE ───────────────────────────────────────────────────────────────
-- sequence_step_executions is the keeper: correctly named, tenant-anchored,
-- written on EVERY path (awaited, not best-effort), and read by the decision-
-- receipts, predictor-outcome, health-prioritizer and channel-order runners.
-- Per the consolidation rule, the columns workflow_step_runs had that it did
-- not are ported over BEFORE it is dropped:
--
--   step_output + output_variable_name — a step's output feeds the next step's
--     variables (sequence_enrollments.step_outputs); the per-step record of
--     what each one produced was only in the discarded ledger.
--   provider_key                       — which provider actually carried it.
--   started_at / finished_at / duration_ms — per-step timing.
--
-- NOT ported: converted_at, conversion_value_cents, attribution_source. Those
-- are the never-written attribution scheme described above; conversion is
-- measured where it is real — see lib/campaign-sequences/sequence-conversion.ts,
-- which resolves it from closed transactions the same way the marketing
-- attribution engine already does.
--
-- SAFE: workflow_step_runs holds 0 rows (verified before applying), so no
-- backfill is required and nothing is lost.

ALTER TABLE sequence_step_executions
  ADD COLUMN IF NOT EXISTS step_output           jsonb,
  ADD COLUMN IF NOT EXISTS output_variable_name  text,
  ADD COLUMN IF NOT EXISTS provider_key          text,
  ADD COLUMN IF NOT EXISTS started_at            timestamptz,
  ADD COLUMN IF NOT EXISTS finished_at           timestamptz,
  ADD COLUMN IF NOT EXISTS duration_ms           integer;

COMMENT ON COLUMN sequence_step_executions.step_output IS
  'What this step produced, keyed into sequence_enrollments.step_outputs under output_variable_name so a later step can reference it. Ported from workflow_step_runs (m302).';
COMMENT ON COLUMN sequence_step_executions.provider_key IS
  'The provider that actually carried this step (resolved by the dispatch cascade). Ported from workflow_step_runs (m302).';
COMMENT ON COLUMN sequence_step_executions.duration_ms IS
  'Wall-clock time for this step''s dispatch. Ported from workflow_step_runs (m302).';

-- The duplicate ledger. 0 rows; every reader repointed in the same commit.
DROP TABLE IF EXISTS workflow_step_runs;
