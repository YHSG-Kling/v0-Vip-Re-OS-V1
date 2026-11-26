-- m298-retry-result-check-actually-enforces.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- A CHECK CONSTRAINT THAT ENFORCED NOTHING.
--
-- error_resolution_log_retry_result_check was written as:
--
--   CHECK (retry_result = ANY (ARRAY['success', 'failure', 'pending', NULL]))
--
-- The NULL element makes it INERT. For any value not in the list, each equality
-- comparison yields either FALSE or — against the NULL element — NULL, so
-- `= ANY(...)` evaluates to NULL rather than FALSE. A CHECK constraint is
-- satisfied when its expression is NULL. The constraint therefore accepted every
-- string ever written to the column.
--
-- Proven live before this migration: inserting retry_result='scheduled' — a
-- value plainly not in the list — was ACCEPTED.
--
-- This is worse than having no constraint. Every reader of the schema, and the
-- vocabulary snapshot this repo generates from it, believed the column carried a
-- three-value vocabulary. lib/errors/auto-retry.ts wrote a fourth ('scheduled')
-- for the deferred-retry lane and nothing objected, so the drift was invisible
-- from both directions: the DB did not reject it and the schema said it would.
--
-- The author's intent is clear — the NULL element was meant to allow a NULL
-- retry_result (the column is nullable and rows legitimately have none). That is
-- spelled `IS NULL OR`, which is what this migration writes. NULL stays allowed;
-- everything else must now be one of the three real states.
--
-- 'scheduled' is NOT added. 'pending' already means "queued, not yet run" — the
-- exact meaning the deferred lane needed — and two spellings for one state is
-- the drift this sweep exists to remove. auto-retry.ts is repointed onto
-- 'pending' in the same change, on both the write and the cron's filter.
--
-- Live rows carrying the old spelling are migrated forward first, so ADD
-- CONSTRAINT validates cleanly. (Measured at the time of writing: the table is
-- empty, so this UPDATE is a no-op safety net, not a guess.)

UPDATE public.error_resolution_log
   SET retry_result = 'pending'
 WHERE retry_result = 'scheduled';

-- Anything else the inert constraint let through becomes NULL rather than
-- blocking the migration: an unrecognized retry_result is not information worth
-- preserving, and NULL is the column's honest "no result recorded".
UPDATE public.error_resolution_log
   SET retry_result = NULL
 WHERE retry_result IS NOT NULL
   AND retry_result NOT IN ('success', 'failure', 'pending');

ALTER TABLE public.error_resolution_log
  DROP CONSTRAINT IF EXISTS error_resolution_log_retry_result_check;

ALTER TABLE public.error_resolution_log
  ADD CONSTRAINT error_resolution_log_retry_result_check CHECK (
    retry_result IS NULL
    OR retry_result = ANY (ARRAY['success', 'failure', 'pending'])
  );
