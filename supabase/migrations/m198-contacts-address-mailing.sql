-- m198 — give contacts the same address fidelity as leads so lead->contact promotion is
-- LOSSLESS and the "owns a property but doesn't live there" case is preserved:
--   address                 — the contact's physical/property street address (distinct from mailing)
--   mailing_city/state/zip  — the mailing-address breakdown (leads + raw_scraped_leads already have
--                             these; contacts only had mailing_address(full), so the breakdown was
--                             dropped on promotion and 3 readers errored selecting it).
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS address       text,
  ADD COLUMN IF NOT EXISTS mailing_city  text,
  ADD COLUMN IF NOT EXISTS mailing_state text,
  ADD COLUMN IF NOT EXISTS mailing_zip   text;
