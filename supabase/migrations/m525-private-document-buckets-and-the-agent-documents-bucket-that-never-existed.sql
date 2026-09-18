-- m525 — APPLIED 2026-08-22. Content originated as scripts/1108-private-document-buckets.sql
-- (written by the storage-rail lane, applied on the owner's ruling "apply 1108").
-- This file exists because a migration that was applied with no file in the repo is a
-- database the repo cannot describe — CLAUDE.md §3 cuts both ways: files are not the
-- database, and a database with no file is not reviewable.
--
-- SAFE ONLY BECAUSE EVERY AFFECTED BUCKET HELD ZERO OBJECTS at apply time. After
-- production traffic the same statements WOULD break already-issued URLs, and any link
-- already emailed stays valid against its object forever.

update storage.buckets
   set public = false
 where id in ('documents', 'brokerage-forms')
   and public is true;

-- The bucket flip ALONE would not have closed brokerage-forms: this policy granted read
-- to role `public`, so any anon JWT could still read through /object/authenticated/.
-- A convincing false fix.
drop policy if exists "public read brokerage-forms" on storage.objects;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects'
                  and policyname='auth read brokerage-forms') then
    create policy "auth read brokerage-forms"
      on storage.objects for select to authenticated
      using (bucket_id = 'brokerage-forms');
  end if;
end $$;

-- agent-documents never existed: agent LICENCE and E&O uploads have failed with
-- "Bucket not found" for their whole life. This creates the missing half.
insert into storage.buckets (id, name, public, file_size_limit)
values ('agent-documents', 'agent-documents', false, 10485760)
on conflict (id) do update set public = false;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects'
                  and policyname='auth read agent-documents') then
    create policy "auth read agent-documents" on storage.objects for select to authenticated
      using (bucket_id = 'agent-documents');
  end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects'
                  and policyname='auth upload agent-documents') then
    create policy "auth upload agent-documents" on storage.objects for insert to authenticated
      with check (bucket_id = 'agent-documents');
  end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects'
                  and policyname='auth update agent-documents') then
    create policy "auth update agent-documents" on storage.objects for update to authenticated
      using (bucket_id = 'agent-documents');
  end if;
end $$;
