-- supabase/migrations/m639-market-active-listings-criteria-specs.sql
--
-- ── APPLIED LIVE 2026-09-16 on hrvaqgvukzxfskkcrwbt via mcp apply_migration (m639_market_active_listings_criteria_specs) ──
--
-- Lane 67B (wave 67). Owner ruling verbatim (2026-09-16): "smart search is also to help regular
-- buyers find properties with their known criteria… sending them active for sale listings. How
-- are we handling these in regards to sending them active for sale listings."
--
-- market_active_listings (m636) carries list_price but no beds/baths/sqft/property_type, so
-- lib/buyer-search/market-watch.ts::runMarketWatchForBuyer could not run a REAL criteria-fit score
-- (scoreCriteriaFit) against this feed — only a price filter, never a bedroom/bathroom match. This
-- adds the four spec columns BatchData's Property Search already returns per property (building.*
-- — see lib/external/batchdata-client.ts::normalizeBatchDataProperty), nullable (a feed row from a
-- pull that didn't carry building specs stays honest, never a fabricated 0).
ALTER TABLE public.market_active_listings
  ADD COLUMN IF NOT EXISTS beds          integer,
  ADD COLUMN IF NOT EXISTS baths         numeric,
  ADD COLUMN IF NOT EXISTS sqft          integer,
  ADD COLUMN IF NOT EXISTS property_type text;

COMMENT ON COLUMN public.market_active_listings.beds IS
  'BatchData building.bedroomCount at last discovery pass. Nullable — a pull that returned no building specs never backfills a fabricated 0. Written by lib/kernel/listings-batchdata-feed.ts::runActiveListingDiscoveryForMarket; read by lib/buyer-search/market-watch.ts::runMarketWatchForBuyer (scoreCriteriaFit) and app/actions/lead-scraping-config.ts::getBatchDataFeedStatus (the admin markets panel).';
COMMENT ON COLUMN public.market_active_listings.baths IS
  'BatchData building.bathroomCount. Same nullability + reader set as beds.';
COMMENT ON COLUMN public.market_active_listings.sqft IS
  'BatchData building.livingAreaSquareFeet. Informational (no current criteria-fit dimension uses square footage) — surfaced on the admin markets panel.';
COMMENT ON COLUMN public.market_active_listings.property_type IS
  'BatchData building.propertyType (e.g. Single Family, Condo). Same nullability + reader set as beds.';
