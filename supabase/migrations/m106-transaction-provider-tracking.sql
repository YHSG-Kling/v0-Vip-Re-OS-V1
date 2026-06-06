-- m106 — Generic provider-tracking columns on transactions + transaction_documents.
--
-- WHY: Audit caught that the buyer/seller portal `documents` pages read directly from
-- `transaction_documents` but only Dotloop has a sync path that populates that table
-- (Dotloop is the only provider with a dedicated external-id column on `transactions`:
-- `dotloop_loop_id`). Brokerages configured for SkySlope / Brokermint / FormSimplicity
-- see ZERO documents on the portals despite having documents in their provider's system.
--
-- FIX: Add two generic provider-tracking columns each on `transactions` and
-- `transaction_documents`, plus a unique partial index on the document side so the
-- canonical sync helper (lib/transactions/sync-from-provider.ts) can upsert idempotently.
--
-- The new shape is intentionally provider-agnostic: `external_provider_source` is the
-- provider name (e.g. 'dotloop', 'skyslope'), `external_provider_transaction_id` /
-- `external_document_id` is the id assigned by that provider. The existing
-- `dotloop_loop_id` column on `transactions` is preserved for backward compatibility;
-- the Dotloop adapter now populates BOTH columns when it creates a loop.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS external_provider_source         TEXT,
  ADD COLUMN IF NOT EXISTS external_provider_transaction_id TEXT,
  ADD COLUMN IF NOT EXISTS last_provider_sync_at            TIMESTAMPTZ;

COMMENT ON COLUMN public.transactions.external_provider_source IS
  'Configured transaction provider that owns this transaction externally: dotloop | skyslope | brokermint | formsimplicity.';
COMMENT ON COLUMN public.transactions.external_provider_transaction_id IS
  'The provider-assigned id (loop_id, transaction_id, etc.). Drives sync-from-provider for document/signature backfill.';
COMMENT ON COLUMN public.transactions.last_provider_sync_at IS
  'When sync-from-provider last successfully pulled. Used as a stale-check by the portal pages.';

CREATE INDEX IF NOT EXISTS idx_transactions_external_provider
  ON public.transactions(external_provider_source, external_provider_transaction_id)
  WHERE external_provider_source IS NOT NULL;

ALTER TABLE public.transaction_documents
  ADD COLUMN IF NOT EXISTS provider_source       TEXT,
  ADD COLUMN IF NOT EXISTS external_document_id  TEXT;

COMMENT ON COLUMN public.transaction_documents.provider_source IS
  'Provider that produced this document row (dotloop | skyslope | brokermint | formsimplicity). NULL for agent-uploaded docs.';
COMMENT ON COLUMN public.transaction_documents.external_document_id IS
  'Provider-assigned document id. Pair with provider_source for idempotent upsert via the unique index below.';

-- Partial unique index — only rows with both provider columns set participate. Agent-
-- uploaded rows (provider_source NULL) keep inserting freely; provider-synced rows
-- dedupe at the DB layer so re-running sync-from-provider can't duplicate them.
CREATE UNIQUE INDEX IF NOT EXISTS uq_transaction_documents_provider_external_id
  ON public.transaction_documents(transaction_id, provider_source, external_document_id)
  WHERE provider_source IS NOT NULL AND external_document_id IS NOT NULL;
