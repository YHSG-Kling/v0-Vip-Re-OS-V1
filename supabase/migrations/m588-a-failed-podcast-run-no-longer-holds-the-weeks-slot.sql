-- m588 — podcast_auto_runs: a FAILED run no longer holds the week's slot
-- ─────────────────────────────────────────────────────────────────────────────
-- STATUS: APPLIED to hrvaqgvukzxfskkcrwbt by the integrator, 2026-08-31, in the
-- same session that wrote it (the write-then-apply split exists for lanes;
-- CLAUDE.md §3). Verification AFTER applying is recorded at the bottom.
--
-- ── THE DEFECT, measured live before writing ────────────────────────────────
-- lib/podcast/auto-producer.ts uses its insert into podcast_auto_runs as the
-- weekly idempotency ledger and reads the constraint's refusal by SQLSTATE:
--
--     insert { brokerage_id, agent_id, iso_week, status: "queued" }
--     → 23505 ⇒ return { ok: true, status: "already_run" }
--
-- Measured live 2026-08-31 (pg_indexes):
--
--     uq_podcast_auto_runs_brokerage_week UNIQUE (brokerage_id, iso_week)
--
-- PLAIN — not partial on status. So a row that ends the week as
-- status='failed' (renderer down, provider refused, host misconfigured
-- mid-run) permanently blocks that brokerage's episode for the rest of the ISO
-- week: every retry's insert hits 23505 and is told "already ran". A failure
-- masquerading as idempotency — the exact §2 shape where a guard's zero and a
-- broken instrument read alike, played out in a ledger.
--
-- ── THE FIX ─────────────────────────────────────────────────────────────────
-- The unique becomes PARTIAL: a completed, queued or skipped run still dedupes
-- the week; a FAILED one does not hold the slot. 'skipped' deliberately KEEPS
-- the slot — a skip is a decision about this week (host has no voice id), and
-- retrying it every cron tick until someone fixes the profile would burn model
-- spend on the same refusal; the settings card shows the skip where the person
-- who can fix it already is, and next week's run picks up the fix.
--
-- The stale failed row is LEFT AS HISTORY on purpose: the run-ledger card
-- ("Weekly auto-episode runs", app/dashboard/settings/podcast-channels/
-- page.tsx) renders error_message from it, and it already orders by
-- created_at DESC, so a successful retry's row wins every "latest run" read
-- while the failure stays visible beneath it.
--
-- CREATE INDEX ... CONCURRENTLY is not used: this runs through the migration
-- rail (transactional) and the table holds 0 rows live — there is nothing to
-- lock against.
--
-- AFTER-APPLY VERIFICATION (run it, do not trust this file):
--   select indexdef from pg_indexes
--    where tablename='podcast_auto_runs'
--      and indexname='uq_podcast_auto_runs_brokerage_week';
--   → must read: UNIQUE ... (brokerage_id, iso_week) WHERE (status <> 'failed')
--
-- CROSS-REFERENCES kept in agreement in the same change: the census exemption
-- for podcast_auto_runs.iso_week (scripts/opposite-missing-census.ts) cited the
-- plain unique and now cites this partial one; the podcast guard asserts the
-- retry-after-failure semantics with a positive control.

BEGIN;

DROP INDEX IF EXISTS public.uq_podcast_auto_runs_brokerage_week;

CREATE UNIQUE INDEX uq_podcast_auto_runs_brokerage_week
  ON public.podcast_auto_runs (brokerage_id, iso_week)
  WHERE status <> 'failed';

COMMIT;

-- MEASURED AFTER APPLYING (2026-08-31, hrvaqgvukzxfskkcrwbt):
--   uq_podcast_auto_runs_brokerage_week →
--   CREATE UNIQUE INDEX uq_podcast_auto_runs_brokerage_week
--     ON public.podcast_auto_runs USING btree (brokerage_id, iso_week)
--     WHERE (status <> 'failed'::text)
