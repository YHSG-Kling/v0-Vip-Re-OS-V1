-- ── APPLIED LIVE 2026-11-11 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 152, lane 152B ──
--
-- THE CHANNEL COMPARISON COULD NEVER BE WRITTEN.
--
-- lib/campaigns/roi-calculator.ts recalculateChannelPerformance (daily, app/api/cron/recalculate-roi) upserts one
-- public.channel_performance row per (brokerage, channel, window) with
--     .upsert(row, { onConflict: "brokerage_id,channel_type,window_start,window_end" })
-- and the table carries NO unique constraint or index on those columns. Measured live 2026-11-11 (read-only,
-- pg_constraint on public.channel_performance): only channel_performance_pkey (id) and
-- channel_performance_brokerage_id_fkey. Postgres refuses an ON CONFLICT whose columns match no unique index
-- (42P10, "there is no unique or exclusion constraint matching the ON CONFLICT specification"), the write sentinel
-- logs it, and the row never lands — so the ROI dashboard's Channel Comparison tab and its "best channel" read an
-- empty table on every tenant. Live rows today: 0 (nothing to de-duplicate before the index is built).
--
-- ADDITIVE: one unique index on exactly the conflict target the writer already names. No column, no data change.
-- A plain (non-partial) unique index is what ON CONFLICT (cols) infers. window_start / window_end are nullable, but
-- the only writer always sets both; two NULL windows would not collide (NULLs are distinct), which matches the
-- writer never writing one.

create unique index if not exists channel_performance_brokerage_channel_window_key
  on public.channel_performance (brokerage_id, channel_type, window_start, window_end);

-- VERIFY (expect one row, indexdef naming the four columns):
--   select indexname, indexdef from pg_indexes
--    where schemaname = 'public' and tablename = 'channel_performance'
--      and indexname = 'channel_performance_brokerage_channel_window_key';
--
-- ROLLBACK (owner SQL — DROP INDEX is owner-held): drop index if exists public.channel_performance_brokerage_channel_window_key;
-- Rolling back returns the writer to refusing every upsert (42P10); nothing else reads the index.
