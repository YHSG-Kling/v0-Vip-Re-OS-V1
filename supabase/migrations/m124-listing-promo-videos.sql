-- m124 — listing-promo video ledger.
-- One row per (listing × event_type) — idempotent. Reactor fires on
-- LISTING_PUBLISHED / TRANSACTION_CLOSED; downstream cron drafts social_posts
-- when the render lands.

create table if not exists public.listing_promo_videos (
  id                 uuid primary key default gen_random_uuid(),
  brokerage_id       uuid not null references public.brokerages(id) on delete cascade,
  listing_id         uuid not null references public.listings(id)   on delete cascade,
  agent_id           uuid not null references public.users(id)      on delete cascade,
  video_project_id   uuid references public.ai_video_projects(id)   on delete set null,
  event_type         text not null check (event_type in ('just_listed','just_sold','price_changed')),
  status             text not null default 'queued'
                     check (status in ('queued','rendering','social_drafted','failed','suppressed')),
  social_post_ids    uuid[] not null default array[]::uuid[],
  error_message      text,
  created_at         timestamptz not null default now(),
  drafted_at         timestamptz
);

create unique index if not exists uq_listing_promo_videos_event
  on public.listing_promo_videos (listing_id, event_type);

create index if not exists idx_listing_promo_videos_brokerage_status
  on public.listing_promo_videos (brokerage_id, status, created_at desc);

alter table public.listing_promo_videos enable row level security;

create policy listing_promo_videos_select_brokerage
  on public.listing_promo_videos
  for select
  to authenticated
  using (
    brokerage_id in (select brokerage_id from public.users where id = auth.uid())
    or exists (select 1 from public.users where id = auth.uid() and user_type = 'superadmin')
  );

comment on table public.listing_promo_videos is
  'Auto-generated listing promo video ledger. One per (listing × event_type) — idempotent.';
