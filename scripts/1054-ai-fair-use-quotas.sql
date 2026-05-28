-- ============================================================================
-- Migration 1054 — AI fair-use quotas (subscription-included AI)
-- ============================================================================
--
-- WHY:
--   AI is bundled in the subscription via Vercel AI Gateway — the brokerage
--   does NOT pay per-token. That means the platform absorbs the unit cost,
--   and a single runaway tenant can blow through margin if there is no
--   per-tenant ceiling.
--
-- WHAT THIS DOES:
--   1. Extends plan_limits.metric CHECK to include 'ai_tokens_monthly'.
--   2. Seeds ai_tokens_monthly limits for all four canonical tiers
--      (solo_agent, team, brokerage, multi_location).
--   3. Adds soft_limit_threshold so we warn at 80% in-app.
--   4. Creates a v_brokerage_ai_quota view so the admin + superadmin
--      dashboards both render from a single source of truth.
--
-- HOW THE CAP IS ENFORCED:
--   lib/ai/cost-tracking.ts:logAIUsage() bumps usage_counters('ai_tokens_monthly').
--   lib/ai/fair-use.ts wraps checkUsageCap('ai_tokens_monthly') and is called
--   from lib/ai/models.ts:generateAIResponse PRIOR to the AI Gateway call.
--   At 100% the call is rejected with a friendly upgrade message.
--   Brokerage admins can request an override (compliance_flags + manual lift).
--
-- TIERS (canonical, set by 1023-align-plan-tier-vocabulary.sql):
--   solo_agent     — single agent, ~$99/mo
--   team           — agent + staff, ~$499/mo
--   brokerage      — full brokerage, ~$999/mo
--   multi_location — multi-office franchise, ~$2999/mo
-- ============================================================================

BEGIN;

-- 1a. usage_counters.metric CHECK ALSO blocks unknown metrics; extend to allow
--     'ai_tokens_monthly' so logAIUsage() can bump the counter.
ALTER TABLE public.usage_counters DROP CONSTRAINT IF EXISTS usage_counters_metric_check;
ALTER TABLE public.usage_counters ADD CONSTRAINT usage_counters_metric_check
  CHECK (metric = ANY (ARRAY[
    'llm_calls','video_minutes','active_users','contacts_count','active_transactions',
    'sms_sent','emails_sent','storage_gb',
    'ai_tokens_monthly',
    'live_avatar_minutes','live_avatar_sessions','tts_characters',
    'voice_clones_created','avatars_created','vapi_minutes',
    'live_assistant_minutes','live_assistant_sessions'
  ]));

-- 1b. Drop and recreate plan_limits.metric CHECK with ai_tokens_monthly added.
ALTER TABLE public.plan_limits DROP CONSTRAINT IF EXISTS plan_limits_metric_check;
ALTER TABLE public.plan_limits ADD CONSTRAINT plan_limits_metric_check
  CHECK (metric IN (
    'llm_calls',
    'video_minutes',
    'active_users',
    'contacts_count',
    'active_transactions',
    'sms_sent',
    'emails_sent',
    'storage_gb',
    'ai_tokens_monthly',
    'live_avatar_minutes',
    'live_avatar_sessions',
    'tts_characters',
    'voice_clones_created',
    'avatars_created',
    'vapi_minutes',
    'live_assistant_minutes',
    'live_assistant_sessions'
  ));

-- 2. Seed fair-use quotas. Each tier's ceiling is generous for normal use
--    and trips only on outlier consumption. Tune as real telemetry rolls in.
INSERT INTO public.plan_limits (plan_tier, metric, limit_value, soft_limit_threshold)
VALUES
  ('solo_agent',     'ai_tokens_monthly',   2000000, 0.80),
  ('team',           'ai_tokens_monthly',  10000000, 0.80),
  ('brokerage',      'ai_tokens_monthly',  30000000, 0.80),
  ('multi_location', 'ai_tokens_monthly', 100000000, 0.80)
ON CONFLICT (plan_tier, metric) DO UPDATE
  SET limit_value           = EXCLUDED.limit_value,
      soft_limit_threshold  = EXCLUDED.soft_limit_threshold,
      updated_at            = now();

