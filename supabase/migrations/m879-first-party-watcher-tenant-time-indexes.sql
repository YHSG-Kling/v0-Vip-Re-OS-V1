-- ── APPLIED LIVE 2026-10-29 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 146, lane 146D ──
--
-- m879 — TENANT × TIME INDEXES FOR THE FIRST-PARTY INTENT WATCHER (wave 146, lane 146D; owner ruling 11 "Enrichment should be
-- customer360 which drives the outreach")
--
-- lib/enrichment/first-party-intent-watcher.ts watchFirstPartyIntent runs on the 15-minute enrichment-processor tick, per tenant,
-- and reads each first-party family with ONE predicate shape: `brokerage_id = $tenant AND <time column> >= $cursor` (the 6-hour
-- overlapping cursor), then `brokerage_id = $tenant AND <party key> IN (…) AND <time column> < $cursor` for the dormancy check.
-- Measured on the live database 2026-10-29 (pg_indexes, read-only):
--   · client_portal_activity  — idx_client_portal_activity_brokerage_created (brokerage_id, created_at DESC)  ALREADY PRESENT
--   · saved_properties        — only (contact_id), (listing_id), (contact_id, interest_level), (user_id): no tenant × time index
--   · property_views          — only (contact_id), (last_viewed_at DESC), (property_id): no tenant × time index
--   · portal_access_logs      — (brokerage_id) and (contact_id, accessed_at DESC): no tenant × time index
--   · website_visitors        — (brokerage_id, first_seen_at), (session_id): the watcher reads last_seen_at
-- All four tables held 0 live rows at measurement (pg_stat_user_tables.n_live_tup), so the build is instant and no CONCURRENTLY
-- is needed; IF NOT EXISTS makes a re-apply a no-op. Nothing is dropped, no column / CHECK / FK / policy changes.
--
-- Schema caches: indexes are not in scripts/schema-snapshot.ts / schema-fk-map.ts / check-vocabularies.ts / live-tables.ts —
-- no regeneration is owed for this file.

CREATE INDEX IF NOT EXISTS idx_saved_properties_brokerage_saved_at
  ON public.saved_properties USING btree (brokerage_id, saved_at DESC);

CREATE INDEX IF NOT EXISTS idx_property_views_brokerage_last_viewed
  ON public.property_views USING btree (brokerage_id, last_viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_portal_access_logs_brokerage_accessed
  ON public.portal_access_logs USING btree (brokerage_id, accessed_at DESC);

CREATE INDEX IF NOT EXISTS idx_website_visitors_brokerage_last_seen
  ON public.website_visitors USING btree (brokerage_id, last_seen_at DESC);

-- ── VERIFY (integrator, after apply) ─────────────────────────────────────────────────────────────────────────────────────────────
-- select tablename, indexname from pg_indexes where schemaname = 'public' and indexname in (
--   'idx_saved_properties_brokerage_saved_at', 'idx_property_views_brokerage_last_viewed',
--   'idx_portal_access_logs_brokerage_accessed', 'idx_website_visitors_brokerage_last_seen');   -- expect 4 rows
-- ── ROLLBACK (owner SQL editor — DROP INDEX is owner-only by the wave rule) ────────────────────────────────────────────────────────
-- drop index if exists public.idx_saved_properties_brokerage_saved_at;
-- drop index if exists public.idx_property_views_brokerage_last_viewed;
-- drop index if exists public.idx_portal_access_logs_brokerage_accessed;
-- drop index if exists public.idx_website_visitors_brokerage_last_seen;
