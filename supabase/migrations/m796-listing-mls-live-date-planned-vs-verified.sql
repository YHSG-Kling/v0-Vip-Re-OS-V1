-- WRITTEN, NOT APPLIED (wave 143, lane 143A) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN are owner SQL-editor
--
-- m796 — THE MLS LIVE DATE: PLANNED vs VERIFIED, ON THE CANONICAL LISTING ROW (wave 143, lane 143A).
--
-- Owner, verbatim (wave 143): "Listing intake needs a column for the MLS live date."
-- Brief: distinguish the PLANNED MLS live date, the ACTUAL MLS live/publish date (verified from MLS/IDX only),
-- the listing-agreement execution date and the coming-soon/marketing status; carry the brokerage/property
-- timezone; never present planned as verified.
--
-- AUDIT FIRST (CLAUDE.md §1 — extend the survivor, build only the missing half):
--   · listings.go_live_date (date)             EXISTS — 20+ readers (DOM, the lifecycle timeline, the compliance
--                                              loop's MLS_DATE_CONFIRMED hop). It is the PLANNED MLS live date.
--                                              Until wave 143 markAgreementSigned also wrote TODAY's date into it at
--                                              signature (an invented placeholder); it no longer does.
--   · listings.go_live_confirmed_at (timestamptz) EXISTS with ZERO writers and ZERO readers (live column, no
--                                              migration file in the tree). It is the survivor for "when a feed
--                                              confirmed the listing live"; the missing half — the WRITER — is built
--                                              (lib/listings/mls-live-date.ts::recordVerifiedMlsLive).
--   · listing-agreement execution date         EXISTS: listing_agreements.fully_executed_at (stamped at the ladder's
--                                              fully_executed hop, after compliance approval — wave 143).
--   · coming-soon / marketing status           EXISTS: the stage machine (COMING_SOON_PREP …) and the gated status
--                                              'coming_soon'. Not a date; no column added.
--   · listings.listing_date (date)             EXISTS, ~20 legacy readers; written by launchListing as the day the
--                                              agent pressed Launch (an agent assertion). Left alone; its readers are
--                                              listed in the lane notes for the surfaces that own them.
-- A column named mls_date_confirmed does NOT exist (the brief's guess); go_live_confirmed_at is the survivor.
--
-- WHAT THIS ADDS (all nullable, no backfill — an existing row has no feed evidence, and fabricating it would be
-- exactly the lie this migration exists to prevent):
--   · mls_live_date_actual   date  — the day the feed shows the listing live (the feed's own list date when it
--                                    carries one, else the first day we saw it live).
--   · mls_live_date_basis    text  — feed_list_date | first_observed (how mls_live_date_actual was read).
--   · go_live_confirmed_source text — rentcast | idx (WHICH feed said so; the only two the brokerage already pays for).
--   · mls_live_timezone      text  — IANA zone the date columns are calendar days in (the property's market, resolved
--                                    from the property's state or the brokerage setting; validated in code).
-- plus ONE table CHECK that makes "planned shown as verified" unrepresentable: an actual date cannot exist without
-- its evidence (confirmation instant + source + basis).
--
-- Applicable in two small parts (wave 98 rule). Idempotent. Non-destructive (ADD COLUMN IF NOT EXISTS; the CHECKs
-- are added NOT VALID-free because every existing row has mls_live_date_actual NULL, which satisfies them).

-- ── PART 1 — columns + CHECKs ──────────────────────────────────────────────────────────────────────
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS mls_live_date_actual date,
  ADD COLUMN IF NOT EXISTS mls_live_date_basis text,
  ADD COLUMN IF NOT EXISTS go_live_confirmed_source text,
  ADD COLUMN IF NOT EXISTS mls_live_timezone text;

ALTER TABLE public.listings
  DROP CONSTRAINT IF EXISTS listings_mls_live_date_basis_check,
  ADD CONSTRAINT listings_mls_live_date_basis_check
    CHECK (mls_live_date_basis IS NULL OR mls_live_date_basis IN ('feed_list_date', 'first_observed'));

ALTER TABLE public.listings
  DROP CONSTRAINT IF EXISTS listings_go_live_confirmed_source_check,
  ADD CONSTRAINT listings_go_live_confirmed_source_check
    CHECK (go_live_confirmed_source IS NULL OR go_live_confirmed_source IN ('rentcast', 'idx'));

ALTER TABLE public.listings
  DROP CONSTRAINT IF EXISTS listings_mls_live_actual_has_evidence_check,
  ADD CONSTRAINT listings_mls_live_actual_has_evidence_check
    CHECK (
      mls_live_date_actual IS NULL
      OR (go_live_confirmed_at IS NOT NULL AND go_live_confirmed_source IS NOT NULL AND mls_live_date_basis IS NOT NULL)
    );

-- ── PART 2 — documentation on the columns + the sweep's index ──────────────────────────────────────
COMMENT ON COLUMN public.listings.go_live_date IS
  'PLANNED MLS live date (calendar day in mls_live_timezone), typed by a person — never verified, may be in the future. The verified date is mls_live_date_actual. Read through lib/listings/compute-dom.ts resolveMlsLiveDates. (m796, wave 143A)';
COMMENT ON COLUMN public.listings.go_live_confirmed_at IS
  'When a syndication feed (go_live_confirmed_source) confirmed the listing live on the MLS. Stamped only by lib/listings/mls-live-date.ts recordVerifiedMlsLive. NULL = not verified. (m796, wave 143A)';
COMMENT ON COLUMN public.listings.mls_live_date_actual IS
  'ACTUAL MLS live date as read from a feed (RentCast for-sale index or the tenant IDX Broker) — never typed by a person. Requires go_live_confirmed_at + go_live_confirmed_source + mls_live_date_basis (listings_mls_live_actual_has_evidence_check). (m796, wave 143A)';
COMMENT ON COLUMN public.listings.mls_live_date_basis IS
  'How mls_live_date_actual was read: feed_list_date (the feed''s own list date) | first_observed (the first day we saw it live). (m796, wave 143A)';
COMMENT ON COLUMN public.listings.go_live_confirmed_source IS
  'Which feed verified the live date: rentcast | idx. (m796, wave 143A)';
COMMENT ON COLUMN public.listings.mls_live_timezone IS
  'IANA zone the go_live_date / mls_live_date_actual calendar days belong to (the property''s market; falls back to the brokerage setting). (m796, wave 143A)';
COMMENT ON COLUMN public.listings.listing_date IS
  'The day the agent pressed Launch in the platform (an agent assertion, written by launchListing) — NOT the MLS live date (go_live_date / mls_live_date_actual) and NOT the agreement execution date (listing_agreements.fully_executed_at). Kept for its legacy readers. (m796, wave 143A)';

-- The autonomous verification sweep reads "has an MLS number, not yet verified" per brokerage.
CREATE INDEX IF NOT EXISTS listings_mls_unverified_idx
  ON public.listings (brokerage_id)
  WHERE mls_number IS NOT NULL AND go_live_confirmed_at IS NULL AND deleted_at IS NULL;

-- After applying: regenerate scripts/schema-snapshot.ts, scripts/schema-fk-map.ts and scripts/check-vocabularies.ts
-- from the live JSON (CLAUDE.md §3) — the two new CHECK vocabularies (mls_live_date_basis, go_live_confirmed_source)
-- must reach the vocabulary cache so check-vocabulary-guard holds code (lib/listings/compute-dom.ts
-- MLS_LIVE_DATE_BASES / MLS_LIVE_SOURCES) and database in agreement.
