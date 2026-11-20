-- ── APPLIED LIVE 2026-10-19 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — one batched call (the MCP accepts ALTER TABLE … DROP CONSTRAINT) ──
--
-- m786 — LEGAL DESCRIPTION SOURCES: the active listing record and the public-record research join the
-- vocabulary, and every value carries PROVENANCE (wave 142, lane 142C). Owner verbatim (2026-10-18):
-- "legal description can also be found with osint … should be part of address fill from the active
-- listing in rentcast or idx"; ruling: "part of the ADDRESS FILL from the active listing (RentCast /
-- IDX / MLS), county/public record, approved property research (OSINT), or human-verified entry — with
-- provenance. Never invented, never the street address."
--
-- AUDITED AT HEAD fec8b6a95: m768 (APPLIED LIVE 2026-10-14) put legal_description + legal_description_source
-- on listings and transactions with CHECK (agent | rentcast). lib/forms/legal-description.ts is the ONE
-- resolver (typed value → the record → RentCast → ask a human). This migration WIDENS that CHECK and
-- adds the provenance column; it renames nothing.
--
-- THE VOCABULARY (one spelling per source, CLAUDE.md §6; LEGAL_DESCRIPTION_SOURCES in
-- lib/forms/legal-description.ts is the code mirror and the proof holds the two equal):
--   agent         — the human's entry in the form's Fill step (the human-verified entry; provenance
--                   carries who and when)
--   listing       — the canonical LISTING record (the tenant's own inventory, MLS/IDX-synced) — written
--                   onto the TRANSACTION when the linked listing already carries the value
--   rentcast      — RentCast's property record (lib/property/rentcast.ts, gated + metered + cached)
--   public_record — the approved public-record research module (lib/property/address-lookup.ts: county
--                   assessor / recorder pages, Perplexity Sonar through the AI gateway, booked to
--                   ai_tool_usage); accepted ONLY with a cited source and a legal-description shape
--                   (lot / block / plat / section-township-range / metes-and-bounds), never a street
--                   address, and flagged for human verification — the owner's "osint" source
-- No model authors a value: 'public_record' is research that CITES where it read the description.
--
-- CODE (already written, depends on THIS migration):
--   · WRITER  lib/forms/legal-description.ts resolveLegalDescriptionForForm — writes legal_description,
--             legal_description_source and legal_description_provenance (who / when / evidence /
--             confidence) on listings / transactions, tenant-pinned and COUNTED. Until this file is
--             applied the live CHECK refuses 'listing' and 'public_record' (23514) and the provenance
--             column is absent (PGRST204): the writer READS both refusals, retries without the
--             provenance column, logs the vocabulary refusal, and the form still receives the value.
--   · READER  the same resolver returns the provenance to the Fill step (prefill-storage-form.ts) and
--             to the ADDRESS FILL (app/actions/buyer-offer/prefill-offer.ts resolveOfferPropertyPrefillAction);
--             lib/intelligence/offer-property-prefill-runner.ts reads legal_description_source.
--
-- After the apply, regenerate scripts/check-vocabularies.ts and the schema snapshot.
--
-- PART 1 (columns + CHECK) — additive, nullable, idempotent; no row changes.
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS legal_description_provenance jsonb;
ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS legal_description_provenance jsonb;

ALTER TABLE public.listings
  DROP CONSTRAINT IF EXISTS listings_legal_description_source_check,
  ADD CONSTRAINT listings_legal_description_source_check
    CHECK (legal_description_source IN ('agent', 'listing', 'public_record', 'rentcast'));
ALTER TABLE public.transactions
  DROP CONSTRAINT IF EXISTS transactions_legal_description_source_check,
  ADD CONSTRAINT transactions_legal_description_source_check
    CHECK (legal_description_source IN ('agent', 'listing', 'public_record', 'rentcast'));

COMMENT ON COLUMN public.listings.legal_description_source IS
  'agent | listing | public_record | rentcast — who supplied legal_description (m768; widened by m786, wave 142).';
COMMENT ON COLUMN public.transactions.legal_description_source IS
  'agent | listing | public_record | rentcast — who supplied legal_description (m768; widened by m786, wave 142).';
COMMENT ON COLUMN public.listings.legal_description_provenance IS
  'Provenance of legal_description: { source, at, by (users.id or null), evidence { listing_id | provider | source_urls … }, confidence verified|provider|research, verification_required } — written by lib/forms/legal-description.ts beside every value (m786).';
COMMENT ON COLUMN public.transactions.legal_description_provenance IS
  'Same shape and writer as listings.legal_description_provenance (m786).';

-- PART 2 (indexes / triggers) — none: both records are read by primary key.
