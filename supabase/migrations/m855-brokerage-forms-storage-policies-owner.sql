-- WRITTEN, NOT APPLIED (wave 145, lane 145A) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN and storage.objects policies are owner SQL-editor
--
-- m855 — THE brokerage-forms STORAGE POLICIES (OWNER-HELD; wave 145, lane 145A — owner ruling 23, release-blocking P1).
--
-- WHY THIS IS NOT THE INTEGRATOR'S: storage.objects is owned by `supabase_storage_admin`. Measured 2026-10-27 through the MCP:
-- current_user = postgres, postgres is NOT a member of supabase_storage_admin and NOT a superuser — so CREATE / DROP POLICY on
-- storage.objects is refused 42501 ("must be owner of table objects"), exactly as m853's storage block was on 2026-10-25. The
-- dashboard SQL editor also runs as `postgres` by default, so it may be refused the same way; the exact owner procedure, with the
-- Storage-policies-UI route and the verification queries, is docs/operations/OWNER-SQL.md §F (this file, verbatim).
--
-- WHAT IS LIVE TODAY (measured 2026-10-27): the four bucket-wide policies "auth read / upload / update / delete brokerage-forms"
-- — `bucket_id = 'brokerage-forms'` and nothing else, TO authenticated. Every signed-in user (a portal contact or a vendor seat of
-- any tenant included) can read, overwrite and delete every object in the bucket: every tenant's licensed packet masters and every
-- filled offer (a buyer's name, price and terms). The bucket is private (public=false) and holds 0 objects today, which is the
-- only reason this has not leaked yet.
--
-- PRECONDITION: m854 applied (the four public functions below exist). The DO block refuses to run otherwise, so a half-applied
-- state (open policies dropped, new ones naming missing functions) cannot happen. The whole file is one transaction: if any
-- statement is refused, nothing changes. A window with NO brokerage-forms policy is deny-all (fail closed), never open.
--
-- RE-RUNNABLE: every DROP is IF EXISTS — including the four m853 names, in case wave 144's §F block was run by hand.

BEGIN;

DO $$
BEGIN
  IF to_regprocedure('public.brokerage_forms_seat_active()') IS NULL
     OR to_regprocedure('public.brokerage_forms_registered_packet_readable(text)') IS NULL
     OR to_regprocedure('public.brokerage_forms_path_readable(text)') IS NULL
     OR to_regprocedure('public.brokerage_forms_path_writable(text)') IS NULL THEN
    RAISE EXCEPTION 'm855 needs m854 first: the brokerage_forms_* path functions are missing — apply supabase/migrations/m854-brokerage-forms-seat-scoped-path-rules.sql';
  END IF;
END $$;

DROP POLICY IF EXISTS "auth read brokerage-forms"   ON storage.objects;
DROP POLICY IF EXISTS "auth upload brokerage-forms" ON storage.objects;
DROP POLICY IF EXISTS "auth update brokerage-forms" ON storage.objects;
DROP POLICY IF EXISTS "auth delete brokerage-forms" ON storage.objects;

DROP POLICY IF EXISTS "brokerage-forms owner read"   ON storage.objects;
DROP POLICY IF EXISTS "brokerage-forms owner upload" ON storage.objects;
DROP POLICY IF EXISTS "brokerage-forms owner update" ON storage.objects;
DROP POLICY IF EXISTS "brokerage-forms owner delete" ON storage.objects;

CREATE POLICY "brokerage-forms owner read" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'brokerage-forms' AND public.brokerage_forms_path_readable(name));

CREATE POLICY "brokerage-forms owner upload" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'brokerage-forms' AND public.brokerage_forms_path_writable(name));

CREATE POLICY "brokerage-forms owner update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'brokerage-forms' AND public.brokerage_forms_path_writable(name))
  WITH CHECK (bucket_id = 'brokerage-forms' AND public.brokerage_forms_path_writable(name));

CREATE POLICY "brokerage-forms owner delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'brokerage-forms' AND public.brokerage_forms_path_writable(name));

COMMIT;
