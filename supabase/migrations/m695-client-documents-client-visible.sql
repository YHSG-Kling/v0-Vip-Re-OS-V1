-- ── APPLIED LIVE 2026-10-03 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — column + function as m695a (apply_migration); trigger via execute_sql with lock_timeout ──
--
-- m695 — the CLIENT'S OWN FOLDER gets the same staff Show/Hide switch deal documents got in m690
-- (wave 100, lane 100C — 98A open item: "client_documents (the client's own folder) has the deny list
-- but no staff flag"). Apply in TWO parts (PART 1 column, PART 2 trigger).
--
-- Live read 2026-10-03 (lane 100C): client_documents 0 rows; no visibility column (columns: … uploaded_by
-- uuid, doc_category text, … notes text, …). Default FALSE — deny by default, the same rule as
-- transaction_documents.client_visible: a portal client sees a client_documents row only when staff
-- showed it, or when the client uploaded it themselves (uploaded_by = their own auth user); the code
-- deny list (CDA / disbursement / internal — lib/kernel/deal-document-visibility.ts
-- isClientHiddenDealDocType, asked of document_type AND doc_category) wins over the flag. With 0 live
-- rows nothing a client sees today is hidden by the default.
--
-- Writer: app/actions/document-center.ts setClientDocumentVisibility (the Document Center row switch).
-- Readers: app/portal/[contactId]/documents/page.tsx, app/portal/[contactId]/calendar/page.tsx,
-- app/actions/portal-seller.ts getSellerDocuments (through lib/kernel/portal.ts
-- readClientDocumentVisibilityFlags), app/actions/document-center.ts getDocumentCenterData.
-- Before PART 1 is applied every flag read is REFUSED (42703) and handled: the portal treats every row as
-- staff-hidden (fail closed — self-uploaded rows still show), the Document Center shows "Client visibility
-- unavailable" instead of a switch, and the writer reports the refusal.
--
-- No new CHECK (a boolean) — no vocabulary cache regeneration needed.

-- ════ PART 1 — column ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.client_documents
  ADD COLUMN IF NOT EXISTS client_visible boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.client_documents.client_visible IS
  'Staff showed this document in the client portal (wave 100, m695). Deny by default; a client always sees what they uploaded; the code deny-list (lib/kernel/deal-document-visibility.ts isClientHiddenDealDocType) wins over it.';

-- ════ PART 2 — trigger ═══════════════════════════════════════════════════════════════════════════
-- A row the CLIENT inserts into their own folder is theirs to see: stamp it visible, so the flag agrees
-- with the uploaded_by half of the rule even for a reader that consults the flag alone. A client is the
-- contact whose contact_user_id is the inserting auth user (the portal upload path's own identity).

CREATE OR REPLACE FUNCTION public.client_document_client_upload_is_visible()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.uploaded_by IS NOT NULL AND NEW.contact_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.contacts c WHERE c.id = NEW.contact_id AND c.contact_user_id = NEW.uploaded_by
  ) THEN
    NEW.client_visible := true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS client_document_client_upload_is_visible ON public.client_documents;
CREATE TRIGGER client_document_client_upload_is_visible
  BEFORE INSERT ON public.client_documents
  FOR EACH ROW EXECUTE FUNCTION public.client_document_client_upload_is_visible();
