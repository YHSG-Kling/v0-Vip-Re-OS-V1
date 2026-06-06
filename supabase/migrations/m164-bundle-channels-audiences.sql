-- m164 — bundle channel expansion + audience tier scope (Wave 38).
--
-- Three concerns:
--
-- ── 1) facebook_custom_audiences gets agent_user_id (tier scope)
--    Currently brokerage_id only. The user wants TWO retargeting
--    audience layers:
--      · brokerage-tier: all leads → brokerage FB audience
--      · agent-tier:     contacts assigned to the agent → agent's
--                        personal FB audience (for their own ad spend)
--    agent_user_id NULL = brokerage-tier (existing rows backfill);
--    SET = agent-tier (the audience belongs to that agent's FB ad
--    account).
--
-- ── 2) audience_members — per-(audience × contact/lead) sync ledger
--    Tracks which contacts + leads landed in which audiences and
--    when. Provides idempotency for the sync workers (don't double-
--    push) + the cleanup path (when a contact opts out, the
--    desync helper finds every audience they're in via this table).
--
-- ── 3) New preset tables + bundle channel widening
--    voicedrop_presets — ringless voicemail (Slybroadcast / Drop.co
--      via connector-gateway). Body is a TTS prompt OR a hosted
--      audio_url. Compliance: TCPA still applies — same gate as SMS.
--    portal_push_presets — writes a client_portal_messages row for
--      the contact's portal. Title + body_md + cta_url + cta_label.
--    podcast_episode_presets — links to an existing podcast_episodes
--      row + targets podcast_distribution_channels for a one-click
--      coordinated push.
--    ad_retarget_presets — stages an ad_campaigns row + ties to a
--      facebook_custom_audiences entry. Bundle dispatch fires the
--      audience sync + queues the ad creative.
--
-- campaign_bundle_items.channel CHECK widened to include 4 new kinds.

alter table public.facebook_custom_audiences
  add column if not exists agent_user_id uuid,
  add column if not exists scope_type    text default 'brokerage'
    check (scope_type in ('agent', 'team', 'brokerage'));

create index if not exists idx_fca_scope
  on public.facebook_custom_audiences (brokerage_id, scope_type, agent_user_id);

-- Members ledger.
create table if not exists public.audience_members (
  id                uuid primary key default gen_random_uuid(),
  brokerage_id      uuid not null references public.brokerages(id) on delete cascade,
  audience_id       uuid not null references public.facebook_custom_audiences(id) on delete cascade,
  contact_id        uuid,
  lead_id           uuid,
  sync_status       text not null default 'pending'
    check (sync_status in ('pending', 'synced', 'failed', 'removed')),
  consent_snapshot  jsonb,   -- consent_basis at time of add (so removal recovers it)
  added_at          timestamptz default now(),
  synced_at         timestamptz,
  removed_at        timestamptz,
  /** Lock to one row per (audience, recipient). lead_id OR contact_id
   *  identifies the recipient — both can be set when the lead's been
   *  converted to a contact (preserves the lead-id-history). */
  unique (audience_id, contact_id, lead_id)
);

create index if not exists idx_audience_members_status
  on public.audience_members (audience_id, sync_status);
create index if not exists idx_audience_members_contact
  on public.audience_members (contact_id) where contact_id is not null;
create index if not exists idx_audience_members_lead
  on public.audience_members (lead_id) where lead_id is not null;

-- Voicedrop presets (ringless voicemail).
create table if not exists public.voicedrop_presets (
  id                  uuid primary key default gen_random_uuid(),
  brokerage_id        uuid not null references public.brokerages(id) on delete cascade,
  scope_type          text not null default 'brokerage' check (scope_type in ('agent', 'team', 'brokerage')),
  scope_id            uuid not null,
  name                text not null,
  -- One of: tts_script (we generate with ElevenLabs the agent's
  -- cloned voice) OR audio_url (broker pre-uploaded MP3).
  tts_script          text,
  audio_url           text,
  voice_id_override   text,    -- ElevenLabs voice id; null = agent's default clone
  compliance_event_id uuid references public.compliance_events(id) on delete set null,
  is_active           boolean default true,
  created_by          uuid,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now(),
  unique (brokerage_id, name),
  check (tts_script is not null or audio_url is not null)
);

