-- ===========================================================================
-- 1007-wealth-advisor.sql
-- Generational Wealth Advisor schema. Stores wealth opportunities (refi /
-- cash-out / HELOC / 1031 / downsize) per lifetime customer, plus daily
-- market rate snapshots used as the comparison baseline.
--
-- APPLIED VIA: supabase apply_migration "wealth_advisor_recommendations"
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.wealth_advisor_recommendations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id               uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  agent_id                 uuid,
  brokerage_id             uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  opportunity_type         text NOT NULL CHECK (opportunity_type IN (
    'refinance_opportunity','cash_out_refi','heloc_for_investment',
    'sell_and_1031_exchange','downsize_and_bank_equity','equity_milestone'
  )),
  current_avm_value        numeric,
  estimated_equity         numeric,
  equity_pct               numeric,
  current_market_rate_bps  int,
  estimated_locked_rate_bps int,
  rate_gap_bps             int,
  monthly_savings_estimate numeric,
  one_time_proceeds_estimate numeric,
  ai_narrative             text,
  scenarios                jsonb,
  signals_supporting       jsonb,
  status                   text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','reviewed','presented','converted','dismissed','stale')),
  reviewed_by_user_id      uuid,
  reviewed_at              timestamptz,
  pushed_to_portal_at      timestamptz,
  client_acknowledged_at   timestamptz,
  dismissed_reason         text,
  scored_at                timestamptz DEFAULT now(),
  expires_at               timestamptz,
  created_at               timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wealth_reco_agent_status ON public.wealth_advisor_recommendations(agent_id, status, scored_at DESC);
CREATE INDEX IF NOT EXISTS idx_wealth_reco_contact ON public.wealth_advisor_recommendations(contact_id, scored_at DESC);
CREATE INDEX IF NOT EXISTS idx_wealth_reco_brokerage ON public.wealth_advisor_recommendations(brokerage_id, status, scored_at DESC);

ALTER TABLE public.wealth_advisor_recommendations ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS public.market_rate_snapshots (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rate_date                date NOT NULL UNIQUE,
  rate_30yr_fixed_bps      int,
  rate_15yr_fixed_bps      int,
  rate_5_1_arm_bps         int,
  rate_jumbo_30yr_bps      int,
  source                   text,
  fetched_at               timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_market_rates_date ON public.market_rate_snapshots(rate_date DESC);

ALTER TABLE public.market_rate_snapshots ENABLE ROW LEVEL SECURITY;
