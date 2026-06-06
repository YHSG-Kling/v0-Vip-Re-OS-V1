-- m113 — De-Conflict Engine audit log.
-- Sits at the connector-gateway egress (same chokepoint as compliance + TCPA).
-- Decisions allowed pass-through; decisions suppressed short-circuit the send.
-- The table is the transparency layer the broker cockpit reads for "what got
-- deferred this week and why" — MoxiWorks cannot ship this because their
-- channels don't share an egress.

create table if not exists public.deconflict_suppression_log (
  id                 uuid primary key default gen_random_uuid(),
  brokerage_id       uuid not null references public.brokerages(id) on delete cascade,
  contact_id         uuid references public.contacts(id) on delete set null,
  recipient_email    text,
  recipient_phone    text,
  channel            text not null check (channel in ('email','sms','phone','mail','video')),
  system_source      text,
  outcome            text not null check (outcome in ('allowed','suppressed_over_touch','suppressed_cooldown','allowed_with_warning')),
  reason             text,
  touches_in_window  integer not null default 0,
  window_days        integer not null default 14,
  policy_max         integer,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

create index if not exists idx_deconflict_brokerage_contact_time
  on public.deconflict_suppression_log (brokerage_id, contact_id, created_at desc);
create index if not exists idx_deconflict_brokerage_outcome_time
  on public.deconflict_suppression_log (brokerage_id, outcome, created_at desc);

alter table public.deconflict_suppression_log enable row level security;

create policy deconflict_select_brokerage
  on public.deconflict_suppression_log
  for select
  to authenticated
  using (
    brokerage_id in (select brokerage_id from public.users where id = auth.uid())
    or exists (select 1 from public.users where id = auth.uid() and user_type = 'superadmin')
  );

comment on table public.deconflict_suppression_log is
  'De-Conflict Engine egress audit. Every dispatch attempt across email/sms/phone/mail/video logs one row, allowed or suppressed.';
