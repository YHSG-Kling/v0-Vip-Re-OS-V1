-- supabase/migrations/m637-batchdata-smart-search-pooled-by-quicklist.sql
-- ── APPLIED LIVE 2026-09-16 on hrvaqgvukzxfskkcrwbt via mcp apply_migration (m637_batchdata_smart_search_pooled_by_quicklist) ──
--
-- Lane 67A (wave 67). CLAUDE.md §1/§3: files are not the database.
--
-- WHAT THIS DOES: widens batchdata_smart_search_subscriptions (m633, m635) so a row
-- can record POOLED membership. Owner ruling (wave 67, "how can we get around the
-- caps" — help.batchdata.io / batchdata.io/pricing, 2026-09-16): BatchData caps
-- Property Subscription at 5 PER ACCOUNT. The wave-66 reconcile spent that cap one
-- (market × quicklist) pair at a time — as few as 5 territories exhausted it
-- platform-wide. lib/external/batchdata-client.ts::buildSmartSearchSubscriptionPlan
-- + the app/api/cron/lead-scraping/route.ts step 2b reconcile now POOL by QUICKLIST:
-- every active territory wanting a given quicklist shares ONE subscription whose
-- searchCriteria.query is the union of their geographies, so 5 slots cover 5
-- QUICKLISTS platform-wide regardless of how many territories want each one.
--
-- Every territory that contributes to a pooled subscription still gets its OWN row
-- (one per market_id, same as before — the existing UNIQUE (market_id, quicklist)
-- index from m633 is unchanged) so the per-territory admin UI
-- (app/dashboard/admin/markets/markets-client.tsx via
-- app/actions/lead-scraping-config.ts::getBatchDataFeedStatus) keeps reading one row
-- per territory; these three new columns are what let it also show that the row is
-- part of a shared pool rather than its own private subscription.

ALTER TABLE public.batchdata_smart_search_subscriptions
  ADD COLUMN IF NOT EXISTS pool_key text,
  ADD COLUMN IF NOT EXISTS pooled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS geography_count integer;

COMMENT ON COLUMN public.batchdata_smart_search_subscriptions.pool_key IS
  'The pooling key every membership row sharing this quicklist''s subscription carries — currently always equal to `quicklist` (pooling is BY QUICKLIST platform-wide), kept as its own column rather than reusing `quicklist` so a future narrower pool (e.g. by quicklist+region) does not require a rename. NULL on a row written before m637 or on a non-pooled row.';

COMMENT ON COLUMN public.batchdata_smart_search_subscriptions.pooled IS
  'true when subscription_id is a POOLED subscription (searchCriteria.query is the union of every contributing territory''s geography — lib/external/batchdata-client.ts::buildPooledSmartSearchQuery) rather than one territory''s own single-geography subscription. Every row written by the wave-67 reconcile sets this true; false is the pre-m637 (wave 65B/66) shape, read defensively by any caller that has not re-reconciled yet.';

COMMENT ON COLUMN public.batchdata_smart_search_subscriptions.geography_count IS
  'How many territories were folded into this quicklist''s pooled query as of the last reconcile — recorded on EVERY membership row for that quicklist (not just one), so a UI reading a single row can show "this subscription covers N territories" without joining the other membership rows, and so the reconcile can detect membership DRIFT (a territory joined or left the pool since last time) by comparing this stored count against the current want-count before deciding whether the immutable subscription must be deleted and recreated.';

-- Index for "every row in this pool" lookups (the admin feed panel, and the
-- reconcile's own drift detection) without a market_id filter.
CREATE INDEX IF NOT EXISTS idx_batchdata_smart_search_subscriptions_pool_key
  ON public.batchdata_smart_search_subscriptions (pool_key)
  WHERE pool_key IS NOT NULL;
