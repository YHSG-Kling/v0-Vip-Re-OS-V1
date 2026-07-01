-- m255-investor-deal-matches.sql
--
-- INVESTOR OFF-MARKET DEAL FINDER (shopping_agent) — the buyer-side match no competitor has.
-- The funnel: a scraped raw lead → promotion gate → lead → the AI ISA QUALIFIES it → a CONTACT is
-- created from exhibited interest. A qualified INVESTOR is therefore a BUYER who showed intent and
-- carries a buy-box (property_preferences). Regular buyers are matched to MLS (on-market) inventory by
-- the existing retail matchers (market-watch / external-match / reverse-prospecting). INVESTOR buyers
-- need the opposite: OFF-MARKET inventory — and the platform already scraped a pool of it (motivated
-- sellers: probate / pre-foreclosure / tax-lien / tired-landlord / absentee / high-equity leads).
--
-- This matches a qualified investor's buy-box against OUR scraped OFF-MARKET / motivated-seller `leads`
-- that fit their geography + distress profile, and ranks them for the agent. ONE row per investor
-- contact (candidates jsonb), refreshed in place. Owned by the Shopping Agent (buyer-side matching);
-- nothing auto-sends — the agent reviews the deals before acting. RealScout / Lofty / Rave match buyers
-- to MLS listings only; none surface off-market distressed inventory to an investor's box.

create table if not exists investor_deal_matches (
  id                uuid primary key default gen_random_uuid(),
  brokerage_id      uuid not null,
  contact_id        uuid not null,                -- the qualified INVESTOR buyer
  agent_id          uuid,
  status            text not null default 'active' check (status in ('active','archived')),
  candidate_count   integer not null default 0,
  candidates        jsonb not null default '[]'::jsonb,  -- ranked off-market property matches (leadId, address, motivation, score, reasons)
  last_matched_at   timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- One live match set per investor contact (a re-run refreshes it in place).
create unique index if not exists idx_investor_deal_matches_contact on investor_deal_matches (contact_id);
create index if not exists idx_investor_deal_matches_brokerage on investor_deal_matches (brokerage_id);

comment on table investor_deal_matches is
  'Investor off-market deal finder (shopping_agent): a QUALIFIED INVESTOR buyer''s buy-box (property_preferences) matched to OUR scraped OFF-MARKET / motivated-seller leads that fit. candidates jsonb = ranked off-market properties. Regular buyers get MLS matches; investors get off-market. Nothing auto-sends — the agent reviews.';
