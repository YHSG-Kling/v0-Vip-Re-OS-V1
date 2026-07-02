-- m256-lossless-property-specs.sql
--
-- LOSSLESS PROPERTY SPECS (Data Steward) — closes a real loss in the raw → leads → contacts spine.
-- The scrapers already capture property specs (BatchData building.bedroomCount / bathroomCount /
-- livingAreaSquareFeet + valuation.estimatedValue; the portal FSBO parsers capture price), but those
-- landed ONLY in raw_scraped_leads.raw_data / normalized_preview jsonb and were DROPPED at promotion —
-- leads had no spec columns at all, and contacts kept only property_records jsonb + home_value_estimate.
-- So every downstream matcher (investor off-market, retail buyer, market-watch) was blind to beds /
-- baths / sqft / value. This promotes them to first-class columns so the lossless_promotion charter
-- ("raw → leads → contacts without loss") actually holds for property facts.

alter table leads
  add column if not exists beds            integer,
  add column if not exists baths           numeric,
  add column if not exists sqft            integer,
  add column if not exists property_type   text,
  add column if not exists estimated_value numeric;   -- scraped AVM/estimated value (leads already has equity_estimate)

alter table contacts
  add column if not exists beds          integer,
  add column if not exists baths         numeric,
  add column if not exists sqft          integer,
  add column if not exists property_type text;         -- contacts already has home_value_estimate for value

comment on column leads.estimated_value is 'Scraped property AVM/estimated value (from raw_data valuation), promoted first-class for spec matching.';