create index if not exists idx_voicedrop_presets_scope
  on public.voicedrop_presets (brokerage_id, scope_type, scope_id)
  where is_active = true;

-- Portal push presets (for contacts with active portal access).
create table if not exists public.portal_push_presets (
  id                  uuid primary key default gen_random_uuid(),
  brokerage_id        uuid not null references public.brokerages(id) on delete cascade,
  scope_type          text not null default 'brokerage' check (scope_type in ('agent', 'team', 'brokerage')),
  scope_id            uuid not null,
  name                text not null,
  title               text not null,
  body_md             text not null,
  cta_url             text,
  cta_label           text,
  priority            text default 'normal' check (priority in ('low', 'normal', 'high', 'urgent')),
  compliance_event_id uuid references public.compliance_events(id) on delete set null,
  is_active           boolean default true,
  created_by          uuid,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now(),
  unique (brokerage_id, name)
);

create index if not exists idx_portal_push_presets_scope
  on public.portal_push_presets (brokerage_id, scope_type, scope_id)
  where is_active = true;

-- Podcast episode presets — link to an existing podcast_episodes row.
create table if not exists public.podcast_episode_presets (
  id                       uuid primary key default gen_random_uuid(),
  brokerage_id             uuid not null references public.brokerages(id) on delete cascade,
  scope_type               text not null default 'brokerage' check (scope_type in ('agent', 'team', 'brokerage')),
  scope_id                 uuid not null,
  name                     text not null,
  podcast_episode_id       uuid,  -- nullable so an unpublished episode can be staged
  -- Comma-separated dist channels (the publishers expand internally).
  target_distribution_channels text[],
  is_active                boolean default true,
  created_by               uuid,
  created_at               timestamptz default now(),
  updated_at               timestamptz default now(),
  unique (brokerage_id, name)
);

create index if not exists idx_podcast_episode_presets_scope
  on public.podcast_episode_presets (brokerage_id, scope_type, scope_id)
  where is_active = true;

-- Ad retarget presets — stages an ad_campaigns row when dispatched.
create table if not exists public.ad_retarget_presets (
  id                  uuid primary key default gen_random_uuid(),
  brokerage_id        uuid not null references public.brokerages(id) on delete cascade,
  scope_type          text not null default 'brokerage' check (scope_type in ('agent', 'team', 'brokerage')),
  scope_id            uuid not null,
  name                text not null,
  -- Target FB custom audience the ad runs against.
  facebook_audience_id uuid references public.facebook_custom_audiences(id) on delete set null,
  ad_headline         text,
  ad_body             text,
  ad_cta              text,
  ad_image_url        text,
  ad_landing_url      text,
  daily_budget_cents  bigint default 1000,  -- $10/day default
  compliance_event_id uuid references public.compliance_events(id) on delete set null,
  is_active           boolean default true,
  created_by          uuid,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now(),
  unique (brokerage_id, name)
);

create index if not exists idx_ad_retarget_presets_scope
  on public.ad_retarget_presets (brokerage_id, scope_type, scope_id)
  where is_active = true;

-- Widen the bundle items channel CHECK constraint to admit the 4 new kinds.
alter table public.campaign_bundle_items
  drop constraint if exists campaign_bundle_items_channel_check;
alter table public.campaign_bundle_items
  add constraint campaign_bundle_items_channel_check
  check (channel in (
    'direct_mail_postcard', 'direct_mail_letter',
    'email', 'social_post', 'sms',
    'voicedrop', 'portal_push', 'podcast_episode', 'ad_retarget'
  ));

comment on table public.audience_members        is 'Wave 38: per-(audience × contact|lead) sync ledger. Idempotency + desync recovery for facebook_custom_audiences pushes.';
comment on table public.voicedrop_presets       is 'Wave 38: ringless voicemail presets. TCPA gate applies at dispatch via Twilio/Slybroadcast.';
comment on table public.portal_push_presets     is 'Wave 38: portal card presets — writes client_portal_messages row for contacts with active portal access.';
comment on table public.podcast_episode_presets is 'Wave 38: podcast episode presets — links to a podcast_episodes row + targets distribution channels.';
comment on table public.ad_retarget_presets     is 'Wave 38: ad retarget presets — runs an ad_campaigns row against a facebook_custom_audiences entry.';
