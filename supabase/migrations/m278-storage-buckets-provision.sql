-- m278 — provision the Storage buckets referenced by live upload code but never created.
--
-- Root cause of the observed "no bucket" / "file won't add" upload failures across
-- Listings media, Business Cards, Brokerage Forms, Content Studio, and the
-- Transaction / Offer / Client (W-9 / KYC) document flows: the code uploads to
-- seven buckets that were never provisioned. Only brokerage-assets, documents,
-- listing-media, and video-assets existed.
--
-- Visibility:
--   PUBLIC  (code serves these via getPublicUrl): business-cards, agent-media,
--           media (voice/TwiML audio), brokerage-forms
--   PRIVATE (sensitive KYC / deal documents — never publicly exposed):
--           client-documents, transaction-documents, offer-documents
--
-- Writes require an authenticated session (mirrors the existing listing-media
-- convention). Per-tenant path scoping is a later hardening pass; this unblocks
-- uploads securely without exposing sensitive documents to anonymous URL access.

insert into storage.buckets (id, name, public) values
  ('business-cards',        'business-cards',        true),
  ('agent-media',           'agent-media',           true),
  ('media',                 'media',                 true),
  ('brokerage-forms',       'brokerage-forms',       true),
  ('client-documents',      'client-documents',      false),
  ('transaction-documents', 'transaction-documents', false),
  ('offer-documents',       'offer-documents',       false)
on conflict (id) do nothing;

-- ── PUBLIC buckets: public read, authenticated write ──────────────────────────
do $$
declare b text;
begin
  foreach b in array array['business-cards','agent-media','media','brokerage-forms'] loop
    execute format($f$create policy %I on storage.objects for select to public using (bucket_id = %L)$f$,
      'public read '||b, b);
    execute format($f$create policy %I on storage.objects for insert to authenticated with check (bucket_id = %L)$f$,
      'auth upload '||b, b);
    execute format($f$create policy %I on storage.objects for update to authenticated using (bucket_id = %L)$f$,
      'auth update '||b, b);
    execute format($f$create policy %I on storage.objects for delete to authenticated using (bucket_id = %L)$f$,
      'auth delete '||b, b);
  end loop;
end $$;

-- ── PRIVATE buckets: authenticated read + write only (no public exposure) ──────
do $$
declare b text;
begin
  foreach b in array array['client-documents','transaction-documents','offer-documents'] loop
    execute format($f$create policy %I on storage.objects for select to authenticated using (bucket_id = %L)$f$,
      'auth read '||b, b);
    execute format($f$create policy %I on storage.objects for insert to authenticated with check (bucket_id = %L)$f$,
      'auth upload '||b, b);
    execute format($f$create policy %I on storage.objects for update to authenticated using (bucket_id = %L)$f$,
      'auth update '||b, b);
    execute format($f$create policy %I on storage.objects for delete to authenticated using (bucket_id = %L)$f$,
      'auth delete '||b, b);
  end loop;
end $$;
