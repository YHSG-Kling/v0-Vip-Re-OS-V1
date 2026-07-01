-- m255-cash-buyer-matches.sql
--
-- CASH-BUYER DISPOSITION MATCH — the disposition bookend of the wholesale funnel (shopping_agent).
-- The app scrapes MOTIVATED SELLERS (probate, pre-foreclosure, tired-landlord, tax-lien) which become
-- distressed / as-is / hard-to-finance listings. Retail-buyer matching (reverse-prospecting) can't move
-- those — a financed retail buyer won't touch a teardown, and reverse-prospecting explicitly excludes
-- contact_type='investor'. This closes the loop: a hard property is matched to nearby CASH INVESTORS
-- (landlords, flippers, builders) sourced live from BatchData's investor-buybox — who they are, what
-- they've bought in the box, why they fit — so the agent can move it FAST. No competitor
-- (RealScout / Lofty / Rave) matches a property to cash investors — they do retail buyers only.
--
-- ONE table (candidates jsonb, mirroring buyer_move_cases). Nothing auto-sends: the ranked list is
-- agent-facing intelligence; the agent stages a gated outreach. Note: "disposition" already means CDA
-- routing elsewhere in this codebase (lib/platform/disposition-route.ts) — this is named cash-buyer to
-- avoid that drift.

create table if not exists cash_buyer_matches (
  id                    uuid primary key default gen_random_uuid(),
  brokerage_id          uuid not null,
  listing_id            uuid,                         -- nullable: an off-market subject property can match too
  subject_street        text not null,
  subject_city          text,
  subject_state         text,
  subject_zip           text,
  subject_beds          integer,
  subject_baths         numeric,
  subject_sqft          integer,
  subject_year_built    integer,
  subject_property_type text,
  status                text not null default 'active'
                          check (status in ('active','outreach_staged','archived')),
  match_source          text not null default 'batchdata_investor_buybox',
  candidate_count       integer not null default 0,
  candidates            jsonb not null default '[]'::jsonb,  -- ranked RankedInvestor[] (name, class, holdings, score, reasons)
  last_matched_at       timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- One live match per listing (idempotent re-match updates in place); off-market subjects (listing_id
-- null) are deduped by address in the runner.
create unique index if not exists idx_cash_buyer_matches_listing on cash_buyer_matches (listing_id) where listing_id is not null;
create index if not exists idx_cash_buyer_matches_brokerage on cash_buyer_matches (brokerage_id);

comment on table cash_buyer_matches is
  'Cash-buyer disposition match (shopping_agent): a distressed/hard-to-finance property matched to nearby CASH INVESTORS via BatchData investor-buybox. candidates jsonb = ranked investors; nothing auto-sends — the agent stages a gated outreach.';
