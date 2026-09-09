-- m614 — transaction_documents gets the columns its own writer already assumes,
--        plus a LISTING lane for pre-contract packets.
--
-- APPLIED to hrvaqgvukzxfskkcrwbt on 2026-09-09 by the integrator (measured first; see the wave-46 commit).
-- Lanes write migrations; only the integrator applies them.
--
-- ── DEFECT 1, MEASURED LIVE (hrvaqgvukzxfskkcrwbt, 2026-09-09) ────────────────
-- lib/transactions/sync-from-provider.ts:syncTransactionDocumentsFromProvider —
-- the CANONICAL writer the portal documents pages depend on, and the survivor
-- named by scripts/governance-privacy-billing-wiring-simulator.ts's
-- "forms.syncEsignDocs.kept-with-named-survivor" check — upserts a row shaped
-- { transaction_id, contact_id, provider_source, external_document_id, doc_type,
--   doc_label, status, storage_url, uploaded_at, signature_status }. Live
-- information_schema.columns for transaction_documents carries NEITHER
-- `contact_id` NOR `signature_status`. PostgREST refuses an INSERT/UPDATE naming
-- an absent column ENTIRELY (§3, PGRST204) — not "most of the row", nothing —
-- so every one of that function's upserts has always been refused, and every
-- brokerage on a non-legacy-Dotloop provider has synced zero documents, ever,
-- while scripts/governance-privacy-billing-wiring-simulator.ts reported PASS
-- (it regex-checks for `.from("transaction_documents")` + `.upsert(`, which is
-- present, and cannot see that the payload names columns the table does not
-- have — CLAUDE.md §2, "a guard that cannot see the code it judges is worse
-- than no guard"). This migration adds exactly the two columns the already-live
-- code assumes; nothing here is new capability, it is the schema the wired
-- writer has been missing since m106.
--
-- ── DEFECT 2 — THE CAPABILITY app/actions/forms-kernel.ts:syncEsignDocsAction
--    CARRIES AND THE SURVIVOR DOES NOT ────────────────────────────────────────
-- That action's own tombstone (forms-kernel.ts:160-174) names the one thing it
-- has that syncTransactionDocumentsFromProvider does not: `listing_id` scoping
-- for a pre-contract listing packet (a disclosure or listing agreement sent for
-- signature before any transaction row exists). `transaction_id` is NOT NULL on
-- transaction_documents (verified live) and `listings` carries none of m106's
-- generic provider-tracking columns (external_provider_source,
-- external_provider_transaction_id, last_provider_sync_at) — so there was
-- nowhere to persist a listing packet's synced documents even if the writer
-- were extended to accept one. That is the "needs schema change" this
-- migration closes: `listing_id` on transaction_documents (nullable,
-- REFERENCES listings), `transaction_id` relaxed to nullable with a CHECK that
-- a row still names ONE parent, a second partial unique index for the listing
-- lane so it dedupes independently of the transaction lane, and the same three
-- generic provider columns m106 gave `transactions` added to `listings`.
--
-- Wired by this lane: lib/transactions/sync-from-provider.ts gains
-- syncListingDocumentsFromProvider (mirrors the transaction function, resolves
-- against `listings`, writes listing_id + transaction_id:null), and
-- app/actions/forms-kernel.ts:syncEsignDocsAction now delegates to whichever
-- core matches its input instead of the fetch-only kernel wrapper it used to
-- call. /api/cron/esign-doc-sync (CRON_REGISTRY, deal_coordinator) sweeps both
-- lanes on the same staleness contract the portal page already uses.

-- ── transaction_documents ──────────────────────────────────────────────────

ALTER TABLE public.transaction_documents
  ADD COLUMN IF NOT EXISTS contact_id       UUID REFERENCES public.contacts(id),
  ADD COLUMN IF NOT EXISTS signature_status JSONB,
  ADD COLUMN IF NOT EXISTS listing_id       UUID REFERENCES public.listings(id);

COMMENT ON COLUMN public.transaction_documents.contact_id IS
  'The portal-side contact this document is shown to. Already written by lib/transactions/sync-from-provider.ts before this column existed (PGRST204 on every call) — added, not invented.';
COMMENT ON COLUMN public.transaction_documents.signature_status IS
  'Provider signer detail ({is_signed, signers, synced_at}) beside the coarse `status` column. Same history as contact_id above.';
COMMENT ON COLUMN public.transaction_documents.listing_id IS
  'Set for a pre-contract listing packet synced before any transaction row exists (listing agreement, seller disclosures). Mutually exclusive with transaction_id in practice — see the CHECK below — never both.';

CREATE INDEX IF NOT EXISTS idx_transaction_documents_listing_id
  ON public.transaction_documents(listing_id)
  WHERE listing_id IS NOT NULL;

-- `transaction_id` has been NOT NULL since the table's original create — every
-- existing row already satisfies "names a transaction", so relaxing it first
-- and then adding the OR-check is safe with zero backfill.
ALTER TABLE public.transaction_documents
  ALTER COLUMN transaction_id DROP NOT NULL;

ALTER TABLE public.transaction_documents
  ADD CONSTRAINT transaction_documents_has_a_parent
  CHECK (transaction_id IS NOT NULL OR listing_id IS NOT NULL);

-- The transaction-lane unique index (m106) is untouched: NULL transaction_id
-- rows never collide in it (NULLs are distinct in a unique index), so it
-- neither blocks nor dedupes the listing lane — this second, listing-scoped
-- index is what actually enforces idempotency there.
CREATE UNIQUE INDEX IF NOT EXISTS uq_transaction_documents_listing_provider_external_id
  ON public.transaction_documents(listing_id, provider_source, external_document_id)
  WHERE listing_id IS NOT NULL AND provider_source IS NOT NULL AND external_document_id IS NOT NULL;

-- ── listings — the m106 shape, ported for the listing lane ────────────────

ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS external_provider_source         TEXT,
  ADD COLUMN IF NOT EXISTS external_provider_transaction_id TEXT,
  ADD COLUMN IF NOT EXISTS last_provider_sync_at            TIMESTAMPTZ;

COMMENT ON COLUMN public.listings.external_provider_source IS
  'Configured transaction/forms provider that owns this LISTING packet externally (dotloop | skyslope | brokermint | formsimplicity) — the m106 shape, for the pre-contract lane.';
COMMENT ON COLUMN public.listings.external_provider_transaction_id IS
  'The provider-assigned envelope/loop id for this listing packet. Drives syncListingDocumentsFromProvider.';
COMMENT ON COLUMN public.listings.last_provider_sync_at IS
  'When syncListingDocumentsFromProvider last successfully pulled. Staleness gate, same contract as transactions.last_provider_sync_at.';

CREATE INDEX IF NOT EXISTS idx_listings_external_provider
  ON public.listings(external_provider_source, external_provider_transaction_id)
  WHERE external_provider_source IS NOT NULL;
