-- WRITTEN, NOT APPLIED (wave 146, lane 146A) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN and storage.objects policies are owner SQL-editor
--
-- m875 — THE FOUR PRIVATE DOCUMENT BUCKETS' STORAGE POLICIES (OWNER-HELD; wave 146, lane 146A — owner ruling 20 priority 1, the
-- same release-blocking P1 class as m855 for brokerage-forms).
--
-- WHY THIS IS NOT THE INTEGRATOR'S: storage.objects is owned by `supabase_storage_admin`. Re-measured 2026-10-29 through the MCP:
-- current_user = postgres, pg_has_role(current_user, 'supabase_storage_admin', 'member') = false — so CREATE / DROP POLICY on
-- storage.objects is refused 42501 ("must be owner of table objects"), as m853's storage block was on 2026-10-25. The exact owner
-- procedure (route A: the SQL editor; route B: Dashboard → Storage → Policies), the verification queries, the readiness read and the
-- rollback are docs/operations/OWNER-SQL.md §G (this file, verbatim).
--
-- WHAT IS LIVE TODAY (measured 2026-10-29): 15 bucket-wide policies, `bucket_id = '<bucket>'` and nothing else, TO authenticated —
-- read / upload / update / delete on client-documents, offer-documents and transaction-documents, and read / upload / update on
-- agent-documents. Any signed-in user of any tenant can read, overwrite and delete every client's financial paperwork, every offer,
-- every deal file (wire instructions included) and every agent's licence. 0 objects are stored live, the only reason nothing leaked.
--
-- WHAT REPLACES THEM (the rules are m874's public.document_bucket_path_access — the party audit is in m874's header):
--   client-documents      SELECT + INSERT through the path rule. No UPDATE (no session door upserts or moves; the auto-filing
--                         clerk moves on the service role), no DELETE (every compensating delete there runs on the service role).
--   transaction-documents SELECT + INSERT through the path rule; DELETE for the deal team, and for an external party only its OWN
--                         upload inside the compensating-delete window (m874 document_bucket_object_deletable). No UPDATE.
--   agent-documents       SELECT + INSERT through the path rule (own licence folder; the oversight class reads). No UPDATE / DELETE:
--                         a licence on file is supervision evidence; a replacement is a new upload.
--   offer-documents       NO session policy at all — every reader and writer is the server (service role), which RLS does not
--                         gate. A private bucket with no policy refuses every session (fail closed); signed URLs the server mints
--                         keep working.
-- Anonymous sessions match none of these (TO authenticated only, and every bucket stays public = false).
--
-- PRECONDITION: m874 applied. The DO block refuses to run otherwise, so a half-applied state (open policies dropped, new ones naming
-- missing functions) cannot happen. One transaction: if any statement is refused, nothing changes. Between the DROPs and the CREATEs
-- the bucket is deny-all for sessions (fail closed), never open. Re-runnable: every DROP is IF EXISTS, including the new names.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.document_bucket_path_access(text, text, text)') IS NULL
     OR to_regprocedure('public.document_bucket_path_readable(text, text)') IS NULL
     OR to_regprocedure('public.document_bucket_path_writable(text, text)') IS NULL
     OR to_regprocedure('public.document_bucket_object_deletable(text, text, text, timestamp with time zone)') IS NULL THEN
    RAISE EXCEPTION 'm875 needs m874 first: the document_bucket_* path functions are missing — apply supabase/migrations/m874-document-bucket-path-rules-and-offer-party-reads.sql';
  END IF;
END $$;

DROP POLICY IF EXISTS "auth read client-documents"   ON storage.objects;
DROP POLICY IF EXISTS "auth upload client-documents" ON storage.objects;
DROP POLICY IF EXISTS "auth update client-documents" ON storage.objects;
DROP POLICY IF EXISTS "auth delete client-documents" ON storage.objects;

DROP POLICY IF EXISTS "auth read offer-documents"   ON storage.objects;
DROP POLICY IF EXISTS "auth upload offer-documents" ON storage.objects;
DROP POLICY IF EXISTS "auth update offer-documents" ON storage.objects;
DROP POLICY IF EXISTS "auth delete offer-documents" ON storage.objects;

DROP POLICY IF EXISTS "auth read transaction-documents"   ON storage.objects;
DROP POLICY IF EXISTS "auth upload transaction-documents" ON storage.objects;
DROP POLICY IF EXISTS "auth update transaction-documents" ON storage.objects;
DROP POLICY IF EXISTS "auth delete transaction-documents" ON storage.objects;

DROP POLICY IF EXISTS "auth read agent-documents"   ON storage.objects;
DROP POLICY IF EXISTS "auth upload agent-documents" ON storage.objects;
DROP POLICY IF EXISTS "auth update agent-documents" ON storage.objects;
DROP POLICY IF EXISTS "auth delete agent-documents" ON storage.objects;

DROP POLICY IF EXISTS "client-documents owner read"        ON storage.objects;
DROP POLICY IF EXISTS "client-documents owner upload"      ON storage.objects;
DROP POLICY IF EXISTS "transaction-documents owner read"   ON storage.objects;
DROP POLICY IF EXISTS "transaction-documents owner upload" ON storage.objects;
DROP POLICY IF EXISTS "transaction-documents owner delete" ON storage.objects;
DROP POLICY IF EXISTS "agent-documents owner read"         ON storage.objects;
DROP POLICY IF EXISTS "agent-documents owner upload"       ON storage.objects;

CREATE POLICY "client-documents owner read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'client-documents' AND public.document_bucket_path_readable('client-documents', name));

CREATE POLICY "client-documents owner upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'client-documents' AND public.document_bucket_path_writable('client-documents', name));

CREATE POLICY "transaction-documents owner read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'transaction-documents' AND public.document_bucket_path_readable('transaction-documents', name));

CREATE POLICY "transaction-documents owner upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'transaction-documents' AND public.document_bucket_path_writable('transaction-documents', name));

CREATE POLICY "transaction-documents owner delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'transaction-documents' AND public.document_bucket_object_deletable('transaction-documents', name, owner_id, created_at));

CREATE POLICY "agent-documents owner read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'agent-documents' AND public.document_bucket_path_readable('agent-documents', name));

CREATE POLICY "agent-documents owner upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'agent-documents' AND public.document_bucket_path_writable('agent-documents', name));

COMMIT;
