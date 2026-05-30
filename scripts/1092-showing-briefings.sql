-- ===========================================================================
-- 1092-showing-briefings.sql
--
-- AI Showing Prep — generates a "1-pager" the agent reads in the car before
-- walking into a property. Pulls everything the platform already knows
-- about this buyer:
--   property_preferences        AI-inferred criteria (price, beds, must-haves)
--   buyer_financial_profiles    pre-approval amount, lender, cash buyer flag
--   buyer_behavior_predictions  predicted ready-to-offer, predicted next action
--   buyer_behavior_log          recent search / save / share signals
--   buyer_stage_coaching        per-stage talking points + risk signals
--   listings + recent comps     this listing vs market context
--
-- One row per showing. Re-generated on demand. The cron at
-- /api/cron/showing-prep runs hourly, finds showings starting in the next
-- 24h with no briefing yet, and produces one.
--
-- APPLIED VIA: supabase apply_migration "showing_briefings"
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.showing_briefings (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  showing_id        uuid NOT NULL UNIQUE REFERENCES public.showings(id) ON DELETE CASCADE,
  brokerage_id      uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id          uuid REFERENCES public.agents(id) ON DELETE SET NULL,

  buyer_snapshot    jsonb NOT NULL DEFAULT '{}'::jsonb,
  listing_snapshot  jsonb NOT NULL DEFAULT '{}'::jsonb,
  matchup           jsonb NOT NULL DEFAULT '{}'::jsonb,

  ai_summary        text,
  ai_talking_points jsonb DEFAULT '[]'::jsonb,
  ai_objections     jsonb DEFAULT '[]'::jsonb,
  ai_risk_flags     jsonb DEFAULT '[]'::jsonb,

  recent_comps      jsonb DEFAULT '[]'::jsonb,

  generated_at      timestamptz NOT NULL DEFAULT now(),
  ai_model_used     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_showing_briefings_agent
  ON public.showing_briefings(agent_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_showing_briefings_brokerage
  ON public.showing_briefings(brokerage_id, generated_at DESC);
