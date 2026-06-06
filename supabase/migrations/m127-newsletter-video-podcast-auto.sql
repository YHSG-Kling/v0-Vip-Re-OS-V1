-- m127 — Wave 15 schema:
--   1. Widen newsletter_campaigns.status to include 'sending' + 'deferred'.
--   2. newsletter_video_renders ledger — once-per-campaign video.
--   3. podcast_auto_runs ledger — weekly per-brokerage podcast auto-producer.

alter table public.newsletter_campaigns
  drop constraint if exists newsletter_campaigns_status_check;

alter table public.newsletter_campaigns
  add constraint newsletter_campaigns_status_check
  check (status in ('draft','scheduled','sending','sent','deferred'));

comment on column public.newsletter_campaigns.status is
  'draft → scheduled → sending → sent. deferred = broadcast-cooldown skip from publish-newsletters cron.';

create table if not exists public.newsletter_video_renders (
  id                       uuid primary key default gen_random_uuid(),
  brokerage_id             uuid not null references public.brokerages(id) on delete cascade,
  newsletter_campaign_id   uuid not null references public.newsletter_campaigns(id) on delete cascade,
  agent_id                 uuid not null references public.users(id) on delete cascade,
  video_project_id         uuid references public.ai_video_projects(id) on delete set null,
  status                   text not null default 'queued'
                           check (status in ('queued','rendering','completed','failed','suppressed')),
  voiceover_url            text,
  video_url                text,
  error_message            text,
  created_at               timestamptz not null default now(),
  completed_at             timestamptz
);

create unique index if not exists uq_newsletter_video_renders_campaign
  on public.newsletter_video_renders (newsletter_campaign_id);

create index if not exists idx_newsletter_video_renders_brokerage_status
  on public.newsletter_video_renders (brokerage_id, status, created_at desc);

alter table public.newsletter_video_renders enable row level security;

create policy newsletter_video_renders_select_brokerage
  on public.newsletter_video_renders
  for select to authenticated
  using (
    brokerage_id in (select brokerage_id from public.users where id = auth.uid())
    or exists (select 1 from public.users where id = auth.uid() and user_type = 'superadmin')
  );

create table if not exists public.podcast_auto_runs (
  id                  uuid primary key default gen_random_uuid(),
  brokerage_id        uuid not null references public.brokerages(id) on delete cascade,
  agent_id            uuid not null references public.users(id) on delete cascade,
  iso_week            text not null,
  podcast_episode_id  uuid references public.podcast_episodes(id) on delete set null,
  status              text not null default 'queued'
                      check (status in ('queued','generating','rendered','published','failed','skipped')),
  script_word_count   integer,
  duration_seconds    integer,
  error_message       text,
  created_at          timestamptz not null default now(),
  completed_at        timestamptz
);

create unique index if not exists uq_podcast_auto_runs_brokerage_week
  on public.podcast_auto_runs (brokerage_id, iso_week);

create index if not exists idx_podcast_auto_runs_status_created
  on public.podcast_auto_runs (brokerage_id, status, created_at desc);

alter table public.podcast_auto_runs enable row level security;

create policy podcast_auto_runs_select_brokerage
  on public.podcast_auto_runs
  for select to authenticated
  using (
    brokerage_id in (select brokerage_id from public.users where id = auth.uid())
    or exists (select 1 from public.users where id = auth.uid() and user_type = 'superadmin')
  );
