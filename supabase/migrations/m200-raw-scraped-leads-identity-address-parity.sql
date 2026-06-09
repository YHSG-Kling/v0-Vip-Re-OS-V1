-- m200 — bring raw_scraped_leads to first-class field parity with leads for the
-- identity + physical-address set, so "raw fields and leads fields match" and the
-- upward flow raw -> leads -> contacts is a straight column-to-column copy.
--
-- Until now the raw layer kept identity (first/last/email/phone) and the physical
-- address (address/city/state/zip_code) ONLY inside normalized_preview/raw_data jsonb,
-- while the mailing breakdown was already first-class. That asymmetry meant the raw
-- row could not be queried/mapped without digging into jsonb. These columns mirror the
-- same names/types used on leads and contacts; normalized_preview is retained as the
-- verbatim audit copy.
ALTER TABLE public.raw_scraped_leads
  ADD COLUMN IF NOT EXISTS first_name             text,
  ADD COLUMN IF NOT EXISTS last_name              text,
  ADD COLUMN IF NOT EXISTS email                  text,
  ADD COLUMN IF NOT EXISTS phone                  text,
  ADD COLUMN IF NOT EXISTS address                text,
  ADD COLUMN IF NOT EXISTS city                   text,
  ADD COLUMN IF NOT EXISTS state                  text,
  ADD COLUMN IF NOT EXISTS zip_code               text,
  ADD COLUMN IF NOT EXISTS mailing_address_source text;
