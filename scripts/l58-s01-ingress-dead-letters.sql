-- l58-s01: INGRESS DEAD LETTERS — the Continuity Engine's "data stuck between
-- a webhook and where it belongs" rail. A provider webhook that matches NO
-- artifact of record parks here (instead of evaporating behind a 200), the
-- daily reconciler replays it the moment the artifact appears, and a letter
-- that never matches is abandoned + escalated. cron_manager owns this table.

create table if not exists public.ingress_dead_letters (
  id               uuid primary key default gen_random_uuid(),
  provider         text not null,
  event_kind       text not null,
  external_ref     text not null,
  payload          jsonb not null default '{}'::jsonb,
  status           text not null default 'pending' check (status in ('pending','reconciled','abandoned')),
  attempts         integer not null default 0,
  last_attempt_at  timestamptz,
  reconciled_at    timestamptz,
  created_at       timestamptz not null default now(),
  unique (provider, event_kind, external_ref)
);

create index if not exists idx_ingress_dead_letters_pending
  on public.ingress_dead_letters (status, created_at)
  where status = 'pending';

alter table public.ingress_dead_letters enable row level security;
-- Service-role only (webhooks + cron); no tenant policies by design — a dead
-- letter has no brokerage until it matches.
