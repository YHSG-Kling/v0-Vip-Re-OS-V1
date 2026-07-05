-- m267-platform-impersonation.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- STAFF "ACT AS TENANT" (GoHighLevel-style sub-account control). Platform staff
-- (superadmin/support) can enter any tenant and operate the app AS that tenant —
-- but ACCOUNTABLY: they keep their own auth identity; an impersonation session
-- record repoints the resolved workspace context to the target brokerage while
-- every action stays stamped with the real staff actor. This is the keystone that
-- collapses the need for N per-setting cross-tenant editors: staff step INTO the
-- tenant and use the tenant's own screens (service-client surfaces resolve the
-- target brokerage from getAgentContext).

create table if not exists public.platform_impersonation_sessions (
  id                  uuid primary key default gen_random_uuid(),
  actor_user_id       uuid not null references public.users(id) on delete cascade,   -- the staff member (real actor)
  actor_email         text,
  target_brokerage_id uuid not null references public.brokerages(id) on delete cascade,
  target_user_id      uuid references public.users(id) on delete set null,           -- optional: act as a specific user; else tenant-admin view
  mode                text not null default 'full' check (mode in ('read_only','full')),
  reason              text,
  ip_address          text,
  user_agent          text,
  started_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  ended_at            timestamptz
);

-- At most ONE active (not-yet-ended) session per staff actor.
create unique index if not exists ux_impersonation_active_actor
  on public.platform_impersonation_sessions (actor_user_id)
  where ended_at is null;

create index if not exists idx_impersonation_target
  on public.platform_impersonation_sessions (target_brokerage_id);

-- RLS: the row itself is platform-sensitive. Writes go through service-role staff
-- actions (RLS-bypassing). A staff user may READ their OWN active session so the
-- user-client getAgentContext seam can detect it — they can never see another
-- actor's session.
alter table public.platform_impersonation_sessions enable row level security;

drop policy if exists impersonation_actor_select on public.platform_impersonation_sessions;
create policy impersonation_actor_select
  on public.platform_impersonation_sessions
  for select
  using (actor_user_id = auth.uid());
