-- m199 — give leads the physical-address fields so the upward flow
-- raw_scraped_leads → leads → contacts is LOSSLESS.
--
-- leads already had the mailing breakdown (mailing_address / mailing_city /
-- mailing_state / mailing_zip) but was DROPPING the physical address on
-- promotion: the normalizer resolved propertyAddress/city/state/zip from the
-- raw record's normalized_preview yet had nowhere to write them, so enrichment
-- looked incomplete and the address never reached the contact.
--
-- zip_code (not zip) is used here to match the contacts column name, so the
-- promotion mapping is a straight column-to-column copy.
ALTER TABLE public.leads
  ADD COLUMN IF NOT EXISTS address  text,
  ADD COLUMN IF NOT EXISTS city     text,
  ADD COLUMN IF NOT EXISTS state    text,
  ADD COLUMN IF NOT EXISTS zip_code text;
