-- fix-signature-requests-integrity.sql — applied via MCP migrations
-- repoint_signature_requests_fk_to_client_documents + fix_signature_requests_signing_order_type.
-- Surfaced by end-to-end testing of the dotloop signing flow (sendForDotloopSignature):
--   1. document_id FK pointed at transaction_documents but the sole writer inserts a client_documents.id
--      -> every insert was a runtime FK violation. Repointed FK to client_documents (table empty).
--   2. signing_order was integer but the code writes the ordered signers array -> type error on insert.
--      Changed to jsonb (sibling all_parties is already jsonb; no readers).
ALTER TABLE public.signature_requests DROP CONSTRAINT signature_requests_document_id_fkey;
ALTER TABLE public.signature_requests
  ADD CONSTRAINT signature_requests_document_id_fkey
  FOREIGN KEY (document_id) REFERENCES public.client_documents(id) ON DELETE CASCADE;
ALTER TABLE public.signature_requests
  ALTER COLUMN signing_order TYPE jsonb USING to_jsonb(signing_order);