-- 3. View: per-brokerage AI quota state. Reads usage_counters for the current
--    UTC month and joins to plan_limits to compute used/limit/percent.
--    Returns ONE row per brokerage. Superadmin reads across all rows; brokerage
--    admin filters to their own brokerage_id.
CREATE OR REPLACE VIEW public.v_brokerage_ai_quota AS
WITH period AS (
  SELECT
    date_trunc('month', now() AT TIME ZONE 'UTC')                          AS period_start,
    date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month'     AS period_end
)
SELECT
  b.id                                                AS brokerage_id,
  b.name                                              AS brokerage_name,
  COALESCE(b.plan_tier, 'solo_agent')                 AS plan_tier,
  COALESCE(pl.limit_value, -1)                        AS token_limit,
  COALESCE(pl.soft_limit_threshold, 0.80)             AS soft_threshold,
  COALESCE(uc.value, 0)                               AS tokens_used,
  CASE
    WHEN COALESCE(pl.limit_value, -1) <= 0 THEN 0
    ELSE LEAST(100, ROUND( (COALESCE(uc.value,0)::numeric / pl.limit_value) * 100 )::int)
  END                                                 AS percent_used,
  CASE
    WHEN COALESCE(pl.limit_value, -1) <= 0 THEN 'unlimited'
    WHEN COALESCE(uc.value,0) >= pl.limit_value THEN 'blocked'
    WHEN COALESCE(uc.value,0) >= FLOOR(pl.limit_value * COALESCE(pl.soft_limit_threshold, 0.80)) THEN 'warning'
    ELSE 'ok'
  END                                                 AS quota_status,
  (SELECT period_start FROM period)                   AS period_start,
  (SELECT period_end   FROM period)                   AS period_end
FROM public.brokerages b
LEFT JOIN public.plan_limits pl
  ON pl.plan_tier = COALESCE(b.plan_tier, 'solo_agent')
  AND pl.metric = 'ai_tokens_monthly'
LEFT JOIN public.usage_counters uc
  ON uc.brokerage_id = b.id
  AND uc.metric = 'ai_tokens_monthly'
  AND uc.period_start = (SELECT period_start FROM period)
  AND uc.period_end   = (SELECT period_end   FROM period);

COMMENT ON VIEW public.v_brokerage_ai_quota IS
  'Per-brokerage AI token quota status for the current UTC month. quota_status: ok | warning | blocked | unlimited. Source for both broker admin AI dashboard (token-facing) and superadmin platform margin view (dollar-facing).';

-- 4. Optional admin-override table — broker admin can request a quota lift
--    that a superadmin approves. Keeps an audit trail of who lifted what
--    and for how long.
CREATE TABLE IF NOT EXISTS public.ai_quota_overrides (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id      uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  requested_by      uuid NOT NULL REFERENCES public.users(id) ON DELETE SET NULL,
  approved_by       uuid REFERENCES public.users(id) ON DELETE SET NULL,
  extra_tokens      bigint NOT NULL CHECK (extra_tokens > 0),
  reason            text NOT NULL,
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired')),
  effective_until   timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  approved_at       timestamptz
);

CREATE INDEX IF NOT EXISTS idx_ai_quota_overrides_brokerage
  ON public.ai_quota_overrides(brokerage_id, status, effective_until DESC);

ALTER TABLE public.ai_quota_overrides ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ai_quota_overrides_svc_all ON public.ai_quota_overrides;
CREATE POLICY ai_quota_overrides_svc_all ON public.ai_quota_overrides
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS ai_quota_overrides_tenant_read ON public.ai_quota_overrides;
CREATE POLICY ai_quota_overrides_tenant_read ON public.ai_quota_overrides
  FOR SELECT
  USING (brokerage_id = current_user_brokerage_id()
         OR current_user_type() = 'superadmin');

DROP POLICY IF EXISTS ai_quota_overrides_admin_insert ON public.ai_quota_overrides;
CREATE POLICY ai_quota_overrides_admin_insert ON public.ai_quota_overrides
  FOR INSERT
  WITH CHECK (brokerage_id = current_user_brokerage_id()
              AND current_user_type() IN ('broker','broker_admin','admin','superadmin'));

DROP POLICY IF EXISTS ai_quota_overrides_superadmin_update ON public.ai_quota_overrides;
CREATE POLICY ai_quota_overrides_superadmin_update ON public.ai_quota_overrides
  FOR UPDATE
  USING (current_user_type() = 'superadmin')
  WITH CHECK (current_user_type() = 'superadmin');

COMMIT;
