-- supabase/migrations/m642-active-listing-source-order.sql
--
-- ── APPLIED LIVE 2026-09-16 on hrvaqgvukzxfskkcrwbt via mcp apply_migration (m642_active_listing_source_order) ──
--
-- Lane 68B (wave 68). Owner question verbatim (2026-09-16): "that is a lot of money to spend for
-- leads, is the rentcast with optional idx broker a better implementation for the smart search
-- buyer criteria of on the market active property listings?"
--
-- RESEARCHED (docs/lead-acquisition-coverage-2026-09.md "Active-listing source ranking for
-- regular buyers"): RentCast bills per REQUEST (a page of listings per call), IDX Broker costs
-- the platform nothing (the brokerage's own MLS credential), BatchData's on-market quicklist
-- pull bills per RECORD and must re-walk every active listing each cycle to detect status
-- transitions — for the identical 3-market/200-listing/day workload that is 20x-100x RentCast's
-- cost. DECISION: regular buyers' active-listing smart search source order is IDX (when the
-- brokerage has credentials) -> RentCast -> BatchData on-market quicklist ONLY when a brokerage
-- opts in (cost reason, default OFF). BatchData stays PRIMARY for acquisition (motivated sellers,
-- off-market, Property Monitoring) — that is what it is priced for, and RentCast/IDX have no
-- off-market dataset at all.
--
-- This is an ORDERED LIST, not a set of booleans, because "IDX first, then RentCast" is itself
-- part of the ruling (lib/property/listing-source.ts already encodes the SAME idea for the
-- external-listings-search router; this column lets a brokerage narrow or reorder within the
-- regular-buyer smart-search lane specifically — e.g. an all-IDX shop that never wants the
-- platform's RentCast spent on them can list just `["idx"]`).
--
-- Reader: lib/buyer-search/listing-source-order.ts::resolveActiveListingSources(brokerageId) —
-- the ONE resolver; normalizes unknown values away and falls back to the default array when the
-- column is missing/empty/malformed. Consumers: lib/buyer-search/market-watch.ts
-- (runMarketWatchForBuyer — market_active_listings on-market feed), lib/buyer-search/
-- external-match.ts (runExternalMarketWatchForBuyer — IDX/RentCast via searchExternalListings),
-- lib/kernel/listings-batchdata-feed.ts (runActiveListingDiscoveryForMarket skips the billed
-- on-market pull entirely when a brokerage's list excludes "batchdata_on_market").

ALTER TABLE public.brokerage_settings
  ADD COLUMN IF NOT EXISTS active_listing_sources jsonb NOT NULL DEFAULT '["idx","rentcast"]'::jsonb;

ALTER TABLE public.brokerage_settings
  DROP CONSTRAINT IF EXISTS brokerage_settings_active_listing_sources_is_array;

ALTER TABLE public.brokerage_settings
  ADD CONSTRAINT brokerage_settings_active_listing_sources_is_array
    CHECK (jsonb_typeof(active_listing_sources) = 'array');

COMMENT ON COLUMN public.brokerage_settings.active_listing_sources IS
  'Ordered list of active-listing sources for REGULAR BUYERS'' smart search (wave 68 owner ruling
   — see docs/lead-acquisition-coverage-2026-09.md). Allowed values: "idx" | "rentcast" |
   "batchdata_on_market". Default ["idx","rentcast"] excludes the billed BatchData on-market
   quicklist pull (cost reason — brokerage opts in explicitly by adding "batchdata_on_market").
   Read ONLY through lib/buyer-search/listing-source-order.ts::resolveActiveListingSources — never
   a second reader. Investor-persona contacts are unaffected (they are served exclusively by the
   off-market BatchData rail, lib/buyer-search/investor-offmarket-runner.ts, which this setting
   does not gate).';
