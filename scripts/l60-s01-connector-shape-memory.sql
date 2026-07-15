-- l60-s01: CONNECTOR SHAPE MEMORY — the OS remembers every payload shape a
-- connector has ever sent (key paths only, never values — no PII). A new
-- fingerprint on a connector with history = a shape change, announced in the
-- weekly repair digest BEFORE anything quarantines. cron_manager owns this.

create table if not exists public.connector_shape_memory (
  id             uuid primary key default gen_random_uuid(),
  connector      text not null,
  entity         text not null,
  fingerprint    text not null,
  shape_keys     jsonb not null default '[]'::jsonb,
  first_seen_at  timestamptz not null default now(),
  last_seen_at   timestamptz not null default now(),
  hits           integer not null default 1,
  unique (connector, entity, fingerprint)
);

create index if not exists idx_connector_shape_memory_recent
  on public.connector_shape_memory (first_seen_at desc);

alter table public.connector_shape_memory enable row level security;
-- Service-role only (webhooks + cron); platform-scoped by design.
