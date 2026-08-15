-- ============================================================================
-- Migration 1055 — Superadmin platform-margin view
-- ============================================================================
--
-- WHY:
--   AI is bundled in the subscription via Vercel AI Gateway. Brokerages pay a
--   flat monthly fee (subscription_tiers.monthly_price_cents); the platform
--   absorbs the per-token gateway cost. Margin = MRR − AI cost per tenant.
--
--   Without a per-tenant margin rollup the superadmin can't tell which
--   brokerages are profitable, which are eating margin, and which need a
--   plan-tier upgrade.
--
-- WHAT:
--   v_platform_margin — one row per brokerage with this month's economics.
--   Reads from brokerages + subscription_tiers + ai_usage_monthly.
--   Joins to v_brokerage_ai_quota so the superadmin sees the fair-use state
--   alongside the dollar number.
--
-- Composes cleanly with everything we've already built:
--   - subscription_tiers seeded by 1023 (tier→price mapping)
--   - ai_usage_monthly populated by lib/ai/cost-tracking.ts
--   - v_brokerage_ai_quota from 1054 (fair-use state)
-- ============================================================================

BEGIN;

CREATE OR REPLACE VIEW public.v_platform_margin AS
WITH period AS (
  SELECT
    date_trunc('month', now() AT TIME ZONE 'UTC')::date AS month_start
),
ai_cost_mtd AS (
  SELECT
    aum.brokerage_id,
    SUM(aum.total_cost_cents)::bigint AS ai_cost_cents,
    SUM(aum.total_tokens)::bigint     AS ai_tokens
  FROM public.ai_usage_monthly aum
  WHERE aum.month = (SELECT month_start FROM period)
  GROUP BY aum.brokerage_id
)
SELECT
  b.id                                                AS brokerage_id,
  b.name                                              AS brokerage_name,
  COALESCE(b.plan_tier, 'solo_agent')                 AS plan_tier,
  st.display_name                                     AS tier_display_name,
  COALESCE(st.monthly_price_cents, 0)                 AS mrr_cents,
  COALESCE(ac.ai_cost_cents, 0)                       AS ai_cost_cents,
  COALESCE(ac.ai_tokens, 0)                           AS ai_tokens,
  -- Margin (cents) = MRR − AI cost. Negative = losing money on this tenant.
  COALESCE(st.monthly_price_cents, 0) - COALESCE(ac.ai_cost_cents, 0) AS margin_cents,
  -- Margin %: protect against /0 when tier price is missing.
  CASE
    WHEN COALESCE(st.monthly_price_cents, 0) <= 0 THEN NULL
    ELSE ROUND(
      ((COALESCE(st.monthly_price_cents,0) - COALESCE(ac.ai_cost_cents,0))::numeric
        / st.monthly_price_cents) * 100, 1
    )
  END                                                 AS margin_percent,
  vq.quota_status                                     AS quota_status,
  vq.percent_used                                     AS quota_percent_used,
  b.created_at                                        AS brokerage_created_at
FROM public.brokerages b
LEFT JOIN public.subscription_tiers st
  ON st.tier_name = COALESCE(b.plan_tier, 'solo_agent') AND st.is_active = true
LEFT JOIN ai_cost_mtd ac
  ON ac.brokerage_id = b.id
LEFT JOIN public.v_brokerage_ai_quota vq
  ON vq.brokerage_id = b.id;

COMMENT ON VIEW public.v_platform_margin IS
  'Per-brokerage platform margin (MRR − AI cost) for the current UTC month. Source for the superadmin platform CFO dashboard. Negative margin_cents = the tenant is consuming more in AI than they pay in subscription.';

COMMIT;
