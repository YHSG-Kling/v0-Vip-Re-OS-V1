-- ── APPLIED LIVE 2026-09-27 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
--
-- m666 — VIDEO IS TIER-METERED; ITS OVERAGE IS BILLED, NOT REFUSED (wave 86, lane 86B).
--
-- Owner answer 4 (2026-09-27), the integrator's recommendation adopted: the video
-- feature gate is tier-METERED — count video creations per tier on the existing
-- meter, let overage flow to billing, refuse ONLY when a tier explicitly excludes
-- video, and never block an autonomous video of a paying tier.
--
-- The meter already exists and had NO WRITER: plan_limits carries video_minutes
-- per tier, usage_counters / usage_events / billing_usage take the metric
-- (lib/usage/log-media-usage.ts), the tenant usage bars and the overage
-- projection read it — every one showed zero because nothing recorded a video.
-- lib/video/video-metering.ts is now the writer (every creator + autonomous path).
--
-- Live state read 2026-09-27 (project hrvaqgvukzxfskkcrwbt, execute_sql):
--   plan_limits (plan_tier, metric='video_minutes'):
--     solo_agent 30 / team 150 / brokerage 300 / multi_location -1 (unlimited),
--     overage_allowed = false and overage_rate_cents_per_1k = 0 on all four.
--   ai_overage_invoices_metric_check  CHECK ((metric = 'ai_tokens_monthly'::text))
--   No tier has limit_value = 0 for video_minutes, so NO tier excludes video today.
--
-- This migration:
--   1. widens ai_overage_invoices.metric to admit 'video_minutes', so the ONE
--      period-close writethrough (lib/billing/ai-overage.ts runAIOverageBilling,
--      metric = VIDEO_OVERAGE_METRIC) can claim and bill video overage with the
--      same claim-before-Stripe idempotency — never a second biller;
--   2. turns video overage ON for the three capped tiers at 50000 cents per 1K
--      minutes = $0.50 per video minute — the rate the tenant-facing overage
--      projection already shows (lib/kernel/billing.ts calculateOverageExposure,
--      video_minutes costPerUnit 0.5), so the projection and the invoice agree.
--      OWNER-ADJUSTABLE: it is a price; re-set it before production rollout.
--      multi_location stays unlimited (-1): no overage is possible there.
--
-- The m479 superadmin terms editor stays AI-only by construction
-- (validateAIOverageTermsInput); video terms are set here.

begin;

alter table public.ai_overage_invoices
  drop constraint if exists ai_overage_invoices_metric_check;

alter table public.ai_overage_invoices
  add constraint ai_overage_invoices_metric_check
  check (metric in ('ai_tokens_monthly', 'video_minutes'));

update public.plan_limits
   set overage_allowed = true,
       overage_rate_cents_per_1k = 50000
 where metric = 'video_minutes'
   and plan_tier in ('solo_agent', 'team', 'brokerage')
   and limit_value > 0;

-- Postconditions (measured, m479 style).
do $$
declare
  def text;
  n int;
begin
  select pg_get_constraintdef(c.oid) into def
    from pg_constraint c
   where c.conrelid = 'public.ai_overage_invoices'::regclass
     and c.conname = 'ai_overage_invoices_metric_check';
  if def is null then
    raise exception 'm666 postcondition: ai_overage_invoices_metric_check missing after re-add';
  end if;
  if position(quote_literal('ai_tokens_monthly') in def) = 0 then
    raise exception 'm666 postcondition: the metric CHECK no longer admits ai_tokens_monthly (%)', def;
  end if;
  if position(quote_literal('video_minutes') in def) = 0 then
    raise exception 'm666 postcondition: the metric CHECK does not admit video_minutes (%)', def;
  end if;

  select count(*) into n from public.plan_limits
   where metric = 'video_minutes' and limit_value > 0
     and (overage_allowed is not true or overage_rate_cents_per_1k <= 0);
  if n <> 0 then
    raise exception 'm666 postcondition: % capped video tier(s) still refuse or zero-price overage', n;
  end if;

  select count(*) into n from public.plan_limits
   where metric = 'video_minutes' and limit_value = 0;
  if n <> 0 then
    raise notice 'm666: % tier(s) EXPLICITLY exclude video (limit_value = 0) — the gate refuses them', n;
  end if;
end $$;

commit;
