-- add-client-documents-core-fields.sql — applied via migration add_client_documents_core_fields.
-- client_documents is the canonical CLIENT document table (per the doc-subsystem decision: specialized
-- tables stay canonical, client_documents holds client-doc-level data). These are core fields the code
-- reads/writes with no specialized home — distinct from dotloop_documents / signature_requests /
-- document_extraction_log which keep their own data:
ALTER TABLE public.client_documents ADD COLUMN IF NOT EXISTS status text;
ALTER TABLE public.client_documents ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.client_documents ADD COLUMN IF NOT EXISTS listing_id uuid;
ALTER TABLE public.client_documents ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
