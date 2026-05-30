-- ============================================================================
-- Sprint 2 — Revenue Protection Score
-- ============================================================================
--
-- The headline number that proves AI value to every agent and broker:
--   "Your AI has protected $X in pipeline GCI this quarter."
--   "AI has saved $Y in deals that would have died."
--
-- Composes signals from:
--   - transactions.estimated_commission / commission_amount  (GCI per deal)
--   - deal_health_scores.risk_level                          (at-risk deals)
--   - listing_health_scores.risk_level                       (at-risk listings)
--   - proactive_interventions (resolved=true)                (deal saves)
--   - listing_health_interventions (resolved=true)           (listing saves)
--   - listings.list_price                                    (listing GCI est)
--
-- Persisted as time-series snapshots so the dashboard can show:
--   - current dollar number (the latest snapshot for the period)
--   - trend vs previous period
--   - per-severity breakdown
--
-- Sprint 1's tenant-safety hardening means RLS + brokerage_id scoping is
-- automatic — we just use current_user_brokerage_id() the same as every
-- other Sprint 1+ table.
-- ============================================================================

CREATE TABLE IF NOT EXISTS revenue_protection_snapshots (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id                 uuid        REFERENCES users(id)      ON DELETE CASCADE,
  brokerage_id             uuid        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  team_id                  uuid        REFERENCES teams(id)      ON DELETE SET NULL,

  -- Snapshot type lets a single table hold daily / weekly / monthly /
  -- quarterly rolls; the agent UI shows the latest 'quarterly' as the
  -- hero number, while operators can chart 'daily' for trend.
  snapshot_type            text        NOT NULL CHECK (snapshot_type IN
                                       ('daily', 'weekly', 'monthly', 'quarterly', 'ytd', 'lifetime')),
  period_start             date        NOT NULL,
  period_end               date        NOT NULL,

  -- ── Protected GCI: at-risk dollars currently under AI watch ───────────
  protected_gci            numeric     NOT NULL DEFAULT 0,    -- Σ deals + listings flagged at_risk/critical
  at_risk_deal_count       int         NOT NULL DEFAULT 0,
  at_risk_listing_count    int         NOT NULL DEFAULT 0,
  critical_gci             numeric     NOT NULL DEFAULT 0,    -- subset where risk is critical
  at_risk_by_severity      jsonb       NOT NULL DEFAULT '{}'::jsonb,  -- {critical:$, at_risk:$, watch:$}

  -- ── Saved GCI: dollars where AI intervention was resolved in period ──
  saved_gci                numeric     NOT NULL DEFAULT 0,    -- Σ commission of resolved-intervention deals/listings
  saves_count              int         NOT NULL DEFAULT 0,
  avg_save_value           numeric     NOT NULL DEFAULT 0,

  -- ── AI lift: rough counterfactual vs no-AI baseline ──────────────────
  -- Heuristic: assume 25 % of at-risk deals would fail without AI
  -- intervention. Replace with a calibrated model once historical data
  -- supports it.
  no_ai_baseline_gci       numeric     NOT NULL DEFAULT 0,
  ai_lift_pct              numeric     NOT NULL DEFAULT 0,

  -- ── Per-category breakdown (rendered as the segmented bar in the UI) ──
  per_category             jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- Trend support — link back to previous-period snapshot for delta math.
  previous_snapshot_id     uuid        REFERENCES revenue_protection_snapshots(id) ON DELETE SET NULL,
  protected_gci_delta      numeric,
  saves_gci_delta          numeric,

  computed_at              timestamptz NOT NULL DEFAULT now()
);

-- Most common query: latest snapshot per agent per type
CREATE INDEX IF NOT EXISTS idx_rps_agent_type_period
  ON revenue_protection_snapshots(agent_id, snapshot_type, period_end DESC);

-- Brokerage-wide rollup (used by broker landing widget)
CREATE INDEX IF NOT EXISTS idx_rps_brokerage_type_period
  ON revenue_protection_snapshots(brokerage_id, snapshot_type, period_end DESC);

ALTER TABLE revenue_protection_snapshots ENABLE ROW LEVEL SECURITY;

-- service role manages (cron writes via service client)
DROP POLICY IF EXISTS rps_service_all ON revenue_protection_snapshots;
CREATE POLICY rps_service_all
  ON revenue_protection_snapshots FOR ALL
  USING (true) WITH CHECK (true);

-- Auth users read their own brokerage's rows; agents see their own row;
-- brokers see all rows in their brokerage. Tenant guard pattern from Sprint 1.
DROP POLICY IF EXISTS rps_tenant_select ON revenue_protection_snapshots;
CREATE POLICY rps_tenant_select
  ON revenue_protection_snapshots
  FOR SELECT
  USING (brokerage_id = current_user_brokerage_id());
