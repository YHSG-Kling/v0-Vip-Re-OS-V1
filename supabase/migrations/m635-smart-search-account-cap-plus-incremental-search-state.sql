-- supabase/migrations/m635-smart-search-account-cap-plus-incremental-search-state.sql
-- ── APPLIED LIVE 2026-09-16 on hrvaqgvukzxfskkcrwbt via mcp apply_migration (m635_smart_search_cap_plus_incremental_search_state) ──
--
-- Lane 66B (wave 66). CLAUDE.md §1/§3: files are not the database.
--
-- PART A — widen batchdata_smart_search_subscriptions (m633) to the DOCUMENTED
-- V2 Property Subscription contract (help.batchdata.io, fetched 2026-09-16):
-- BatchData caps subscriptions at 5 PER ACCOUNT. Wave 65B's reconcile checked
-- only the current market's own rows and had no way to record "this territory
-- lost out to a higher-priority one" — the plan builder in
-- lib/external/batchdata-client.ts::buildSmartSearchSubscriptionPlan now
-- produces exactly that verdict and needs somewhere to write it. Also adds
-- `provisioning_required` for the documented "this account needs sales setup"
-- refusal, distinct from an ordinary transient error (never retried on the
-- same cadence as a network blip).
ALTER TABLE public.batchdata_smart_search_subscriptions
  DROP CONSTRAINT IF EXISTS batchdata_smart_search_subscriptions_status_check;

ALTER TABLE public.batchdata_smart_search_subscriptions
  ADD CONSTRAINT batchdata_smart_search_subscriptions_status_check
  CHECK (status IN ('pending', 'active', 'renewal_due', 'error', 'cancelled', 'deferred', 'provisioning_required'));

ALTER TABLE public.batchdata_smart_search_subscriptions
  ADD COLUMN IF NOT EXISTS priority integer;

COMMENT ON COLUMN public.batchdata_smart_search_subscriptions.status IS
  'pending|active|renewal_due|error|cancelled|deferred|provisioning_required. deferred = this (market,quicklist) lost the account-wide 5-subscription cap to a higher-priority territory this reconcile pass (see last_error for the reason); provisioning_required = BatchData refused the create as "not provisioned for Property Monitoring" (sales setup needed), never retried like an ordinary error.';
COMMENT ON COLUMN public.batchdata_smart_search_subscriptions.priority IS
  'Mirrors lead_scraping_markets.priority at the time this row was last reconciled — recorded on the row (not just re-derived) so an operator reading a deferred row can see WHY it lost, without joining back to a market whose priority may since have changed.';

-- PART B — INCREMENTAL PROPERTY SEARCH state (wave 66, task 2). A NEW TABLE,
-- not a jsonb column on lead_scraping_markets, for the same reason m633 is a
-- table and not a column: a market runs MULTIPLE incremental-search LANES
-- (one per motivated-seller trigger/quicklist) concurrently, and each needs
-- its own cursor and its own "does this token support Search Sessions" flag
-- (an account-wide token capability that, once learned false for one lane, is
-- true for all — but is stored per lane so a fresh token upgrade is detected
-- lane-by-lane rather than requiring a manual reset).
CREATE TABLE IF NOT EXISTS public.batchdata_incremental_search_state (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id         uuid NOT NULL REFERENCES public.lead_scraping_markets(id) ON DELETE CASCADE,
  -- One BatchData quickList slug (the "signal lane"), matching
  -- lib/kernel/listings-batchdata-feed.ts::runIncrementalPropertySearchForMarket's
  -- own `lane` parameter.
  lane              text NOT NULL,
  -- BatchData's opaque cursor for THIS (market, lane) search — signed and bound
  -- to the exact searchCriteria that produced it (documented). Feeds the next
  -- run's `options.pageCursor`. Null means "start a fresh page 1".
  page_cursor       text,
  -- False once a 403 naming Search Sessions has been observed for this
  -- account — lib/kernel/listings-batchdata-feed.ts then omits
  -- `options.searchSession` and pages plain skip/take instead. Defaults true
  -- (optimistic) so a provisioned token is used the first time it is tried.
  session_supported boolean NOT NULL DEFAULT true,
  results_found     integer,
  last_error        text,
  last_run_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_batchdata_incremental_search_state_market_lane
  ON public.batchdata_incremental_search_state (market_id, lane);

COMMENT ON TABLE public.batchdata_incremental_search_state IS
  'Cursor + Search-Session-capability state for the Incremental Property Search lane (lib/kernel/listings-batchdata-feed.ts::runIncrementalPropertySearchForMarket), one row per (lead_scraping_markets.id, quicklist lane). TABLE_MANAGER: cron_manager (reconciled inside the same daily lead-scraping tick as batchdata_smart_search_subscriptions). OPT-IN: only markets naming `batchdata_incremental` in enabled_sources ever write here.';

ALTER TABLE public.batchdata_incremental_search_state ENABLE ROW LEVEL SECURITY;
-- Platform-operational table (same posture as batchdata_smart_search_subscriptions
-- and scraper_executions) — service-role only, no tenant SELECT policy.
