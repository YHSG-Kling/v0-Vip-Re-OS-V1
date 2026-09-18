-- m371 — the health-check ledger could not record the one status it actually emits
--
-- TWO VOCABULARIES OVER THE SAME CONCEPT, drifted in both directions:
--
--   service_status.current_status  CHECK  healthy | degraded | down | unknown
--   system_health_checks.status    CHECK  healthy | degraded | down | timeout | error
--
-- The only producer of either is app/api/cron/health-check/route.ts, whose
-- checkFn return type is exactly  healthy | degraded | down | unknown  — so:
--
--   • 'unknown' is emitted (a provider with no API key, an integration service
--     with no brokerage_integrations row — today that is ALL FIFTEEN rows in
--     service_status) and the ledger's CHECK REFUSES it. The insert is
--     undestructured, so the refusal is swallowed and the ledger silently
--     records nothing.
--   • 'timeout' and 'error' have NO writer anywhere in the codebase and no
--     reader branches on them.
--
-- The fix keeps the two vocabularies in the relationship they were meant to
-- have — the ledger is the RAW outcome, service_status is the ROLLUP — and
-- makes that relationship storable instead of assumed:
--
--   ledger  = healthy | degraded | down | unknown | timeout | error   (raw)
--   rollup  = healthy | degraded | down | unknown                     (summary)
--
-- 'timeout' and 'error' are KEPT. They are legal raw outcomes of an HTTP check
-- and callConnector can distinguish them; nothing is deleted here. The cron now
-- maps raw → rollup explicitly (rollupStatus) so a raw status that has no
-- rollup counterpart lands as 'down' rather than being refused in silence.
--
-- Verified before writing: system_health_checks holds 0 rows and
-- health_check_history holds 0 rows, so widening the CHECK cannot invalidate
-- existing data. All 64 rows of cron_health_snapshot have last_run_at IS NULL —
-- no cron has ever run on this project, which is why the ledger is empty. This
-- is a LATENT go-live defect, not the cause of the empty table.

ALTER TABLE public.system_health_checks
  DROP CONSTRAINT IF EXISTS system_health_checks_status_check;

ALTER TABLE public.system_health_checks
  ADD CONSTRAINT system_health_checks_status_check
  CHECK (status = ANY (ARRAY[
    'healthy'::text,
    'degraded'::text,
    'down'::text,
    'unknown'::text,
    'timeout'::text,
    'error'::text
  ]));
