-- m580 — tool_usage_sessions kept two clocks, and nobody ever read the second.
--
-- STATUS: WRITTEN, NOT APPLIED. The integrator applies migrations; app code
-- (app/actions/calculators.ts trackToolUsage) already stopped writing the
-- column, which is safe either way because it is NOT NULL DEFAULT NOW().
--
-- THE DEFECT (§6 — one vocabulary per fact): migration
-- 059-prospects-content-tools-disclosures.sql gave `tool_usage_sessions` both
--
--     timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW()
--     created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
--
-- — two spellings of "when the session happened". Every reader keys on
-- `created_at` (app/actions/analytics.ts:85 filters the day's sessions on it;
-- lib/finance/usage-metering.ts:31 rolls the month up on it), while the writer
-- stamped `timestamp` from the app clock — so the two columns could disagree by
-- clock skew and the one being read was never the one being deliberately
-- written. The opposite-missing census reported `tool_usage_sessions.timestamp`
-- as "written by code, read by NOBODY", which is exactly what it was.
--
-- SURVIVOR: `created_at`. The only schema object that referenced `timestamp`
-- was the per-tool index, which is re-pointed first so the drop cannot leave
-- the tool_name lookups unindexed.

BEGIN;

DROP INDEX IF EXISTS idx_tool_usage_sessions_tool;
CREATE INDEX IF NOT EXISTS idx_tool_usage_sessions_tool
  ON public.tool_usage_sessions (tool_name, created_at DESC);

ALTER TABLE public.tool_usage_sessions DROP COLUMN IF EXISTS "timestamp";

COMMIT;

-- After applying: regenerate the schema caches (schema-snapshot.ts et al.) per
-- CLAUDE.md §3 so the guards see the column gone.
