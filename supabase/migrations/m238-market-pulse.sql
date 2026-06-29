-- m238 — MARKET PULSE: AI-distilled, seller-safe national buyer-priority insights (from real-estate
-- forum chatter) surfaced on the seller portal. Owned by campaign_orchestrator. Net-new CONTENT (not
-- journey state — Lifecycle-contract compliant). National scope → one pulse per week, shared by every
-- brokerage, so the scrape + AI distill runs ONCE per week (ensureNationalMarketPulse).

create table if not exists public.market_pulse (
  id            uuid primary key default gen_random_uuid(),
  scope         text not null default 'national',
  brokerage_id  uuid references public.brokerages(id) on delete cascade,
  pulse_week    date not null,
  insights      jsonb not null default '{}'::jsonb,
  source_count  integer not null default 0,
  generated_at  timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  unique (scope, pulse_week)
);
create index if not exists idx_market_pulse_week on public.market_pulse (pulse_week desc);

alter table public.market_pulse enable row level security;
-- National buyer-market intel (non-sensitive, distilled + seller-safe) — readable by any authenticated
-- user incl. seller portal users; only the platform/AI-ISA system writes it.
create policy market_pulse_select on public.market_pulse for select using (auth.role() = 'authenticated' OR public.is_platform_admin());
create policy market_pulse_write on public.market_pulse for all
  using (public.is_platform_admin() OR public.is_ai_isa_system())
  with check (public.is_platform_admin() OR public.is_ai_isa_system());

comment on table public.market_pulse is 'm238: AI-distilled, seller-safe national buyer-priority pulse (from real-estate forum chatter) surfaced on the seller portal. Owned by campaign_orchestrator.';
