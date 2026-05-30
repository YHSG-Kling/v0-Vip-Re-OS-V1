-- ============================================================================
-- Migration 1068 — Income Truth + Action Engine (gap analysis + recommendations)
-- ============================================================================
--
-- WHY:
--   Agents have no honest answer to "will I hit my income goal?" Every CRM
--   promises this; none deliver because the data isn't unified. Ours is —
--   income_forecast_snapshots (1036) computes weighted 30/60/90 GCI from the
--   actual pipeline; agent_goals (335) holds the target. The gap between them,
--   combined with a ranked weekly action queue, is the answer.
--
-- WHAT (composes existing tables, does NOT duplicate):
--   REUSES:
--     - income_forecast_snapshots (weighted 30/60/90 + sphere referral)
--     - agent_goals (target_value per goal_type per year)
--     - agent_pl_snapshot (gci_gross, ai_cost_cents, roi_multiple for ROI math)
--     - lifetime_customer_npv_scores (sphere contact priority)
--     - transactions + offers + contacts (live pipeline)
--
--   ADDS:
--     - income_forecast_gap_analysis: per-agent gap snapshots (forecast vs goal
--       across 30/90/180 windows + projected gap %) — daily snapshots so we can
--       chart the trend and detect divergence.
--     - income_gap_recommended_actions: ranked weekly actions tied to a gap
--       snapshot. Each action has estimated_gci_impact + effort + category so
--       we can surface "do these 5 things this week to close $X of the gap."
--
--   INTEGRATES into lib/agent-action-queue/composer.ts as a 5th source (do NOT
--   create a competing agent_actions table — composer is the canonical surface).
-- ============================================================================

BEGIN;

-- ── Gap analysis snapshot (daily, per agent) ────────────────────────────────
CREATE TABLE IF NOT EXISTS public.income_forecast_gap_analysis (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id             uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  agent_id                 uuid NOT NULL REFERENCES public.agents(id)     ON DELETE CASCADE,
  -- Snapshot source pointers (loose links — snapshots may be expired)
  forecast_snapshot_id     uuid REFERENCES public.income_forecast_snapshots(id) ON DELETE SET NULL,
  -- The numbers
  weighted_30_cents        bigint NOT NULL DEFAULT 0,
  weighted_90_cents        bigint NOT NULL DEFAULT 0,
  /** Forecast 180 = weighted_90 + (sphere_referral_expected pro-rated) */
  weighted_180_cents       bigint NOT NULL DEFAULT 0,
  ytd_gci_cents            bigint NOT NULL DEFAULT 0,
  annual_goal_cents        bigint,                      -- null when no goal set
  remaining_year_cents     bigint,                      -- max(0, annual_goal - ytd)
  projected_year_end_cents bigint,                      -- ytd + weighted_180_pro_rated_to_eoy
  /** Gap: positive = behind goal, negative = ahead */
  gap_to_goal_cents        bigint,
  gap_to_goal_pct          numeric(6,2),
  /** Confidence band from forecast snapshot */
  low_band_pct             numeric(6,2),
  high_band_pct            numeric(6,2),
  /** Diagnostic factors that drove the gap */
  diagnostics              jsonb NOT NULL DEFAULT '{}'::jsonb,
  analysis_date            date NOT NULL DEFAULT CURRENT_DATE,
  computed_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, analysis_date)
);

CREATE INDEX IF NOT EXISTS idx_ifga_agent      ON public.income_forecast_gap_analysis(agent_id, analysis_date DESC);
CREATE INDEX IF NOT EXISTS idx_ifga_brokerage  ON public.income_forecast_gap_analysis(brokerage_id, analysis_date DESC);
CREATE INDEX IF NOT EXISTS idx_ifga_gap_behind ON public.income_forecast_gap_analysis(brokerage_id, gap_to_goal_cents DESC)
  WHERE gap_to_goal_cents > 0;

ALTER TABLE public.income_forecast_gap_analysis ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ifga_svc_all ON public.income_forecast_gap_analysis;
CREATE POLICY ifga_svc_all ON public.income_forecast_gap_analysis
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS ifga_tenant_read ON public.income_forecast_gap_analysis;
CREATE POLICY ifga_tenant_read ON public.income_forecast_gap_analysis
  FOR SELECT
  USING (brokerage_id = current_user_brokerage_id() OR current_user_type() = 'superadmin');

