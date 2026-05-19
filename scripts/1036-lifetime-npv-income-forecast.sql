-- ============================================================================
-- Sprint 3 — Lifetime Customer NPV + Income Forecast
-- ============================================================================
--
-- Two complementary surfaces:
--
-- 1. lifetime_customer_npv_scores — every closed contact ranked by the
--    expected 5-year referral GCI value. Replaces the agent's intuition
--    about who to call this month with a calibrated number: this contact
--    is worth $X over the next 5 years, here are the signals, here's the
--    cadence to maintain.
--
-- 2. income_forecast_snapshots — daily snapshot of the agent's projected
--    GCI in 30/60/90-day windows, including sphere-referral expected
--    value. Combined with the Revenue Protection Score (Sprint 2), the
--    agent has a complete financial picture: forecasted, protected, saved.
--
-- Tenant safety: every row has brokerage_id + RLS filter via
-- current_user_brokerage_id() (Sprint 1 pattern). Service role bypasses
-- for cron writes.
-- ============================================================================

-- ─── Lifetime Customer NPV Scores ─────────────────────────────────────────

CREATE TABLE IF NOT EXISTS lifetime_customer_npv_scores (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id               uuid        NOT NULL REFERENCES contacts(id)   ON DELETE CASCADE,
  brokerage_id             uuid        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  agent_id                 uuid        REFERENCES users(id)               ON DELETE SET NULL,

  -- Top-line numbers
  npv_score                numeric     NOT NULL CHECK (npv_score >= 0 AND npv_score <= 100),
  npv_dollars              numeric     NOT NULL DEFAULT 0,  -- projected 5-year referral GCI

  tier                     text        NOT NULL CHECK (tier IN
                                       ('platinum','gold','silver','bronze','dormant')),

  -- Component sub-scores (0-100 each, transparency for the agent)
  transaction_history_score int        NOT NULL DEFAULT 0,
  referral_history_score    int        NOT NULL DEFAULT 0,
  engagement_score          int        NOT NULL DEFAULT 0,
  wealth_score              int        NOT NULL DEFAULT 0,
  recency_score             int        NOT NULL DEFAULT 0,

  -- Why this score? (rendered as the signal chips in the panel)
  signals                  jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- What to do next?
  recommended_action       text,
  recommended_cadence      text,        -- 'weekly' | 'monthly' | 'quarterly' | 'bi-annual' | 'annual'
  next_touchpoint_due      date,

  -- Trend
  previous_score           numeric,
  score_delta              numeric,

  computed_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_npv_agent_score
  ON lifetime_customer_npv_scores(agent_id, npv_score DESC);

CREATE INDEX IF NOT EXISTS idx_npv_brokerage_tier
  ON lifetime_customer_npv_scores(brokerage_id, tier, npv_score DESC);

CREATE INDEX IF NOT EXISTS idx_npv_contact_latest
  ON lifetime_customer_npv_scores(contact_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_npv_next_touchpoint
  ON lifetime_customer_npv_scores(agent_id, next_touchpoint_due)
  WHERE next_touchpoint_due IS NOT NULL;

ALTER TABLE lifetime_customer_npv_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS npv_service_all ON lifetime_customer_npv_scores;
CREATE POLICY npv_service_all
  ON lifetime_customer_npv_scores FOR ALL
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS npv_tenant_select ON lifetime_customer_npv_scores;
CREATE POLICY npv_tenant_select
  ON lifetime_customer_npv_scores FOR SELECT
  USING (brokerage_id = current_user_brokerage_id());

-- ─── Income Forecast Snapshots ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS income_forecast_snapshots (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id                 uuid        REFERENCES users(id) ON DELETE CASCADE,
  brokerage_id             uuid        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,

  -- 30/60/90-day windows from revenue-pipeline projection
  weighted_30              numeric     NOT NULL DEFAULT 0,
  weighted_60              numeric     NOT NULL DEFAULT 0,
  weighted_90              numeric     NOT NULL DEFAULT 0,
  raw_30                   numeric     NOT NULL DEFAULT 0,
  raw_60                   numeric     NOT NULL DEFAULT 0,
  raw_90                   numeric     NOT NULL DEFAULT 0,

  -- Sphere NPV contribution (expected referral $ over horizon)
  sphere_referral_expected numeric     NOT NULL DEFAULT 0,

  -- Confidence bands (low / high p-values as percentage adjustments)
  low_band_pct             numeric     NOT NULL DEFAULT 25,
  high_band_pct            numeric     NOT NULL DEFAULT 15,

  -- Counts
  deal_count               int         NOT NULL DEFAULT 0,
  active_listing_count     int         NOT NULL DEFAULT 0,

  -- Per-stage breakdown jsonb (mirror revenue-pipeline.byStage)
  by_stage                 jsonb       NOT NULL DEFAULT '[]'::jsonb,

  -- Trend
  previous_snapshot_id     uuid        REFERENCES income_forecast_snapshots(id) ON DELETE SET NULL,
  weighted_90_delta        numeric,

  computed_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ifs_agent_computed
  ON income_forecast_snapshots(agent_id, computed_at DESC);

CREATE INDEX IF NOT EXISTS idx_ifs_brokerage_computed
  ON income_forecast_snapshots(brokerage_id, computed_at DESC);

ALTER TABLE income_forecast_snapshots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ifs_service_all ON income_forecast_snapshots;
CREATE POLICY ifs_service_all
  ON income_forecast_snapshots FOR ALL
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS ifs_tenant_select ON income_forecast_snapshots;
CREATE POLICY ifs_tenant_select
  ON income_forecast_snapshots FOR SELECT
  USING (brokerage_id = current_user_brokerage_id());
