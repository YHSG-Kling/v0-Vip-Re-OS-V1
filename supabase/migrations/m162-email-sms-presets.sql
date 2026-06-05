-- m162 — email_presets + sms_presets (Wave 37 bundle channels).
--
-- Same architectural shape as direct_mail_presets: locked subject +
-- body + compliance gate snapshot at save time, tier-scoped (agent /
-- team / brokerage), is_active soft-delete. Each preset is a fixed
-- piece of creative the bundle dispatcher invokes verbatim — no AI
-- redraft per send.
--
-- Why three separate preset tables (not one polymorphic):
--   · Each channel has channel-specific fields (email needs reply_to,
--     subject, html, plain_text; SMS needs sender_phone; social needs
--     platform array, media_urls). A polymorphic table either makes
--     half the fields NULL or forces a jsonb soup. Separate tables
--     keep validation + indexing tight.
--   · The bundle dispatcher's switch routes by channel kind to the
--     right preset table — same shape it already uses for direct_mail.

create table if not exists public.email_presets (
  id                       uuid primary key default gen_random_uuid(),
  brokerage_id             uuid not null references public.brokerages(id) on delete cascade,
  scope_type               text not null default 'brokerage' check (scope_type in ('agent', 'team', 'brokerage')),
  scope_id                 uuid not null,
  name                     text not null,
  subject                  text not null,
  body_html                text not null,
  body_text                text,
  from_name_override       text,
  reply_to_override        text,
  channel_purpose          text default 'campaign' check (channel_purpose in ('conversation', 'campaign', 'update', 'transactional')),
  compliance_event_id      uuid references public.compliance_events(id) on delete set null,
  is_active                boolean default true,
  created_by               uuid,
  created_at               timestamptz default now(),
  updated_at               timestamptz default now(),
  unique (brokerage_id, name)
);

create index if not exists idx_email_presets_scope
  on public.email_presets (brokerage_id, scope_type, scope_id)
  where is_active = true;

create table if not exists public.sms_presets (
  id                       uuid primary key default gen_random_uuid(),
  brokerage_id             uuid not null references public.brokerages(id) on delete cascade,
  scope_type               text not null default 'brokerage' check (scope_type in ('agent', 'team', 'brokerage')),
  scope_id                 uuid not null,
  name                     text not null,
  body                     text not null,
  compliance_event_id      uuid references public.compliance_events(id) on delete set null,
  is_active                boolean default true,
  created_by               uuid,
  created_at               timestamptz default now(),
  updated_at               timestamptz default now(),
  unique (brokerage_id, name)
);

create index if not exists idx_sms_presets_scope
  on public.sms_presets (brokerage_id, scope_type, scope_id)
  where is_active = true;

comment on table public.email_presets is 'Wave 37: locked-creative email presets for bundle dispatch. Compliance gate runs at save time; dispatch is gate-free per piece.';
comment on table public.sms_presets   is 'Wave 37: locked-creative SMS presets for bundle dispatch. TCPA enforcement still applies at dispatch time via dispatchSMS.';
