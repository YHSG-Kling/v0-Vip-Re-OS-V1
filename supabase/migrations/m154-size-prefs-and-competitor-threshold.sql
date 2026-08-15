-- m154 — subscriber-controlled sizing prefs + competitor threshold.
--
-- Wave 36, items 5 + 6 of user-prioritized list.
--
-- ── Item 5: per-persona × per-event direct-mail size preference ──
--
-- lifecycle_promo_policy.mail_postcard_size already lets a subscriber
-- override the size per (scope, lifecycle_event). What was missing:
-- per-PERSONA size override for non-lifecycle uses (farm mail,
-- welcome kit). A team-tier brokerage that targets luxury sellers
-- might prefer 6x9 for ALL their luxury persona mail; a different
-- brokerage might prefer 4x6 to keep farm spend down.
--
-- We add a jsonb column on the THREE tier tables (agents, teams,
-- brokerages) so the resolver cascades agent → team → brokerage →
-- platform default. jsonb (not a normalized table) because:
--   - There are ~13 personas × 3 use_kinds = ~39 cells per row; even
--     a fully-configured subscriber stays small enough for jsonb
--   - The Settings UI mutates this in one PATCH, no migration on
--     row schema changes
--   - The resolver runs once per dispatch — a jsonb pluck is cheaper
--     than a join + filter
--
-- Shape:
--   { "<use_kind>:<persona>": "4x6" | "6x9", ... }
--   where use_kind ∈ {'farm_mail', 'welcome_kit', 'sphere_outreach'}
--   and persona ∈ the canonical Persona union from lib/kernel/types.ts
--
-- ── Item 6: per-watchlist competitor engagement threshold ──
--
-- promote-to-topic-bank.ts has a hard-coded MIN_ENGAGEMENT = 30.
-- That's a platform default; the subscriber should be able to raise
-- it ("only show me what's REALLY winning — top 10% only"). Per-
-- competitor (not per-brokerage) because some watched competitors
-- are weak signal worth ignoring while others are anchor competitors
-- the brokerage wants every entry from.

alter table public.agents
  add column if not exists direct_mail_size_prefs jsonb;
alter table public.teams
  add column if not exists direct_mail_size_prefs jsonb;
alter table public.brokerages
  add column if not exists direct_mail_size_prefs jsonb;

alter table public.competitor_brokerages
  add column if not exists min_engagement_score integer;

comment on column public.agents.direct_mail_size_prefs       is 'Wave 36: per-(use_kind:persona) override for postcard size. Resolver cascades agent → team → brokerage → platform default.';
comment on column public.teams.direct_mail_size_prefs        is 'Wave 36: team-level postcard size prefs for any farm/sphere mail by team members.';
comment on column public.brokerages.direct_mail_size_prefs   is 'Wave 36: brokerage-level postcard size prefs — the safety net.';
comment on column public.competitor_brokerages.min_engagement_score is 'Wave 36 item 6: per-watchlist threshold (0-100). Only ads scoring ≥ this land in competitor_ads → topic bank. Null = platform default (30).';
