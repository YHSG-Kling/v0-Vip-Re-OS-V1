-- m135 — marketing-agent weekly plan windows + realized outcomes.
--
-- Wave 25. Closes the AGENT-LAYER loop. Wave 19-24 closed the loop at
-- the picker (per-topic score), the producer (per-section persona),
-- the renderer (per-persona thumbnail), the scoring layer (per-(topic,
-- persona) score), and the snapshot (per-persona engagement). What was
-- still missing: the agent had no view of WHETHER ITS OWN PRIOR PLANS
-- HAD WORKED. Each Monday's spawn read fresh signals but never saw
-- "last week's plan produced 40% open, 12% click — beat that this week."
--
-- Wave 25 captures a row per (brokerage, week) at spawn time + fills the
-- realized columns at end-of-week via a measure cron. Next Monday's
-- snapshot pulls the trailing 4 weeks so the agent grades itself.
--
-- We do NOT store the agent's full plan JSON output here — that lives
-- in Anthropic's session transcript + agent_outcome_evaluations. What
-- we DO store is the SNAPSHOT SIGNALS we showed the agent (so we can
-- correlate "we showed FTB at 60% open → agent planned 3 FTB sections
-- → realized FTB open was 65%" later). Plan content extraction stays a
-- Wave 26+ extension when we wire Anthropic webhook → plan_content jsonb.

create table if not exists public.marketing_agent_weekly_outcomes (
  id                          uuid primary key default gen_random_uuid(),
  brokerage_id                uuid not null references public.brokerages(id) on delete cascade,
  week_start                  date not null,                  -- Monday (UTC) the plan covers
  spawned_session_id          uuid,                            -- managed_agent_sessions.id, nullable when skip_no_signal
  spawned_at                  timestamptz not null default now(),
  snapshot_signals_jsonb      jsonb not null,                  -- MarketingSnapshot at spawn time
  -- Filled by marketing-agent-weekly-measure cron at end-of-week:
  realized_at                 timestamptz,
  realized_campaigns_sent     integer,                         -- newsletter_campaigns sent in this week
  realized_recipient_sends    integer,                         -- total newsletter_sends rows
  realized_open_rate          numeric(5,2),                    -- weighted across all sends in the week, 0..100
  realized_click_rate         numeric(5,2),                    -- weighted, 0..100
  realized_persona_breakdown  jsonb,                           -- [{ persona, sends, open_rate, click_rate }, ...]
  plan_quality_score          integer check (plan_quality_score is null or (plan_quality_score >= 0 and plan_quality_score <= 100)),
  unique (brokerage_id, week_start)
);

create index if not exists idx_marketing_agent_weekly_outcomes_brokerage_week
  on public.marketing_agent_weekly_outcomes (brokerage_id, week_start desc);

create index if not exists idx_marketing_agent_weekly_outcomes_unrealized
  on public.marketing_agent_weekly_outcomes (week_start)
  where realized_at is null;

alter table public.marketing_agent_weekly_outcomes enable row level security;

create policy "service_role_full"
  on public.marketing_agent_weekly_outcomes
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
