-- ── APPLIED LIVE 2026-09-28 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
--
-- m670 — THE STUCK-RENDER WATCHDOG READS AN INDEX, NOT THE TABLE (wave 87, lane 87D).
--
-- lib/video/video-pipeline-reaper.ts sweepStuckVideoRenders now runs on EVERY
-- app/api/cron/director-reel-render tick (every 5 min — CRON_REGISTRY), so an
-- autonomously rendered approved script can never sit in 'queued' / 'generating'
-- for the ~27 h the daily reaper-net pass allowed. Its one cross-tenant read is
--
--   select brokerage_id from ai_video_projects
--   where status in ('queued','generating') and updated_at < <cutoff>
--   and brokerage_id is not null limit 200
--
-- LIVE, READ 2026-09-28 (project hrvaqgvukzxfskkcrwbt, before writing this):
--   · ai_video_projects has NO index on status or updated_at — its three
--     status-bearing indexes are partial on approval_status / is_published
--     (idx_avp_pending_review, idx_avp_audience_type,
--     ai_video_projects_autopublish_idx), so the watchdog would SEQ-SCAN every
--     finished video 288 times a day as the library grows;
--   · 0 rows in flight today (0 queued/generating past 3 h, 0 generating with no
--     provider job) — pre-production, so this is sized for growth, not a fire.
-- A PARTIAL index on the in-flight states keeps the read proportional to the
-- videos actually in flight (a handful) instead of every video ever made.
-- The status literals are the live CHECK's own members
-- (ai_video_projects_status_check; scripts/check-vocabularies.ts).
--
-- No CHECK, no column, no data change → no vocabulary regeneration needed.

create index if not exists idx_avp_in_flight_updated
  on public.ai_video_projects (updated_at)
  where status in ('queued', 'generating');

-- POSTCONDITION (run after apply; expect exactly one row):
--   select indexname from pg_indexes
--   where tablename = 'ai_video_projects' and indexname = 'idx_avp_in_flight_updated';
