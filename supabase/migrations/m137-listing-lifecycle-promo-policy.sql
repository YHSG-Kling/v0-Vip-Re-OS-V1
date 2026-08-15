-- m137 — listing-lifecycle promo policy + widen event_type taxonomy.
--
-- Wave 27. Option C per-subscriber policy: brokerage / team / agent each
-- get to opt each lifecycle event in or out. Resolution hierarchy at
-- runtime walks agent override → team override → brokerage default →
-- platform default. Each step is a single B-tree probe on the unique
-- (scope_type, scope_id, event_type) key.
--
-- Platform defaults (no row required) — when no override matches:
--   coming_soon         → false   (agent opts in per listing; sensitive)
--   just_listed         → true    (existing behavior)
--   open_house_announce → true    (event-bound, expected)
--   open_house_reminder → true    (T-24h; conversion lever)
--   price_reduction     → false   (sensitive; agent opts in)
--   under_contract      → true    ("off market" social-proof moment)
--   just_sold           → true    (existing behavior)
--
-- The platform default lives in code (lib/kernel/lifecycle-promo-policy.ts)
-- so brokerages don't need to seed any rows. Overrides are only inserted
-- when a subscriber explicitly toggles a setting in the UI.
--
-- cooldown_hours is an optional debounce per (scope, event_type) so a
-- brokerage that flips one listing's price three times in a day only
-- fires one price_reduction promo. NULL = no cooldown (default for most
-- events except price_reduction which defaults to 24h in code).

create table if not exists public.lifecycle_promo_policy (
  id                uuid primary key default gen_random_uuid(),
  scope_type        text not null check (scope_type in ('agent','team','brokerage')),
  scope_id          uuid not null,
  event_type        text not null check (event_type in (
    'coming_soon','just_listed','open_house_announce','open_house_reminder',
    'price_reduction','under_contract','just_sold'
  )),
  auto_spawn        boolean not null default true,
  cooldown_hours    integer,
  updated_at        timestamptz not null default now(),
  updated_by        uuid references public.users(id) on delete set null,
  unique (scope_type, scope_id, event_type)
);

create index if not exists idx_lifecycle_promo_policy_lookup
  on public.lifecycle_promo_policy (scope_type, scope_id, event_type);

alter table public.lifecycle_promo_policy enable row level security;
create policy "service_role_full"
  on public.lifecycle_promo_policy
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- Widen listing_promo_videos.event_type to the 7 lifecycle moments.
-- The reactor's existing 'price_changed' value migrates to 'price_reduction'
-- to match the new vocabulary (existing rows backfilled below).
alter table public.listing_promo_videos
  drop constraint if exists listing_promo_videos_event_type_check;

-- Backfill any existing 'price_changed' rows to the new vocabulary BEFORE
-- the new check constraint goes on.
update public.listing_promo_videos
  set event_type = 'price_reduction'
  where event_type = 'price_changed';

alter table public.listing_promo_videos
  add constraint listing_promo_videos_event_type_check
  check (event_type in (
    'coming_soon','just_listed','open_house_announce','open_house_reminder',
    'price_reduction','under_contract','just_sold'
  ));
