-- ── APPLIED LIVE 2026-11-18 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 154, lane 154G3 ── read back: table circle_tactic_shares (16 columns), 4 foreign keys (brokerages, users, teams, agent_mentor_relationships), 5 CHECKs (circle_kind, status, evidence_quality, team iff, mentorship iff), RLS enabled with no session policy (server-only)
--
-- m973 — CIRCLE TACTIC SHARES: the producer's opt-in to share ONE generalized method with ONE existing circle.
--
-- Directive G9: "If no existing structure can carry an opt-in, say exactly what is missing and write the smallest migration."
-- WHAT IS MISSING: a record of "this producer opted in to share THIS generalized method with THIS circle, until THIS date,
-- revocably". learning_modules has no consent / expiry / evidence column and its picker ignores team_id; marketing_assets is an
-- asset store; strategy_library is insert-only for StrategyDefinitions; content_topic_bank is tenant-wide.
--
-- WHAT THIS IS NOT: a membership class. A circle resolves ONLY through teams + team_members, agent_mentor_relationships, or
-- the tenant itself (lib/marketing/circle-tactics.ts circleMemberUserIds) — read live on every access. Not a billing
-- entitlement and not a cross-tenant channel: brokerage_id is NOT NULL and every reader / writer pins it.
--
-- RLS: enabled with NO policy — only the service role reaches it, and only through the session-gated doors in
-- app/actions/events-and-circles.ts (tenant from the session, CLAUDE.md §4).
--
-- After applying: regenerate scripts/live-tables.ts, scripts/schema-snapshot.ts, scripts/schema-fk-map.ts and
-- scripts/check-vocabularies.ts (npm run schema:regen) so the three CHECKs below are held by check-vocabulary-guard.

create table if not exists public.circle_tactic_shares (
  id               uuid primary key default gen_random_uuid(),
  brokerage_id     uuid not null references public.brokerages(id) on delete cascade,
  producer_user_id uuid not null references public.users(id) on delete cascade,
  circle_kind      text not null check (circle_kind in ('team', 'mentorship', 'brokerage')),
  team_id          uuid references public.teams(id) on delete cascade,
  mentorship_id    uuid references public.agent_mentor_relationships(id) on delete cascade,
  status           text not null default 'shared' check (status in ('shared', 'revoked')),
  evidence_quality text not null check (evidence_quality in ('attributable_comparable', 'insufficient_sample', 'no_comparable_cohort', 'no_measured_lift', 'outdated', 'idea_unknown_conversions')),
  source_label     text not null,
  brief            jsonb not null,
  evidence         jsonb not null default '{}'::jsonb,
  offers           jsonb not null default '{}'::jsonb,
  opted_in_at      timestamptz not null default now(),
  revoked_at       timestamptz,
  expires_at       timestamptz not null,
  created_at       timestamptz not null default now(),
  constraint circle_tactic_shares_team_iff check ((circle_kind = 'team') = (team_id is not null)),
  constraint circle_tactic_shares_mentorship_iff check ((circle_kind = 'mentorship') = (mentorship_id is not null))
);

create index if not exists circle_tactic_shares_brokerage_status_idx on public.circle_tactic_shares (brokerage_id, status, expires_at);
create index if not exists circle_tactic_shares_producer_idx on public.circle_tactic_shares (producer_user_id);

alter table public.circle_tactic_shares enable row level security;

comment on table public.circle_tactic_shares is 'Wave 154 (154G3, directive G9): a producer''s revocable opt-in to share one generalized method (never a caption, contact, figure or revenue) with one existing circle (team / mentorship / tenant). Membership is read live from teams, team_members and agent_mentor_relationships.';
