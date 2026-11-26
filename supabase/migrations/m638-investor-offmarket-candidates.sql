-- supabase/migrations/m638-investor-offmarket-candidates.sql
--
-- ── APPLIED LIVE 2026-09-16 on hrvaqgvukzxfskkcrwbt via mcp apply_migration (m638_investor_offmarket_candidates) ──
--
-- Lane 67B (wave 67). Owner ruling verbatim (2026-09-16): "make sure that with a buyer who we
-- know is an investor intent, that we are giving them off market listings to assist with their
-- searching."
--
-- NEW table — the BatchData off-market rail's OWN provenance store, distinct from
-- investor_deal_matches (m255, one row per investor aggregating OUR scraped lead/contact
-- inventory as a candidates jsonb blob). This table is per-CANDIDATE-PROPERTY, carrying the
-- BatchData-specific facts (quicklists, equity%, owner name) that the scraped-inventory match
-- has no source for, and a delivery/dismissal lifecycle (delivered_at/delivered_via/dismissed_at)
-- the aggregate blob has no room to track per-property. No existing table fits (orphan doctrine
-- §1, checked first): investor_deal_matches is one-row-per-investor with candidates as an opaque
-- jsonb array (no per-row delivery tracking); market_active_listings (m636) is the REGULAR-BUYER
-- on-market feed and its own CHECK forbids off-market statuses.
--
-- TABLE_MANAGER: shopping_agent (lib/kernel/manager-registry.ts) — same owner as
-- investor_deal_matches / property_preferences, the buyer-side matching domain.
CREATE TABLE IF NOT EXISTS public.investor_offmarket_candidates (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id       uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  contact_id         uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  -- The lead_scraping_markets territory this candidate was pulled for (territory-centric —
  -- CLAUDE.md wave 65/67 ruling). Nullable ON DELETE SET NULL: a market can be retired/renamed
  -- without orphan-deleting the candidates it once produced (the property fact stays true).
  market_id          uuid REFERENCES public.lead_scraping_markets(id) ON DELETE SET NULL,
  -- normalizeStreetAddress(propertyAddress) — the SAME address vocabulary
  -- lib/external/permit-signals.ts / lib/kernel/listings-batchdata-feed.ts already key on.
  address_key        text NOT NULL,
  property_address   text NOT NULL,
  city               text,
  state              text,
  zip                text,
  -- The BatchData quickLists this candidate matched on this pull (absentee-owner, high-equity,
  -- tired-landlord, vacant, preforeclosure, inherited — INVESTOR_OFFMARKET_QUICKLISTS in
  -- lib/external/batchdata-client.ts). NEVER an on-market slug — enforced in code, not the CHECK
  -- below (an owner-occupied on-market listing can still legitimately carry a distress quicklist
  -- like high-equity at the same time; the CODE decides which quicklist WON this pull, the CHECK
  -- only guards the column shape).
  quicklists         jsonb NOT NULL DEFAULT '[]'::jsonb,
  estimated_value    numeric,
  equity_percent     numeric,
  owner_name         text,
  -- scoreOffMarketFit's 0..1 fit score (investor-offmarket-match.ts) — the SAME pure engine the
  -- scraped-inventory rail scores with (one vocabulary, §6).
  fit_score          numeric NOT NULL DEFAULT 0,
  matched_at         timestamptz NOT NULL DEFAULT now(),
  delivered_at       timestamptz,
  delivered_via      text,
  dismissed_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (contact_id, address_key)
);

CREATE INDEX IF NOT EXISTS idx_investor_offmarket_candidates_contact
  ON public.investor_offmarket_candidates (contact_id, fit_score DESC);
CREATE INDEX IF NOT EXISTS idx_investor_offmarket_candidates_brokerage
  ON public.investor_offmarket_candidates (brokerage_id);

COMMENT ON TABLE public.investor_offmarket_candidates IS
  'BatchData OFF-MARKET candidates matched to an investor-intent contact''s buy-box (wave 67, owner ruling on investor off-market delivery). One row per (contact, address) — dedupe on that pair. Written by lib/buyer-search/investor-offmarket-runner.ts::pullAndPersistBatchDataOffMarketCandidates, read by getInvestorOffMarketCandidates + the InvestorDealsPanel portal surface. TABLE_MANAGER: shopping_agent. Never populated from an on-market quicklist — that is market_active_listings (m636), the regular-buyer rail.';

ALTER TABLE public.investor_offmarket_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY investor_offmarket_candidates_tenant_select ON public.investor_offmarket_candidates
  FOR SELECT USING (brokerage_id = public.current_user_brokerage_id());
-- Writes are service-role only (the runner + cron), matching investor_deal_matches and every
-- other BatchData-sourced table in this repo.
