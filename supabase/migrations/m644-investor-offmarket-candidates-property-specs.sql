-- supabase/migrations/m644-investor-offmarket-candidates-property-specs.sql
--
-- ── APPLIED LIVE 2026-09-17 on hrvaqgvukzxfskkcrwbt via mcp apply_migration (m644_investor_offmarket_candidates_property_specs) ──
--
-- Lane 69B (wave 69). Owner ruling verbatim (2026-09-17): "investor buyers portal persona is
-- different than the regular real estate buyer… if it is for the investor with giving them just
-- off market but most likely to sell, that is just showing them the properties nothing else."
--
-- The investor portal card is PROPERTY-ONLY: address, city/state/zip, estimated value, beds/baths/
-- property type, quicklist tags and a likelihood band — never owner identity, never equity
-- percentage (lib/buyer-search/investor-facing.ts's redaction list, wave 69). None of those three
-- property specs (beds, baths, property_type) had a column on investor_offmarket_candidates (m638's
-- CREATE TABLE names none of them) — the runner
-- (lib/buyer-search/investor-offmarket-runner.ts::toOffMarketCandidateRow) already reads
-- BatchDataRecord.beds/.baths/.propertyType to build its OffMarketProperty SCORING shape (property
-- type and bed-count already feed scoreOffMarketFit's soft nudges), but none of the three made it
-- onto the PERSISTED row — computed for the scorer and then dropped on the floor between the scorer
-- and the table, never actually written.
--
-- No existing table fits (orphan doctrine §1, checked first): these are ADDITIVE columns on the
-- SAME m638 table this candidate already lives in — a new table for two nullable specs on an
-- existing per-candidate row would just be a second store for facts about the same row.
--
-- likelihood_band is DELIBERATELY NOT a column here: lib/buyer-search/investor-offmarket-match.ts::
-- deriveLikelihoodBand is a PURE function of columns this table ALREADY has (quicklists,
-- batchrank_band, both m638/m641) — computing it at read time means it can never drift from the
-- quicklists it is derived from, and a schema change to the quicklist vocabulary needs no migration
-- to keep the band honest.
--
-- TABLE_MANAGER: shopping_agent (unchanged — lib/kernel/manager-registry.ts, same owner as m638/m641).

ALTER TABLE public.investor_offmarket_candidates
  ADD COLUMN IF NOT EXISTS beds integer,
  ADD COLUMN IF NOT EXISTS baths numeric,
  ADD COLUMN IF NOT EXISTS property_type text;

COMMENT ON COLUMN public.investor_offmarket_candidates.beds IS
  'Wave 69 — BatchDataRecord.beds, the same lossless-promoted spec OffMarketProperty.beds already carries for scoring (lib/buyer-search/investor-offmarket-match.ts). Nullable: the record may not have carried a bed count. Read by getInvestorOffMarketCandidates + the investor portal property card (property-only fields, wave 69 owner ruling).';
COMMENT ON COLUMN public.investor_offmarket_candidates.baths IS
  'Wave 69 — BatchDataRecord.baths. Nullable, numeric (BatchData can report a half-bath). Same reader as beds.';
COMMENT ON COLUMN public.investor_offmarket_candidates.property_type IS
  'Wave 69 — BatchDataRecord.propertyType (e.g. "Single Family", "Condo"). Nullable. Same reader as beds/baths; also the property-type facet the investor portal card and lib/buyer-search/investor-offmarket-match.ts::scoreOffMarketFit''s soft property-type nudge already reason about.';
