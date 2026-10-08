-- scripts/1108-private-document-buckets.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- MAKE THE DOCUMENT-CLASS BUCKETS PRIVATE.
--
-- ***  NOT APPLIED.  Lanes write migrations; only the integrator applies them
-- ***  (CLAUDE.md §3). Nothing below has run against hrvaqgvukzxfskkcrwbt.
--
-- ── WHAT IS WRONG ─────────────────────────────────────────────────────────
-- A bucket with public=true serves every object it holds at
--
--     https://<proj>.supabase.co/storage/v1/object/public/<bucket>/<path>
--
-- with no session, no RLS and NO EXPIRY. Two of the public buckets are
-- document-class:
--
--   documents        — board packets (brokerage production, pipeline, attributed
--                      GCI, QuickBooks reconciliation), offer attachments,
--                      signed listing agreements and disclosures, inbound-email
--                      attachments, agent certificates, exported reports.
--   brokerage-forms  — broker-uploaded transaction forms, AND the FILLED copies
--                      written alongside them under filled/ by
--                      app/actions/buyer-offer/prefill-storage-form.ts. A filled
--                      offer form carries the buyer's name, the price and the
--                      terms. Note that prefill-storage-form already mints a
--                      createSignedUrl for those — which is theatre while the
--                      bucket itself is public, because the object is readable
--                      at its public URL with no token at all.
--
-- ── WHY THIS IS SAFE *RIGHT NOW*, AND ONLY RIGHT NOW ──────────────────────
-- MEASURED live against project hrvaqgvukzxfskkcrwbt on 2026-08-22:
--
--   select b.name, b.public,
--          (select count(*) from storage.objects o where o.bucket_id = b.id)
--     from storage.buckets b order by b.public desc, b.name;
--
--   public=true : agent-media(0) brokerage-assets(0) brokerage-forms(0)
--                 business-cards(0) documents(0) listing-media(0) media(0)
--                 video-assets(0)
--   public=false: client-documents(0) offer-documents(0) transaction-documents(0)
--
--   EVERY BUCKET HOLDS ZERO OBJECTS. There is no object whose public URL is in
--   anyone's hands, so flipping visibility breaks NOTHING today.
--
-- STATE THIS PLAINLY: after production traffic starts, this same statement WOULD
-- break already-issued URLs — every /object/public/... link that had been mailed,
-- webhooked, embedded or bookmarked stops resolving the moment the flag flips.
-- And the mirror of that is the reason the window matters: a public URL that has
-- ALREADY been emailed stays valid against its object FOREVER while the bucket
-- stays public. It cannot be revoked, rotated or expired — only the object's
-- deletion ends it. So the choice after launch is between breaking live links and
-- leaving un-revokable ones outstanding. Today there is no such choice to make.
--
-- ── ORDER OF OPERATIONS FOR THE INTEGRATOR ────────────────────────────────
-- The code changes in this lane must land FIRST. Once these buckets are private,
-- getPublicUrl returns a URL that 403s, so any remaining getPublicUrl call site
-- on `documents` / `brokerage-forms` becomes a silently broken link rather than a
-- leak. `npm run test:public-bucket-egress` is the check that no such call site
-- remains; run it before applying this.
--
-- Buckets NOT touched, and why (see lib/storage/document-buckets.ts for the one
-- classification these mirror):
--   listing-media, agent-media, business-cards, brokerage-assets, media,
--   video-assets — marketing images, headshots, logos, generated cards, and
--   audio/video that public pages, render workers and telephony carriers fetch
--   unauthenticated. Public is CORRECT for these; signing them would be theatre.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

-- 1. THE VISIBILITY FLIP ────────────────────────────────────────────────────
update storage.buckets
   set public = false
 where id in ('documents', 'brokerage-forms')
   and public is true;

-- 2. THE RLS HALF, WHICH THE FLIP ALONE DOES NOT DO ────────────────────────
-- A private bucket still serves /object/authenticated/<bucket>/<path> to anyone
-- whose JWT satisfies an RLS policy on storage.objects. `brokerage-forms` today
-- carries a SELECT policy granted to role `public`, which includes `anon` — so
-- flipping the bucket without dropping that policy would leave an anon key able
-- to read every form through the authenticated endpoint. Measured 2026-08-22:
--
--   policyname                  cmd     roles           qual
--   'public read brokerage-forms' SELECT {public}  bucket_id = 'brokerage-forms'
--
-- Replace it with an authenticated-only read, matching the shape already used by
-- client-documents / offer-documents / transaction-documents ('auth read …').
drop policy if exists "public read brokerage-forms" on storage.objects;

do $$
begin
  if not exists (
    select 1 from pg_policies
     where schemaname = 'storage' and tablename = 'objects'
       and policyname = 'auth read brokerage-forms'
  ) then
    create policy "auth read brokerage-forms"
      on storage.objects for select to authenticated
      using (bucket_id = 'brokerage-forms');
  end if;
end $$;

-- 3. THE MISSING BUCKET ────────────────────────────────────────────────────
-- `agent-documents` is written by app/dashboard/onboarding/license — the agent's
-- real-estate LICENSE document and their E&O insurance certificate — and it does
-- NOT EXIST in the live project (it is absent from the eleven measured above).
-- Those uploads therefore fail today with "Bucket not found". It is written from
-- the BROWSER, so lib/storage/buckets.ts#ensureBucket never sees it and cannot
-- create it. Created here, PRIVATE, with an authenticated-only read — the same
-- shape as client-documents.
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

-- `documents` has NO policies on storage.objects at all (measured 2026-08-22 —
-- it is absent from every row of pg_policies for storage.objects). Its reads
-- have been served purely by public=true and its writes purely by the service
-- role. Once private, only the service role can read or sign it — which is what
-- every remaining call site uses (createServiceClient), so no policy is added
-- here. Adding an `authenticated` read policy would WIDEN access, not narrow it,
-- and would be a change nobody asked for.

commit;

-- ── VERIFY AFTER APPLYING ──────────────────────────────────────────────────
-- select id, public from storage.buckets order by public desc, id;
--   → expect public=true for exactly: agent-media, brokerage-assets,
--     business-cards, listing-media, media, video-assets
--   → expect public=false for: brokerage-forms, client-documents, documents,
--     offer-documents, transaction-documents
--
-- select policyname, cmd, roles::text from pg_policies
--  where schemaname='storage' and tablename='objects'
--    and policyname ilike '%brokerage-forms%';
--   → expect NO row with roles containing 'public' for cmd='SELECT'
--
-- ── STILL UNRESOLVED, FOR THE OWNER ───────────────────────────────────────
-- Four document-class buckets DO NOT EXIST live yet — cda-templates, cda-filled,
-- commission-agreements, receipts. They are created on first write by
-- lib/storage/buckets.ts#ensureBucket, whose default this lane changed from
-- `public: true` to the bucket's CLASS, so they will be born private. There is
-- nothing to flip here until they exist; if the integrator would rather they
-- exist up front, create them with public=false and an authenticated-read policy
-- before first traffic.
