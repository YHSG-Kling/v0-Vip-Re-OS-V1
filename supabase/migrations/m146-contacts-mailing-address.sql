-- m146 — canonical mailing address columns on contacts.
--
-- Wave 36. The contacts table held city/state/zip_code but no street
-- line, which meant the pre-listing physical kit (Lob mailer that
-- arrives 2-3 days before the appointment) couldn't actually address a
-- contact unless the platform pulled the address from the linked lead
-- row — which doesn't exist for contacts that arrived via referral,
-- import, or transaction. We add the canonical mailing-address surface
-- so every contact can be mailed regardless of how they entered.
--
-- The verification flag mirrors leads.mailing_address_verified: only
-- `true` after lib/external/lob-address-verify confirms deliverable.
-- dispatchDirectMail does NOT yet enforce this flag for contacts
-- (contacts have explicit consent from the assignment / agreement) but
-- the pre-listing kit step does check it to avoid burning Lob spend on
-- an unverified address. Future commits can widen the egress gate.
--
-- city/state/zip_code on contacts continues to hold the residence
-- address. The street line lives in mailing_address. (Leads model
-- separate mailing_city/state/zip because skip-tracing returns prior
-- + current addresses; for contacts the residence and mail-to are the
-- same value 99% of the time, so we reuse city/state/zip_code.)

alter table public.contacts
  add column if not exists mailing_address              text,
  add column if not exists mailing_address_verified     boolean default false,
  add column if not exists mailing_address_source       text,
  add column if not exists mailing_address_verified_at  timestamptz;

-- Partial index so the address-eligible contacts query for bulk
-- mailings stays fast as the contacts table grows.
create index if not exists idx_contacts_mailing_address_verified
  on public.contacts (brokerage_id)
  where mailing_address_verified = true;

comment on column public.contacts.mailing_address              is 'Street line for physical mailings (postcards, letters, pre-listing kit). Wave 36.';
comment on column public.contacts.mailing_address_verified     is 'true only after Lob US verification confirmed deliverability. Wave 36.';
comment on column public.contacts.mailing_address_source       is 'origin tag: ''lead_promotion'' | ''agent_entry'' | ''enrichment'' | ''lob_correction''. Wave 36.';
comment on column public.contacts.mailing_address_verified_at  is 'last Lob verification timestamp; re-verify after 12 months. Wave 36.';
