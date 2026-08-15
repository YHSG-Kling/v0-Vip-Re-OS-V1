-- ============================================================================
-- Listing Health Radar — per-active-listing health scoring
-- ============================================================================
--
-- Mirrors the deal_health_scores pattern for under-contract transactions:
--   - listing_health_scores         : one row per scan per listing
--   - listing_health_interventions  : actionable AI-suggested interventions
--
-- A cron job (/api/cron/listing-health-scan) scores every active listing
-- every 12 hours. The radar feeds the listing detail page and a portfolio
-- widget so agents catch a stale listing before it sits past comp-equivalent
-- DOM.
--
-- All identifiers are nullable except listing_id (FK to listings) so partial
-- score snapshots persist even if a listing's brokerage_id is briefly null
-- during a migration. RLS gates by brokerage_id (matches deal_health pattern).
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS listing_health_scores (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id          uuid        NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  brokerage_id        uuid        REFERENCES brokerages(id) ON DELETE SET NULL,
  agent_id            uuid        REFERENCES users(id)      ON DELETE SET NULL,

  -- Top-line numbers
  overall_score       numeric     NOT NULL CHECK (overall_score >= 0 AND overall_score <= 100),
  risk_level          text        NOT NULL CHECK (risk_level IN ('healthy', 'watch', 'at_risk', 'critical')),

  -- Per-component breakdown (shape: { category, weight, score, severity, message, points_possible, points_earned }[])
  score_components    jsonb       NOT NULL DEFAULT '[]',

  -- Quick-scan flags surfaced by the scorer (e.g. "DOM > 60 days", "0 showings last 14 days")
  flags               text[]      DEFAULT '{}',

  -- AI summary in plain English ("This listing is at risk because...")
  ai_narrative        text,

  -- Recommended next actions (shape: { action, reasoning, impact_estimate }[])
  recommended_actions jsonb       NOT NULL DEFAULT '[]',

  -- Trend
  previous_score      numeric,
  score_delta         numeric,

  -- Convenience: snapshot the DOM at scoring time so trend charts don't need
  -- to recompute from listing_date.
  days_on_market      int,

  scored_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listing_health_scores_listing
  ON listing_health_scores(listing_id, scored_at DESC);

CREATE INDEX IF NOT EXISTS idx_listing_health_scores_brokerage_risk
  ON listing_health_scores(brokerage_id, risk_level, scored_at DESC)
  WHERE risk_level IN ('at_risk', 'critical');

CREATE INDEX IF NOT EXISTS idx_listing_health_scores_agent
  ON listing_health_scores(agent_id, scored_at DESC);

ALTER TABLE listing_health_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role manages listing_health_scores" ON listing_health_scores;
CREATE POLICY "service role manages listing_health_scores"
  ON listing_health_scores FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "users read listing_health_scores in their brokerage" ON listing_health_scores;
CREATE POLICY "users read listing_health_scores in their brokerage"
  ON listing_health_scores
  FOR SELECT
  USING (
    brokerage_id IN (
      SELECT brokerage_id FROM users WHERE id = auth.uid()
    )
  );

-- ============================================================================
-- Interventions — what the agent should DO when a listing goes at-risk
-- ============================================================================

CREATE TABLE IF NOT EXISTS listing_health_interventions (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id          uuid        NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  brokerage_id        uuid        REFERENCES brokerages(id) ON DELETE SET NULL,
  agent_id            uuid        REFERENCES users(id)      ON DELETE SET NULL,

  -- What the radar caught
  issue_detected      text        NOT NULL,
  severity            text        NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),

  -- Recommended action
  ai_recommendation   text,

  -- Suggested category to drive UI grouping ('price', 'showings', 'marketing',
  -- 'condition', 'communication', 'feedback', 'other')
  category            text,

  -- Lifecycle
  resolved            boolean     NOT NULL DEFAULT false,
  resolved_at         timestamptz,
  resolved_by         uuid        REFERENCES users(id) ON DELETE SET NULL,
  resolution_note     text,

  -- Did this issue impact the seller (used to gate auto-notification)
  seller_impacted     boolean     NOT NULL DEFAULT false,

  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_listing_health_interventions_listing
  ON listing_health_interventions(listing_id, resolved, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_listing_health_interventions_brokerage_unresolved
  ON listing_health_interventions(brokerage_id, severity, created_at DESC)
  WHERE resolved = false;

ALTER TABLE listing_health_interventions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service role manages listing_health_interventions" ON listing_health_interventions;
CREATE POLICY "service role manages listing_health_interventions"
  ON listing_health_interventions FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "users read listing_health_interventions in their brokerage" ON listing_health_interventions;
CREATE POLICY "users read listing_health_interventions in their brokerage"
  ON listing_health_interventions
  FOR SELECT
  USING (
    brokerage_id IN (
      SELECT brokerage_id FROM users WHERE id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "users resolve listing_health_interventions in their brokerage" ON listing_health_interventions;
CREATE POLICY "users resolve listing_health_interventions in their brokerage"
  ON listing_health_interventions
  FOR UPDATE
  USING (
    brokerage_id IN (
      SELECT brokerage_id FROM users WHERE id = auth.uid()
    )
  );

COMMIT;
