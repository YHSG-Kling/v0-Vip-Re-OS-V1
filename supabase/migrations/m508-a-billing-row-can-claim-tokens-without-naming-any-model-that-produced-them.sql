-- ═════════════════════════════════════════════════════════════════════════════
-- ⚠  THE "NOT APPLIED" CLAIM BELOW IS STALE. THIS MIGRATION *IS* APPLIED.
--
--    MEASURED 2026-09-04 against hrvaqgvukzxfskkcrwbt's own migration ledger,
--    `supabase_migrations.schema_migrations`, which carries a row named
--    `m508_…`. It was one of TWENTY files in this directory whose header said
--    it had never run; all twenty were in the ledger. Nobody came back to
--    update the headers after applying them.
--
--    THE EVIDENCE IS ONE-DIRECTIONAL, AND THAT IS STATED RATHER THAN GLOSSED:
--    presence in the ledger PROVES a migration ran. ABSENCE PROVES NOTHING —
--    the ledger only records migrations applied through the migration tool, and
--    m599 and m602–m605 are all applied and all absent from it, because they
--    were executed as direct SQL. So this banner is written only onto files the
--    ledger positively vouches for.
--
--    The original header is preserved below unedited. It is the record of what
--    its author believed when they wrote it, and CLAUDE.md §3 is the reason the
--    belief was wrong: "a migration that exists as a .sql file has not been
--    applied" — which is true, and cuts both ways. A file cannot tell you it
--    ran, and it cannot tell you it did not.
--
--    scripts/migration-claim-guard.ts now holds this class shut.
-- ═════════════════════════════════════════════════════════════════════════════

-- m508 — A BILLING ROW CAN CLAIM TOKENS WITHOUT NAMING ANY MODEL THAT PRODUCED THEM.
--
-- ── NOT APPLIED. WRITTEN, NOT RUN. See the VALIDATE note at the bottom. ──────
--
-- WHAT THIS IS ABOUT
--
-- `ai_tool_usage` is the platform's AI cost ledger. lib/finance/usage-metering.ts
-- folds it into `meter_readings.ai_tokens` per brokerage, the per-tier overage
-- projection is derived from the same rows, and lib/platform/manager-ops.ts
-- rolls cost and latency up per manager off it.
--
-- Ten AI Toolkit tools in app/actions/ai-tools-hub.ts were one-line stubs of
-- this shape (paraphrased, not quoted, so no analyzer reads this comment as
-- code): a function that took its arguments, ignored all of them, returned a
-- fixed sentence dressed as AI output, and asserted a token count of its own —
-- 500, 400, 300, 350, 250, 600, 700, 200, 150. `executeAITool` read that field
-- and wrote it to `tokens_used` as a SUCCESSFUL run.
--
-- Nothing had spent anything. The rows were indistinguishable from real ones to
-- every reader downstream, because the ledger has no way to tell a measured
-- figure from an invented one.
--
-- THE INVARIANT THE APPLICATION NOW HOLDS, SAID IN THE SCHEMA
--
--   A row that claims it consumed tokens must name the model that consumed them.
--
-- Every honest writer already satisfies it. lib/ai/cost-tracking.ts::logAIUsage
-- always stamps `model_used` alongside `tokens_used` — it derives cost_cents
-- from the pair. The rewritten hub derives `tokens_used`, `model_used` and
-- `cost_cents` together from one measured provider response, or writes 0/NULL/0
-- with a named reason. A stub cannot satisfy it, because a stub has no model.
--
-- This is the same move m476 made for the anonymous lane: the application rule
-- was correct, and the schema said the half of it that a CHECK can say, so a
-- future writer cannot quietly reintroduce the defect.

ALTER TABLE public.ai_tool_usage
  ADD CONSTRAINT ai_tool_usage_tokens_name_their_model
  CHECK (
    tokens_used IS NULL
    OR tokens_used = 0
    OR model_used IS NOT NULL
  )
  NOT VALID;

-- ── AND THEN VALIDATED, BECAUSE THE FEARED HISTORY DOES NOT EXIST ────────────
--
-- NOT VALID above is written for the case the constraint was designed around:
-- historical rows the stubs wrote with an invented tokens_used and no model.
-- That case was ASSUMED rather than measured, and measuring it changed the
-- answer. On this database, 2026-08-20:
--
--     select count(*) from public.ai_tool_usage;                     -> 23
--     select count(*) from public.ai_tool_usage
--       where coalesce(tokens_used,0) <> 0 and model_used is null;   -> 0
--
-- ZERO violating rows. There is no billing history to reconcile and therefore
-- no owner decision to wait on, so the constraint is validated in the same
-- migration and the rule is enforced over the whole table rather than only over
-- rows written from now on. The NOT VALID step is kept rather than collapsed
-- into a plain CHECK so that a database which DOES carry the fabricated rows
-- still takes the constraint and still refuses new ones — the ADD succeeds
-- there and only this VALIDATE fails, which is a loud, recoverable, and
-- correct outcome rather than a migration that cannot be applied at all.
ALTER TABLE public.ai_tool_usage
  VALIDATE CONSTRAINT ai_tool_usage_tokens_name_their_model;

COMMENT ON CONSTRAINT ai_tool_usage_tokens_name_their_model ON public.ai_tool_usage IS
  'A ledger row that claims token consumption must name the model that consumed them. '
  'Added after ten AI Toolkit tools were found writing fixed token counts for calls that '
  'never reached a provider. A row with no model has nothing to price and nothing to '
  'attribute, so a non-zero count on it is an assertion, not a measurement.';

-- ── WHY `NOT VALID`, AND WHAT MUST HAPPEN BEFORE IT IS VALIDATED ─────────────
--
-- NOT VALID enforces the rule on every NEW and UPDATED row while leaving history
-- untouched. That is deliberate, and it is not caution for its own sake:
--
--   1. THE HISTORICAL ROWS ARE THE FABRICATED ONES. Every stub run since the AI
--      Toolkit shipped wrote tokens_used in {500,400,300,350,250,600,700,200,150}
--      with model_used NULL. Those rows WILL violate this constraint. They are
--      also billing history that has already been rolled into meter_readings, so
--      rewriting them is a decision about a tenant's past invoices, not a
--      cleanup — it needs an owner, not a migration author.
--
--   2. lib/kernel/ai-tools.ts::runAiTool accepts a `tokensUsed` input and writes
--      it WITHOUT a model_used. It currently has no live caller (only a re-export
--      from lib/kernel/index.ts), so nothing breaks today — but wiring it later
--      with a non-zero count would now fail loudly instead of landing an
--      unattributed figure in the ledger. That is the intended behaviour; it is
--      recorded here so the failure is recognised rather than worked around.
--
-- To finish, in order, and only once (1) has an owner's decision:
--
--   -- how big is the problem, per tool
--   SELECT tool_name, count(*), sum(tokens_used)
--     FROM public.ai_tool_usage
--    WHERE coalesce(tokens_used, 0) <> 0 AND model_used IS NULL
--    GROUP BY tool_name ORDER BY 2 DESC;
--
--   -- then, after the ruling on what those rows should say:
--   ALTER TABLE public.ai_tool_usage VALIDATE CONSTRAINT ai_tool_usage_tokens_name_their_model;
--
-- PROOF: scripts/ai-tools-hub-honesty-simulator.ts (test:ai-tools-hub-honesty)
-- holds the application half of this invariant — that every non-zero figure the
-- hub writes is read off a provider response, and that a run which bought
-- nothing books zero — with negative controls that reintroduce each defect and
-- require the proof to go red.