DROP POLICY IF EXISTS ifga_agent_read_own ON public.income_forecast_gap_analysis;
CREATE POLICY ifga_agent_read_own ON public.income_forecast_gap_analysis
  FOR SELECT
  USING (
    agent_id IN (SELECT id FROM public.agents WHERE user_id = auth.uid())
  );

-- ── Recommended weekly actions (ranked, tied to a gap snapshot) ─────────────
CREATE TABLE IF NOT EXISTS public.income_gap_recommended_actions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gap_analysis_id          uuid NOT NULL REFERENCES public.income_forecast_gap_analysis(id) ON DELETE CASCADE,
  agent_id                 uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  brokerage_id             uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  action_rank              int  NOT NULL,
  action_category          text NOT NULL
                           CHECK (action_category IN (
                             'prospecting','listing_acquisition','referral_ask',
                             'conversion_focus','reactivation','negotiation_close',
                             'pricing_correction','sphere_nurture','open_house','marketing_push'
                           )),
  action_title             text NOT NULL,
  action_description       text,
  -- Optional links — the action can point at a specific contact/transaction/listing
  contact_id               uuid REFERENCES public.contacts(id)     ON DELETE SET NULL,
  transaction_id           uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  listing_id               uuid REFERENCES public.listings(id)     ON DELETE SET NULL,
  -- Scoring (mirrors agent-action-queue composer scoring)
  estimated_gci_impact_cents bigint NOT NULL DEFAULT 0,
  estimated_effort_hours     numeric(4,1) NOT NULL DEFAULT 0.5,
  confidence_score           int CHECK (confidence_score BETWEEN 0 AND 100),
  impact_score               int CHECK (impact_score BETWEEN 0 AND 100),
  urgency_score              int CHECK (urgency_score BETWEEN 0 AND 100),
  /** priority = impact·0.4 + urgency·0.3 + confidence·0.2 + (100-effort_pct)·0.1 */
  priority_score             numeric(6,2),
  due_by                    timestamptz,
  status                    text NOT NULL DEFAULT 'open'
                            CHECK (status IN ('open','in_progress','completed','dismissed','expired')),
  completed_at              timestamptz,
  completed_outcome         text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_igra_agent_open    ON public.income_gap_recommended_actions(agent_id, status, priority_score DESC)
  WHERE status IN ('open','in_progress');
CREATE INDEX IF NOT EXISTS idx_igra_gap           ON public.income_gap_recommended_actions(gap_analysis_id, action_rank);
CREATE INDEX IF NOT EXISTS idx_igra_brokerage     ON public.income_gap_recommended_actions(brokerage_id, status, priority_score DESC);
CREATE INDEX IF NOT EXISTS idx_igra_contact       ON public.income_gap_recommended_actions(contact_id) WHERE contact_id IS NOT NULL;

ALTER TABLE public.income_gap_recommended_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS igra_svc_all ON public.income_gap_recommended_actions;
CREATE POLICY igra_svc_all ON public.income_gap_recommended_actions
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS igra_tenant_read ON public.income_gap_recommended_actions;
CREATE POLICY igra_tenant_read ON public.income_gap_recommended_actions
  FOR SELECT
  USING (brokerage_id = current_user_brokerage_id() OR current_user_type() = 'superadmin');

DROP POLICY IF EXISTS igra_agent_self ON public.income_gap_recommended_actions;
CREATE POLICY igra_agent_self ON public.income_gap_recommended_actions
  FOR ALL
  USING (agent_id IN (SELECT id FROM public.agents WHERE user_id = auth.uid()))
  WITH CHECK (agent_id IN (SELECT id FROM public.agents WHERE user_id = auth.uid()));

-- Touch trigger
CREATE OR REPLACE FUNCTION public.touch_igra_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END$$;

DROP TRIGGER IF EXISTS trg_touch_igra ON public.income_gap_recommended_actions;
CREATE TRIGGER trg_touch_igra
  BEFORE UPDATE ON public.income_gap_recommended_actions
  FOR EACH ROW EXECUTE FUNCTION public.touch_igra_updated_at();

COMMIT;
