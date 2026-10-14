-- supabase/migrations/m633-batchdata-smart-search-subscriptions.sql
-- ── APPLIED LIVE 2026-09-15 on hrvaqgvukzxfskkcrwbt via mcp apply_migration (m633_batchdata_smart_search_subscriptions) ──
--
-- Lane 65B (wave 65). CLAUDE.md §1/§3: files are not the database.
--
-- WHAT THIS DOES: gives the Smart Search (V2 Property Subscription) capability
-- somewhere to persist what it registered. lib/external/batchdata-client.ts::
-- createOrRenewSmartSearchSubscription creates ONE subscription per
-- (territory, quicklist) pair; without a tracking row, the daily reconcile
-- step (app/api/cron/lead-scraping/route.ts) has no way to tell "already
-- subscribed, skip" from "never subscribed, create" and would re-create a
-- subscription every run — the same repeating-probe defect m490/m499/m514/
-- m517/m520/m521/m632 name for the seller-signal dedupe index, here for the
-- outbound registration instead of the inbound signal.
--
-- A NEW TABLE (not a jsonb column on lead_scraping_markets) because a market
-- can run MULTIPLE quicklist subscriptions at once (fsbo + preforeclosure +
-- tax-default are independent Smart Search registrations, not one combined
-- search) and each needs its own renewal clock and error state.

CREATE TABLE IF NOT EXISTS public.batchdata_smart_search_subscriptions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id         uuid NOT NULL REFERENCES public.lead_scraping_markets(id) ON DELETE CASCADE,
  -- One BatchData quickList slug per subscription (validated against
  -- BATCHDATA_QUICKLISTS in lib/external/batchdata-client.ts at write time —
  -- no CHECK constraint here so the provider's catalogue can grow without a
  -- migration, matching lead_scraping_markets.enabled_sources's own posture).
  quicklist         text NOT NULL,
  -- BatchData's id for the subscription, read back from their create response.
  subscription_id   text,
  status            text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'active', 'renewal_due', 'error', 'cancelled')),
  webhook_url       text NOT NULL,
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  last_reconciled_at timestamptz,
  renewed_at        timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- One live subscription per (market, quicklist) — the same fact m514/m517's
-- lesson protects on the read side: without this, a reconcile run that races
-- itself (two cron invocations overlapping) could register the same criteria
-- twice and BatchData would push every match twice into the webhook receiver.
CREATE UNIQUE INDEX IF NOT EXISTS idx_batchdata_smart_search_subscriptions_market_quicklist
  ON public.batchdata_smart_search_subscriptions (market_id, quicklist);

CREATE INDEX IF NOT EXISTS idx_batchdata_smart_search_subscriptions_status
  ON public.batchdata_smart_search_subscriptions (status)
  WHERE status IN ('pending', 'renewal_due', 'error');

COMMENT ON TABLE public.batchdata_smart_search_subscriptions IS
  'Outbound BatchData V2 Property Subscription (Smart Search) registrations, one row per (lead_scraping_markets.id, quicklist). Reconciled/renewed by the BatchData branch of app/api/cron/lead-scraping/route.ts; deliveries land at app/api/webhooks/batchdata-smart-search/route.ts. TABLE_MANAGER: cron_manager (owns the reconcile tick), per lib/kernel/manager-registry.ts convention — the integrator adds the MAINTENANCE_DOMAINS entry.';

-- RLS: platform-owned operational table (subscriptions are registered against
-- PLATFORM territories, brokerageId: null, same posture as raw_scraped_leads
-- rows the webhook receiver ingests) — service-role only, no tenant SELECT
-- policy, matching scraper_executions / lead_scraping_markets' own posture.
ALTER TABLE public.batchdata_smart_search_subscriptions ENABLE ROW LEVEL SECURITY;
