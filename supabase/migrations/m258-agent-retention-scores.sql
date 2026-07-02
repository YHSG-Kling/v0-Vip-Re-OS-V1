-- m258-agent-retention-scores.sql
--
-- AGENT RETENTION RADAR (recruiting_manager) — the defensive mirror of the switch-propensity scout:
-- score YOUR OWN agents' flight risk daily from REAL engagement signals (assistant-session/activity
-- recency, production drought = days since last closing, active pipeline, onboarding ramp), so a slipping
-- agent gets a gated broker "save play" BEFORE they leave. Retention is cheaper than recruiting and no
-- competitor automates the early warning.
--
-- NOTE ON THE UPLOADED SPEC: the recruiting/retention spec proposes a large parallel table set
-- (agent_prospects, recruiting_pipeline, mentor_relationships, agent_onboarding_progress, …) that
-- DUPLICATES live tables (recruits, agent_mentor_relationships, agent_onboarding + steps) — building it
-- verbatim would be drift. The ONE genuinely-new concept is the retention score, so ONLY this table is
-- added; everything else reuses the existing schema.

create table if not exists agent_retention_scores (
  id                uuid primary key default gen_random_uuid(),
  brokerage_id      uuid not null,
  agent_id          uuid not null,
  score_date        date not null default current_date,
  composite_score   integer not null check (composite_score between 0 and 100),
  previous_score    integer,
  tier              text not null check (tier in ('engaged','healthy','watch','at_risk','critical')),
  score_trend       text check (score_trend in ('improving','stable','declining')),
  driving_signals   text[] not null default '{}',
  signal_breakdown  jsonb not null default '{}',
  created_at        timestamptz not null default now(),
  unique (agent_id, score_date)
);

create index if not exists idx_agent_retention_scores_broker_date on agent_retention_scores (brokerage_id, score_date desc);
create index if not exists idx_agent_retention_scores_low on agent_retention_scores (composite_score) where composite_score < 40;

comment on table agent_retention_scores is
  'Daily agent retention/flight-risk score (recruiting_manager) from real engagement signals. A newly-at-risk agent triggers a gated broker save-play. Defensive mirror of the switch-propensity scout.';
