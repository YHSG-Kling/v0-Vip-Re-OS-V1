-- ── WRITTEN, NOT APPLIED — the integrator applies it (CLAUDE.md §3: files are not the database) ──
--
-- m768 — LEGAL DESCRIPTION ON THE CANONICAL PROPERTY RECORDS (wave 141, lane 141C). Owner verbatim:
-- "LEGAL DESCRIPTION: some forms need address AND legal description. PROPERTY → legal description →
-- canonical transaction/form model → provider field. Never invent it: use an approved property-data
-- capability if it legitimately provides it, else ask a human; the form stays incomplete until the
-- data exists."
--
-- AUDITED AT HEAD 01a71c3c2 (scripts/schema-snapshot.ts, 2026-10-14): no table carries a legal
-- description. lib/intelligence/offer-property-prefill-runner.ts resolveKnownPropertyFacts said so
-- honestly ("legal_description is not stored on any current table … null until a parcel source
-- provides it") and lib/intelligence/offer-property-prefill.ts already MAPS KnownPropertyFacts.
-- legalDescription onto a form's "Legal Description" field. The two property-bearing records that
-- resolver walks are `listings` (our own inventory, the listing agreement's subject) and
-- `transactions` (property_address / property_city / property_state / property_zip — the contract's
-- subject, incl. an external-MLS buy). There is no `properties` table (the canonical property model
-- is lib/property/*, a service layer over these two records + the provider chain), so the column
-- lives on BOTH records, exactly where the address already lives.
--
-- Code (already written, depends on THIS migration):
--   · READER  lib/intelligence/offer-property-prefill-runner.ts resolveKnownPropertyFacts — selects
--             legal_description on listings / transactions into KnownPropertyFacts.legalDescription
--             (→ buildPropertyPrefill → the PDF's Legal Description field → the provider envelope).
--             Before the apply PostgREST refuses the select (42703) — the read is logged and the
--             facts stay null (the form is INCOMPLETE and a human is asked), never a crash.
--   · WRITERS lib/forms/legal-description.ts resolveLegalDescriptionForForm — (a) the value the
--             agent TYPED in the FormWizard's field panel (source 'agent'); (b) RentCast's property
--             record legalDescription (lib/property/rentcast.ts getRentcastPropertyDetailWithOutcome
--             — the approved property-data capability that legitimately carries it; gated, metered
--             and cached inside rentcast.ts; source 'rentcast'). BatchData's adapter maps no legal
--             description and Versium's property facts are year built / dwelling type / purchase
--             date only — neither is a legitimate source, so neither is asked. Every write is
--             pinned to brokerage_id and `.select('id')` COUNTS the row (CLAUDE.md §3).
--   · ASK     the same module creates ONE open `tasks` row (source 'legal_description_request')
--             for the agent when no source has it — the existing task rail; completed by the writer
--             the moment a value lands.
--
-- VOCABULARY: legal_description_source is CHECKed to the two writers above (one vocabulary per
-- function, CLAUDE.md §6; LEGAL_DESCRIPTION_SOURCES in lib/forms/legal-description.ts is the code
-- mirror). After the apply, regenerate the vocabulary cache (scripts/check-vocabularies.ts) and the
-- schema snapshot so check-vocabulary-guard / the column census see the columns.
--
-- PART 1 (columns) — additive, nullable, idempotent; no row changes.
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS legal_description text,
  ADD COLUMN IF NOT EXISTS legal_description_source text;
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS legal_description text,
  ADD COLUMN IF NOT EXISTS legal_description_source text;

ALTER TABLE public.listings
  DROP CONSTRAINT IF EXISTS listings_legal_description_source_check,
  ADD CONSTRAINT listings_legal_description_source_check
    CHECK (legal_description_source IS NULL OR legal_description_source IN ('agent', 'rentcast'));
ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_legal_description_source_check,
  ADD CONSTRAINT transactions_legal_description_source_check
    CHECK (legal_description_source IS NULL OR legal_description_source IN ('agent', 'rentcast'));

COMMENT ON COLUMN public.listings.legal_description IS
  'The property''s legal description (plat / lot / block / metes-and-bounds) as a contract form carries it — written by lib/forms/legal-description.ts from the agent (source agent) or RentCast''s property record (source rentcast); read by resolveKnownPropertyFacts for the Legal Description form field. Never model-authored (wave 141, m768).';
COMMENT ON COLUMN public.transactions.legal_description IS
  'The subject property''s legal description for this transaction''s forms — same writers/reader as listings.legal_description (wave 141, m768).';
COMMENT ON COLUMN public.listings.legal_description_source IS 'agent | rentcast — who supplied legal_description (m768).';
COMMENT ON COLUMN public.transactions.legal_description_source IS 'agent | rentcast — who supplied legal_description (m768).';

-- PART 2 (indexes / triggers) — none: both columns are read by the record''s primary key only.
