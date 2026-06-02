-- m131 — content performance feedback loop + Google Trends seeds.

create table if not exists public.content_topic_uses (
  id              uuid primary key default gen_random_uuid(),
  topic_id        uuid not null references public.content_topic_bank(id) on delete cascade,
  brokerage_id    uuid references public.brokerages(id) on delete cascade,
  asset_type      text not null
                  check (asset_type in ('podcast_episode','newsletter_video','newsletter_campaign','social_post','blog_post','marketing_plan_item')),
  asset_id        uuid,
  used_at         timestamptz not null default now()
);

create index if not exists idx_content_topic_uses_topic_recent
  on public.content_topic_uses (topic_id, used_at desc);

create index if not exists idx_content_topic_uses_brokerage_asset
  on public.content_topic_uses (brokerage_id, asset_type, used_at desc);

alter table public.content_topic_uses enable row level security;

create policy content_topic_uses_select_brokerage
  on public.content_topic_uses for select to authenticated
  using (
    brokerage_id is null
    or brokerage_id in (select brokerage_id from public.users where id = auth.uid())
    or exists (select 1 from public.users where id = auth.uid() and user_type = 'superadmin')
  );

alter table public.content_topic_bank
  add column if not exists performance_score integer not null default 0
    check (performance_score >= 0 and performance_score <= 30);

comment on column public.content_topic_bank.performance_score is
  'Rolling 30-day engagement boost (0..30). Picker adds to engagement_score so winners compound and flops decay.';

insert into public.content_topic_sources (source_type, source_config, label, brokerage_id, is_active)
values
  ('apify_actor', jsonb_build_object(
    'actor', 'emastra/google-trends-scraper',
    'input', jsonb_build_object('keywords', array['mortgage rates','first time home buyer','housing market'], 'geo', 'US', 'timeRange', 'now 7-d'),
    'title_field', 'query', 'url_field', 'trendUrl', 'engagement_fields', array['interest']
  ), 'Google Trends: 7-day US real estate keywords', null, true),
  ('apify_actor', jsonb_build_object(
    'actor', 'emastra/google-trends-scraper',
    'input', jsonb_build_object('keywords', array['refinance','FHA loan','closing costs','home inspection'], 'geo', 'US', 'timeRange', 'today 1-m'),
    'title_field', 'query', 'url_field', 'trendUrl', 'engagement_fields', array['interest']
  ), 'Google Trends: 30-day US borrower keywords', null, true)
on conflict do nothing;
