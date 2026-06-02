-- m121 — agent intro / anniversary video tracker.
-- One row per (contact × agent × trigger-occasion) so the reactor never renders
-- a second intro for the same assignment, and the anniversary cron never
-- renders the same year's anniversary video twice. Links to the canonical
-- ai_video_projects row that holds the actual D-ID render output.

create table if not exists public.agent_intro_videos (
  id                   uuid primary key default gen_random_uuid(),
  brokerage_id         uuid not null references public.brokerages(id) on delete cascade,
  contact_id           uuid not null references public.contacts(id)   on delete cascade,
  agent_id             uuid not null references public.users(id)      on delete cascade,
  video_project_id     uuid references public.ai_video_projects(id)   on delete set null,
  trigger              text not null check (trigger in ('lead_assigned','home_anniversary')),
  trigger_year         integer,
  status               text not null default 'queued'
                       check (status in ('queued','rendering','delivered','failed','suppressed')),
  delivery_channel     text not null default 'email'
                       check (delivery_channel in ('email','portal','both')),
  error_message        text,
  created_at           timestamptz not null default now(),
  delivered_at         timestamptz
);

create unique index if not exists uq_agent_intro_videos_per_trigger
  on public.agent_intro_videos (contact_id, agent_id, trigger, coalesce(trigger_year, 0));

create index if not exists idx_agent_intro_videos_brokerage_status
  on public.agent_intro_videos (brokerage_id, status, created_at desc);

alter table public.agent_intro_videos enable row level security;

create policy agent_intro_videos_select_brokerage
  on public.agent_intro_videos
  for select
  to authenticated
  using (
    brokerage_id in (select brokerage_id from public.users where id = auth.uid())
    or exists (select 1 from public.users where id = auth.uid() and user_type = 'superadmin')
  );

comment on table public.agent_intro_videos is
  'Idempotent ledger of agent-assignment + home-anniversary D-ID intro videos. The video itself lives in ai_video_projects; this row is the trigger-to-render dedup key.';
