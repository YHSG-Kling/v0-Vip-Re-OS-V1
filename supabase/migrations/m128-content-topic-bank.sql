-- m128 — content intelligence layer.
-- content_topic_sources    — configured sources (Reddit, YouTube, Trends, RSS, manual)
-- content_topic_bank       — scored bank of recent topics the generators query

create table if not exists public.content_topic_sources (
  id              uuid primary key default gen_random_uuid(),
  source_type     text not null
                  check (source_type in ('reddit','youtube_search','google_trends','rss','manual')),
  source_config   jsonb not null default '{}'::jsonb,
  label           text,
  brokerage_id    uuid references public.brokerages(id) on delete cascade,
  is_active       boolean not null default true,
  last_run_at     timestamptz,
  created_at      timestamptz not null default now()
);

create index if not exists idx_content_topic_sources_active_type
  on public.content_topic_sources (is_active, source_type);

alter table public.content_topic_sources enable row level security;

create policy content_topic_sources_select_brokerage
  on public.content_topic_sources for select to authenticated
  using (
    brokerage_id is null
    or brokerage_id in (select brokerage_id from public.users where id = auth.uid())
    or exists (select 1 from public.users where id = auth.uid() and user_type = 'superadmin')
  );

create table if not exists public.content_topic_bank (
  id                  uuid primary key default gen_random_uuid(),
  source_id           uuid not null references public.content_topic_sources(id) on delete cascade,
  brokerage_id        uuid references public.brokerages(id) on delete cascade,
  topic_title         text not null,
  value_angle         text,
  source_url          text,
  raw_data            jsonb not null default '{}'::jsonb,
  engagement_score    integer not null default 0
                      check (engagement_score >= 0 and engagement_score <= 100),
  categories          text[] not null default array[]::text[],
  topic_posted_at     timestamptz,
  scraped_at          timestamptz not null default now(),
  expires_at          timestamptz not null default (now() + interval '21 days'),
  status              text not null default 'fresh'
                      check (status in ('fresh','used','stale','rejected'))
);

create unique index if not exists uq_content_topic_bank_source_url
  on public.content_topic_bank (source_id, source_url)
  where source_url is not null;

create index if not exists idx_content_topic_bank_picker
  on public.content_topic_bank (brokerage_id, status, engagement_score desc, expires_at desc);

create index if not exists idx_content_topic_bank_platform
  on public.content_topic_bank (status, engagement_score desc, expires_at desc)
  where brokerage_id is null;

alter table public.content_topic_bank enable row level security;

create policy content_topic_bank_select_brokerage
  on public.content_topic_bank for select to authenticated
  using (
    brokerage_id is null
    or brokerage_id in (select brokerage_id from public.users where id = auth.uid())
    or exists (select 1 from public.users where id = auth.uid() and user_type = 'superadmin')
  );

-- Seed platform-wide Reddit sources covering the highest-signal real-estate
-- subreddits. Brokerage-specific sources can be added via the admin UI.
insert into public.content_topic_sources (source_type, source_config, label, brokerage_id, is_active)
values
  ('reddit', '{"subreddit":"RealEstate","window":"week"}'::jsonb,            'r/RealEstate weekly top',          null, true),
  ('reddit', '{"subreddit":"FirstTimeHomeBuyer","window":"week"}'::jsonb,    'r/FirstTimeHomeBuyer weekly top',  null, true),
  ('reddit', '{"subreddit":"RealEstateAdvice","window":"week"}'::jsonb,      'r/RealEstateAdvice weekly top',    null, true),
  ('reddit', '{"subreddit":"Mortgages","window":"week"}'::jsonb,             'r/Mortgages weekly top',           null, true),
  ('reddit', '{"subreddit":"realtors","window":"week"}'::jsonb,              'r/realtors weekly top',            null, true)
on conflict do nothing;

comment on table public.content_topic_bank is
  'Value-first topic bank for autonomous content generators. Lead content comes FROM here; agent listings fold in as 20% supporting examples.';
