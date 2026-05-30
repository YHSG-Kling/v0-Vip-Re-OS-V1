-- ============================================================================
-- Sprint 4 — Brokerage Intelligence Mesh
-- ============================================================================
--
-- Anonymized cross-agent pattern learning across each brokerage's data.
-- Weekly mining job runs per-pattern miners and writes findings here.
-- Brokers see a curated "this week's insights" list with one-click adopt.
--
-- Two tables:
--   1. brokerage_intelligence_insights — one row per mined pattern per
--      mining run. Carries: metric, top-quartile vs median outcome,
--      statistical lift, the playbook text, the supporting agent count
--      (anonymized — we record COUNT only, not identities, in the public
--      column; the originator IDs live in supporting_agents jsonb for
--      adoption routing).
--   2. pattern_adoptions — every time a broker pushes a pattern to an
--      agent we log it. Lets the system surface "you adopted this 3 weeks
--      ago — here's the lift since" later.
--
-- RLS: tenant-scoped via current_user_brokerage_id() (Sprint 1).
-- ============================================================================

CREATE TABLE IF NOT EXISTS brokerage_intelligence_insights (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id         uuid        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,

  mining_run_id        uuid        NOT NULL,    -- groups insights from one cron tick
  pattern_key          text        NOT NULL,    -- 'response_time' | 'touchpoint_cadence' | 'ai_isa_lift' | 'drip_engagement'

  headline             text        NOT NULL,    -- "Agents who text within 5 min of capture convert 3.1× more"
  metric_label         text        NOT NULL,    -- e.g. "Median minutes-to-first-touch"
  top_quartile_value   numeric,                 -- the winning behavior's metric
  median_value         numeric,                 -- the brokerage median
  bottom_quartile_value numeric,                -- worst-quartile median for contrast

  outcome_label        text,                    -- "Lead → contact conversion %"
  top_quartile_outcome numeric,                 -- top quartile's outcome rate / value
  median_outcome       numeric,
  bottom_quartile_outcome numeric,

  lift_pct             numeric     NOT NULL,    -- (top - bottom) / max(bottom, 1) × 100

  sample_size          int         NOT NULL,    -- # of (agent, contact/deal) observations
  supporting_agent_count int       NOT NULL,    -- # of agents in top quartile

  playbook             text,                    -- the actionable copy the agent receives
  playbook_actions     jsonb       NOT NULL DEFAULT '[]'::jsonb,  -- [{type, payload}]
  /* playbook_actions examples:
       {"type":"enable_ai_isa_on_new_leads"}
       {"type":"enroll_in_drip_within_24h", "sequence_key":"new-lead-nurture"}
       {"type":"first_touch_target_minutes", "minutes":15}
     The adopt action interprets these into concrete writes. */

  /* Originator agent IDs (top-quartile members). Stored only on the row
     for broker routing; never exposed to non-broker UIs. */
  supporting_agents    jsonb       NOT NULL DEFAULT '[]'::jsonb,

  severity             text        NOT NULL DEFAULT 'high'
                       CHECK (severity IN ('low','medium','high','critical')),
  status               text        NOT NULL DEFAULT 'open'
                       CHECK (status IN ('open','dismissed','superseded','expired')),

  dismissed_at         timestamptz,
  dismissed_by         uuid        REFERENCES users(id) ON DELETE SET NULL,
  dismissal_reason     text,

  computed_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_bii_brokerage_status_lift
  ON brokerage_intelligence_insights(brokerage_id, status, lift_pct DESC);

CREATE INDEX IF NOT EXISTS idx_bii_run
  ON brokerage_intelligence_insights(mining_run_id);

CREATE INDEX IF NOT EXISTS idx_bii_pattern_latest
  ON brokerage_intelligence_insights(brokerage_id, pattern_key, computed_at DESC);

ALTER TABLE brokerage_intelligence_insights ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bii_service_all ON brokerage_intelligence_insights;
CREATE POLICY bii_service_all
  ON brokerage_intelligence_insights FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS bii_admin_select ON brokerage_intelligence_insights;
CREATE POLICY bii_admin_select
  ON brokerage_intelligence_insights FOR SELECT
  USING (
    brokerage_id = current_user_brokerage_id()
    AND current_user_type() IN ('superadmin','broker','broker_admin','admin','team_lead')
  );

DROP POLICY IF EXISTS bii_admin_update ON brokerage_intelligence_insights;
CREATE POLICY bii_admin_update
  ON brokerage_intelligence_insights FOR UPDATE
  USING (
    brokerage_id = current_user_brokerage_id()
    AND current_user_type() IN ('superadmin','broker','broker_admin','admin')
  )
  WITH CHECK (
    brokerage_id = current_user_brokerage_id()
  );

-- ─── Pattern Adoptions ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS pattern_adoptions (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  insight_id           uuid        NOT NULL REFERENCES brokerage_intelligence_insights(id) ON DELETE CASCADE,
  brokerage_id         uuid        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  agent_id             uuid        REFERENCES users(id) ON DELETE SET NULL,
  adopted_by           uuid        REFERENCES users(id) ON DELETE SET NULL,

  /* What we actually pushed to the agent — the playbook_actions array
     resolved against the target agent. Stored for audit + uninstall. */
  applied_actions      jsonb       NOT NULL DEFAULT '[]'::jsonb,

  status               text        NOT NULL DEFAULT 'applied'
                       CHECK (status IN ('applied','reverted','failed')),
  notes                text,

  /* Outcome-tracking columns — populated by a follow-up cron at +30d
     to show the broker the actual lift from each adoption. */
  baseline_metric      numeric,
  followup_metric      numeric,
  observed_lift_pct    numeric,
  followup_at          timestamptz,

  created_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pa_insight
  ON pattern_adoptions(insight_id, status);

CREATE INDEX IF NOT EXISTS idx_pa_agent
  ON pattern_adoptions(agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_pa_brokerage_followup_due
  ON pattern_adoptions(brokerage_id, created_at)
  WHERE followup_at IS NULL;

ALTER TABLE pattern_adoptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pa_service_all ON pattern_adoptions;
CREATE POLICY pa_service_all
  ON pattern_adoptions FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS pa_admin_select ON pattern_adoptions;
CREATE POLICY pa_admin_select
  ON pattern_adoptions FOR SELECT
  USING (
    brokerage_id = current_user_brokerage_id()
    AND current_user_type() IN ('superadmin','broker','broker_admin','admin','team_lead')
  );
