-- ── WRITTEN, NOT APPLIED — the integrator applies it (CLAUDE.md §3: files are not the database) ──
--
-- m680 — market_active_listings.current_status admits 'off_market' (lane 92B, wave 92).
--
-- Owner, verbatim (2026-10-01): "use rentcast as much as possible regarding property listings,
-- market, comparable, home values …" · "batchdata is to be used more for scrapping leads."
--
-- lib/kernel/listings-batchdata-feed.ts::runActiveListingDiscoveryForMarket moved from BatchData's
-- `on-market` quickList pull (billed per record) to two RentCast /listings/sale requests per
-- territory per day (status Active / status Inactive). RentCast's listing status is only
-- Active / Inactive: an Inactive row cannot say whether the home EXPIRED, was WITHDRAWN or SOLD.
-- Writing any of those three would assert a fact the provider did not report, so an address the
-- feed last saw active that RentCast now lists as Inactive (removed inside 30 days) is stored as
-- 'off_market'. (A seller SIGNAL is still decided per matched lead/contact from the RentCast
-- property record's last sale — that decision does not need this column.)
--
-- Until this is applied the CHECK refuses 'off_market' (23514); the feed detects that, reports it
-- ONCE per run ("m680 is not applied yet") and keeps writing ACTIVE rows — nothing else changes.
--
-- After applying: regenerate the vocabulary cache (CLAUDE.md §3 — scripts/generate-check-
-- vocabularies.ts) so scripts/check-vocabularies.ts lists 'off_market' for this column.

DO $$
DECLARE
  c record;
BEGIN
  -- The CHECK was declared inline in m636's CREATE TABLE, so its name is the generated
  -- market_active_listings_current_status_check; drop whichever CHECK constrains the column.
  FOR c IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace nsp ON nsp.oid = rel.relnamespace
    WHERE nsp.nspname = 'public'
      AND rel.relname = 'market_active_listings'
      AND con.contype = 'c'
      AND pg_get_constraintdef(con.oid) ILIKE '%current_status%'
  LOOP
    EXECUTE format('ALTER TABLE public.market_active_listings DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

ALTER TABLE public.market_active_listings
  ADD CONSTRAINT market_active_listings_current_status_check
  CHECK (current_status IN ('active', 'expired', 'withdrawn', 'sold', 'off_market'));

COMMENT ON COLUMN public.market_active_listings.current_status IS
  'active | expired | withdrawn | sold (BatchData quickList era) | off_market (RentCast Inactive since m680 — the provider does not say which terminal state)';
