-- m242: neutral market-relationship segment for lifetime customers.
-- Drives WHICH nurture a past client gets: a local owner sees equity / maintenance /
-- next-move; a 'relocated' client (left our market — moved away, downsized out of
-- area, entered senior living, etc.) gets a referral-out + stay-in-touch lane instead.
-- IMPORTANT (fair housing): we store ONLY the neutral market fact ('relocated'),
-- never the reason (age/health/family) — those must never be recorded or targeted.
alter table contacts
  add column if not exists lifetime_segment text not null default 'local_owner';

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'contacts_lifetime_segment_check'
  ) then
    alter table contacts
      add constraint contacts_lifetime_segment_check
      check (lifetime_segment in ('local_owner','relocated'));
  end if;
end $$;

comment on column contacts.lifetime_segment is
  'Neutral market segment for lifetime customers: local_owner (default) | relocated. Never store the reason for relocation (fair housing).';
