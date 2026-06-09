-- m201 — align leads' name/email column TYPES with raw_scraped_leads and contacts (all text),
-- so the upward copy can never fail with "value too long for type character varying(n)".
-- leads had first_name/last_name varchar(100) and email varchar(255) while raw and contacts use
-- unbounded text; an over-length scraped value would reject the lead insert. Widening to text is
-- non-destructive. phone is left varchar(20) — it backs the generated column phone_digits and a
-- bounded phone (E.164 is <= 15 digits) is a correct constraint, not a lossless risk.
ALTER TABLE public.leads
  ALTER COLUMN first_name TYPE text,
  ALTER COLUMN last_name  TYPE text,
  ALTER COLUMN email      TYPE text;
