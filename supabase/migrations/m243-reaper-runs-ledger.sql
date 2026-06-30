-- m243: the REAPER-RUN LEDGER — the autonomous-AI accountability trail.
-- Every sweep of every reaper in the net records what it scanned, caught (reaped),
-- and escalated, per manager domain. Powers the daily manager standup's "what your
-- AI team caught" line and proves governed autonomy (the receipt that nothing fell
-- through the cracks).
create table if not exists reaper_runs (
  id            uuid primary key default gen_random_uuid(),
  brokerage_id  uuid not null,
  domain        text not null,           -- reaper domain key (e.g. 'stale_video_workflows')
  manager       text not null,           -- owning manager-registry key
  scanned       integer not null default 0,
  escalated     integer not null default 0,
  reaped        integer not null default 0,
  detail        text,
  ran_at        timestamptz not null default now()
);

create index if not exists idx_reaper_runs_recent  on reaper_runs (brokerage_id, ran_at desc);
create index if not exists idx_reaper_runs_manager  on reaper_runs (brokerage_id, manager, ran_at desc);

comment on table reaper_runs is
  'Autonomous-AI accountability ledger: one row per reaper-net domain per sweep (scanned/reaped/escalated). Powers the manager standup and proves nothing falls through the cracks.';
