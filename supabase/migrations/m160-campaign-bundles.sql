-- m160 — multi-channel campaign bundles (Wave 37 item #3).
--
-- A bundle is N presets that fire as ONE coordinated campaign across
-- channels. Use cases:
--   · Listing launch: 6×9 postcard + email blast + social post in 24h
--   · Anniversary campaign: postcard + personalized email + SMS
--   · Just-Sold celebration: postcard to farm + email to sphere +
--     social cross-post
--
-- Bundle dispatch fires each preset in sequence; every resulting
-- direct_mail_campaigns row gets the shared bundle_dispatch_id stamp
-- so cross-channel attribution works downstream (the marketing-agent
-- snapshot can answer "this BUNDLE drove N leads across channels"
-- rather than counting per-channel).
--
-- Each bundle item has a channel kind. v1 supports postcard + letter
-- (both via direct_mail_presets). Future kinds: email, social_post,
-- sms — those will land as separate XX_presets tables joined the
-- same way.

create table if not exists public.campaign_bundles (
  id           uuid primary key default gen_random_uuid(),
  brokerage_id uuid not null references public.brokerages(id) on delete cascade,
  name         text not null,
  description  text,
  is_active    boolean default true,
  created_by   uuid,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  unique (brokerage_id, name)
);

create index if not exists idx_campaign_bundles_active
  on public.campaign_bundles (brokerage_id)
  where is_active = true;

-- Bundle items — ordered list of (channel, preset_id) pairs the
-- dispatcher fires in sequence. order_index controls timing intent
-- (the dispatcher doesn't enforce delays in v1; future: per-item
-- send_after_minutes).
create table if not exists public.campaign_bundle_items (
  id                 uuid primary key default gen_random_uuid(),
  bundle_id          uuid not null references public.campaign_bundles(id) on delete cascade,
  brokerage_id       uuid not null references public.brokerages(id) on delete cascade,
  channel            text not null check (channel in ('direct_mail_postcard', 'direct_mail_letter', 'email', 'social_post', 'sms')),
  -- Polymorphic preset reference. v1 points to direct_mail_presets;
  -- future channels add their own preset tables.
  preset_id          uuid,
  order_index        integer not null default 0,
  send_after_minutes integer default 0,    -- staggered scheduling (v2 honors)
  created_at         timestamptz default now(),
  unique (bundle_id, channel, preset_id)
);

create index if not exists idx_campaign_bundle_items_bundle
  on public.campaign_bundle_items (bundle_id, order_index);

-- Per-dispatch ledger row so cross-channel attribution survives the
-- bundle structure. One row per (bundle, recipient) dispatch — the
-- pieces it fired all share this bundle_dispatch_id.
create table if not exists public.campaign_bundle_dispatches (
  id            uuid primary key default gen_random_uuid(),
  bundle_id     uuid not null references public.campaign_bundles(id) on delete cascade,
  brokerage_id  uuid not null references public.brokerages(id) on delete cascade,
  contact_id    uuid,
  lead_id       uuid,
  -- Channel-by-channel outcome jsonb so the analytics view can answer
  -- "which channels succeeded for this bundle dispatch":
  --   { "direct_mail_postcard": { success: true, lob_order_id: "..." },
  --     "email": { success: false, error: "..." }, ... }
  channel_outcomes jsonb default '{}'::jsonb,
  dispatched_at timestamptz default now(),
  -- Aggregate attribution: did ANY scan + ANY contact capture come
  -- back to this bundle? Daily aggregator updates.
  scans_count   integer default 0,
  leads_count   integer default 0,
  updated_at    timestamptz default now()
);

create index if not exists idx_campaign_bundle_dispatches_bundle_recent
  on public.campaign_bundle_dispatches (bundle_id, dispatched_at desc);
create index if not exists idx_campaign_bundle_dispatches_brokerage_recent
  on public.campaign_bundle_dispatches (brokerage_id, dispatched_at desc);

-- Stamp every direct_mail_campaigns row that fired from a bundle
-- dispatch so the existing variant outcomes aggregator can JOIN
-- bundle_dispatch_id → bundle_id → bundle analytics.
alter table public.direct_mail_campaigns
  add column if not exists bundle_dispatch_id uuid;

alter table public.direct_mail_campaigns
  drop constraint if exists direct_mail_campaigns_bundle_dispatch_id_fkey;
alter table public.direct_mail_campaigns
  add constraint direct_mail_campaigns_bundle_dispatch_id_fkey
  foreign key (bundle_dispatch_id)
  references public.campaign_bundle_dispatches(id)
  on delete set null;

create index if not exists idx_direct_mail_campaigns_bundle_dispatch
  on public.direct_mail_campaigns (bundle_dispatch_id)
  where bundle_dispatch_id is not null;

comment on table public.campaign_bundles            is 'Wave 37: multi-channel campaign bundles. N presets that fire as ONE coordinated dispatch.';
comment on table public.campaign_bundle_items       is 'Wave 37: ordered (channel × preset) items in a bundle.';
comment on table public.campaign_bundle_dispatches  is 'Wave 37: per-(bundle × recipient) dispatch ledger. Shared bundle_dispatch_id stamps every downstream campaign row for cross-channel attribution.';
comment on column public.direct_mail_campaigns.bundle_dispatch_id is 'Wave 37: which bundle dispatch fired this piece (null for non-bundle sends).';
