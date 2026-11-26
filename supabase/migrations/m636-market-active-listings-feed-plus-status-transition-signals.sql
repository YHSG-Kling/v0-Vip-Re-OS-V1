-- supabase/migrations/m636-market-active-listings-feed-plus-status-transition-signals.sql
-- ── APPLIED LIVE 2026-09-16 on hrvaqgvukzxfskkcrwbt via mcp apply_migration (m636_market_active_listings_feed_plus_status_transition_signals) ──
--
-- Lane 66B (wave 66). CLAUDE.md §1/§3: files are not the database.
--
-- PART A — a NEW listings-feed table for the ACTIVE-LISTING DISCOVERY lane
-- (owner, verbatim: "Batchdata also allows you to find properties that are
-- active and other new features… enhance our lead acquisition, enrichment
-- and listing providing"). No existing table fits (orphan doctrine §1 —
-- checked before building): `public.listings` is the TENANT's OWN inventory
-- (agent_id/seller_contact_id/etc — a listing this brokerage represents), and
-- `market_data`/`market_trends` are AGGREGATE per-zip statistics, never a
-- per-property row. This table is per-PROPERTY, market-wide, and remembers
-- its own last-observed status so
-- lib/kernel/listings-batchdata-feed.ts::runActiveListingDiscoveryForMarket can
-- detect a TRANSITION (this pass's status differing from last pass's) rather
-- than only ever re-reporting a snapshot.
CREATE TABLE IF NOT EXISTS public.market_active_listings (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id             uuid NOT NULL REFERENCES public.lead_scraping_markets(id) ON DELETE CASCADE,
  brokerage_id          uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  -- normalizeStreetAddress(propertyAddress) — the SAME address vocabulary
  -- lib/external/permit-signals.ts and lib/external/batchdata-seller-signals.ts
  -- already key on, so a feed row and a lead/contact match on one spelling.
  address_key           text NOT NULL,
  property_address      text NOT NULL,
  city                  text,
  state                 text,
  zip                   text,
  current_status        text NOT NULL CHECK (current_status IN ('active', 'expired', 'withdrawn', 'sold')),
  list_price            numeric,
  batchdata_quicklists  jsonb NOT NULL DEFAULT '[]'::jsonb,
  last_seen_at          timestamptz NOT NULL DEFAULT now(),
  last_status_change_at timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_market_active_listings_market_address
  ON public.market_active_listings (market_id, address_key);

CREATE INDEX IF NOT EXISTS idx_market_active_listings_brokerage_status
  ON public.market_active_listings (brokerage_id, current_status);

COMMENT ON TABLE public.market_active_listings IS
  'BatchData active-listing discovery feed: one row per (lead_scraping_markets.id, property address) the on-market quicklist has ever surfaced for that territory, remembering its last-observed MLS status so a TRANSITION (active->expired/withdrawn/sold) can be detected pass-over-pass. Feeds shopping_agent / listing_concierge market-inventory awareness AND, when a transitioned address matches a lead/contact this brokerage already has on file, a motivated_seller_signals row (see PART B). TABLE_MANAGER: listing_concierge (the inventory-awareness consumer), reconciled inside the daily lead-scraping cron tick.';

ALTER TABLE public.market_active_listings ENABLE ROW LEVEL SECURITY;
CREATE POLICY market_active_listings_tenant_select ON public.market_active_listings
  FOR SELECT USING (brokerage_id = public.current_user_brokerage_id());
-- Writes are service-role only (the cron tick), matching every other scraper table.

-- PART B — widen the seller-signal dedupe index (m632's list) by the three
-- STATUS-TRANSITION signal types wave 66 adds to
-- lib/external/batchdata-seller-signals.ts (EXPIRED_LISTING_SIGNAL_TYPE=
-- 'expired_listing', WITHDRAWN_LISTING_SIGNAL_TYPE='withdrawn',
-- SOLD_LISTING_SIGNAL_TYPE='sold'). Same lesson as every migration before it
-- on this index (m490/m499/m514/m517/m520/m521/m632): a signal_type declared
-- in code and NOT added here carries NO uniqueness rule at all, and a
-- repeating daily active-listing sweep re-files the same unchanged transition
-- every pass. `active_listing` is already covered by m632's list and needs no
-- re-adding.
--
-- RE-MEASURE BEFORE APPLYING (same note as m632): confirm
-- `select count(*) from motivated_seller_signals` is still low enough for a
-- plain DROP+CREATE rather than CREATE INDEX CONCURRENTLY.
DROP INDEX IF EXISTS public.motivated_seller_signals_external_dedupe;

CREATE UNIQUE INDEX motivated_seller_signals_external_dedupe
  ON public.motivated_seller_signals
  USING btree (signal_type, ((signal_details ->> 'dedupe_key'::text)))
  WHERE ((signal_type = ANY (ARRAY[
            'permit_activity'::text,
            'code_violation'::text,
            'sale_propensity'::text,
            'preforeclosure'::text,
            'tax_delinquent'::text,
            'involuntary_lien'::text,
            'vacancy'::text,
            'absentee_owner'::text,
            'tired_landlord'::text,
            'listing_withdrawn'::text,
            'high_equity'::text,
            'market_timing'::text,
            'for_sale_by_owner'::text,
            'listed_below_market'::text,
            'corporate_owned'::text,
            'fix_and_flip'::text,
            'vacant_lot'::text,
            'active_listing'::text,
            'trust_owned'::text,
            'inherited_property'::text,
            'senior_owner'::text,
            'recent_divorce'::text,
            'household_outgrown'::text,
            'cash_buyer'::text,
            'expired_listing'::text,
            'withdrawn'::text,
            'sold'::text
         ]))
         AND (signal_details ? 'dedupe_key'::text));

COMMENT ON INDEX public.motivated_seller_signals_external_dedupe IS
  'One signal per (signal_type, dedupe_key) for every EXTERNAL seller-signal sweep. m636 widens m632''s list by expired_listing/withdrawn/sold, the active-listing-monitor STATUS-TRANSITION types (wave 66). The `signal_details ? dedupe_key` predicate stays deliberate — see m632''s own comment.';
