-- ============================================================================
-- Migration 1070 — buyer_broker_agreements.signature_request_id : uuid → text
-- ============================================================================
--
-- WHY:
--   dispatchTransactionPacket stores the e-sign provider's externalTransactionId
--   in this column. Provider IDs are not all UUIDs — Dotloop uses integer
--   loop_ids, SkySlope uses string handles, only DocuSign uses GUIDs. The
--   column was originally uuid, which made any non-DocuSign dispatch fail
--   at runtime with 22P02 invalid uuid syntax.
--
-- WHAT:
--   Converts the column to TEXT. Existing values cast cleanly (uuid → text).
--   No FKs reference this column. Indexes on it are recreated implicitly.
-- ============================================================================

ALTER TABLE public.buyer_broker_agreements
  ALTER COLUMN signature_request_id TYPE text USING signature_request_id::text;

-- Index for webhook lookup by signature_request_id (dotloop webhook fix)
CREATE INDEX IF NOT EXISTS buyer_broker_agreements_signature_request_id_idx
  ON public.buyer_broker_agreements (signature_request_id)
  WHERE signature_request_id IS NOT NULL;

-- Index on documents.metadata->>'signature_request_id' for the same webhook lookup
CREATE INDEX IF NOT EXISTS documents_metadata_signature_request_id_idx
  ON public.documents ((metadata->>'signature_request_id'))
  WHERE metadata ? 'signature_request_id';
