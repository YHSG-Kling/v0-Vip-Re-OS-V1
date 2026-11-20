-- ============================================================================
-- Migration 1053 — P&L Truth Engine + Cron Health Infrastructure
-- ============================================================================
--
-- Three high-impact gaps:
--
-- 1. agent_pl_snapshot
--    Per-agent monthly net P&L: GCI – agent_payout – AI costs – fee charges
--    = true brokerage margin per agent + ROI multiple.
--    Written by /api/cron/brokerage-pl-rollup (nightly).
--    Surfaced on /dashboard/financials/brokerage (broker/admin only).
--
-- 2. cron_execution_logs additions
--    The table exists (used by 60+ crons) but context_id rows never had
--    cron_name set (kernel stored name only in-memory). Backfill index
--    so the health dashboard can group by cron_name efficiently.
--
-- 3. cron_health_snapshot (daily)
--    One row per (cron_name, snapshot_date). Tracks last_run_status,
--    last_run_at, expected_interval_hours, is_stale.
--    Populated by a scheduled function or by the dashboard query directly.
-- ============================================================================

BEGIN;

-- ─── 1. agent_pl_snapshot ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS agent_pl_snapshot (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id            uuid        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  agent_id                uuid        NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  month_year              text        NOT NULL,   -- 'YYYY-MM'
  gci_gross               numeric     NOT NULL DEFAULT 0,  -- total GCI agent produced
  agent_payout            numeric     NOT NULL DEFAULT 0,  -- $ paid to agent after split
  brokerage_gross         numeric     NOT NULL DEFAULT 0,  -- brokerage take before costs
  ai_cost_cents           bigint      NOT NULL DEFAULT 0,  -- AI token spend for this agent
  fee_income_cents        bigint      NOT NULL DEFAULT 0,  -- E&O/desk/transaction fees collected
  marketing_spend_cents   bigint      NOT NULL DEFAULT 0,  -- attributed marketing budget
  net_brokerage_margin    numeric     NOT NULL DEFAULT 0,  -- brokerage_gross – ai_cost – marketing
  roi_multiple            numeric,                          -- gci_gross / (ai_cost_cents/100 + marketing_spend_cents/100), NULL if no spend
  transaction_count       int         NOT NULL DEFAULT 0,
  computed_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, month_year)
);

CREATE INDEX IF NOT EXISTS idx_agent_pl_brokerage_month
  ON agent_pl_snapshot (brokerage_id, month_year DESC);
CREATE INDEX IF NOT EXISTS idx_agent_pl_agent_month
  ON agent_pl_snapshot (agent_id, month_year DESC);

ALTER TABLE agent_pl_snapshot ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS agent_pl_admin_all ON agent_pl_snapshot;
CREATE POLICY agent_pl_admin_all ON agent_pl_snapshot
  FOR ALL USING (
    brokerage_id = current_user_brokerage_id()
    AND current_user_type() IN ('broker','broker_admin','admin','superadmin','team_lead')
  );

DROP POLICY IF EXISTS agent_pl_agent_own ON agent_pl_snapshot;
CREATE POLICY agent_pl_agent_own ON agent_pl_snapshot
  FOR SELECT USING (
    brokerage_id = current_user_brokerage_id()
    AND agent_id IN (
      SELECT id FROM agents WHERE user_id = auth.uid()
    )
  );

-- ─── 2. cron_execution_logs — ensure cron_name column & index exist ──────────

ALTER TABLE cron_execution_logs
  ADD COLUMN IF NOT EXISTS cron_name text,
  ADD COLUMN IF NOT EXISTS cron_path text;

CREATE INDEX IF NOT EXISTS idx_cel_cron_name_started
  ON cron_execution_logs (cron_name, started_at DESC)
  WHERE cron_name IS NOT NULL;

-- ─── 3. cron_health_snapshot ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cron_health_snapshot (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  cron_name               text        NOT NULL,
  cron_path               text,
  last_run_at             timestamptz,
  -- VOCABULARY CORRECTED 2026-08-23. This comment claimed four words and there
  -- is no CHECK on the column to hold anyone to them, so it was the only thing
  -- readers had to go on and two of the four had no writer at all. The truth is
  -- lib/kernel/cron-logging.ts:CRON_SNAPSHOT_STATUSES — 'running' (stamped by
  -- createCronRunContext at the start choke), 'success' (:319), 'failure'
  -- (:415). 'partial' had no producer and its read sites are now deleted.
  last_status             text,        -- 'running'|'success'|'failure'
  last_duration_ms        int,
  last_records_processed  int,
  last_error_message      text,
  expected_interval_hours int         NOT NULL DEFAULT 24,
  -- is_stale computed live: last_run_at IS NULL OR last_run_at < now() - interval
  run_count_7d            int         NOT NULL DEFAULT 0,
  failure_count_7d        int         NOT NULL DEFAULT 0,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cron_name)
);

CREATE INDEX IF NOT EXISTS idx_chs_stale  ON cron_health_snapshot (is_stale, last_run_at DESC);
CREATE INDEX IF NOT EXISTS idx_chs_status ON cron_health_snapshot (last_status, updated_at DESC);

ALTER TABLE cron_health_snapshot ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS chs_admin_all ON cron_health_snapshot;
CREATE POLICY chs_admin_all ON cron_health_snapshot
  FOR ALL USING (
    current_user_type() IN ('broker','broker_admin','admin','superadmin','team_lead')
  );

-- Pre-seed known crons with their expected intervals (hours)
-- So the health dashboard shows them even before they've run once.
INSERT INTO cron_health_snapshot (cron_name, cron_path, expected_interval_hours) VALUES
  ('earnings-rollup',                '/app/api/cron/earnings-rollup',                24),
  ('revenue-protection-rollup',      '/app/api/cron/revenue-protection-rollup',      24),
  ('lifetime-npv-forecast-rollup',   '/app/api/cron/lifetime-npv-forecast-rollup',   24),
  ('recalculate-roi',                '/app/api/cron/recalculate-roi',                24),
  ('brokerage-pl-rollup',            '/app/api/cron/brokerage-pl-rollup',            24),
  ('marketing-attribution-engine',   '/app/api/cron/marketing-attribution-engine',   24),
  ('marketing-campaign-scheduler',   '/app/api/cron/marketing-campaign-scheduler',    1),
  ('marketing-trigger-engine',       '/app/api/cron/marketing-trigger-engine',        1),
  ('weekly-ai-metrics',              '/app/api/cron/weekly-ai-metrics',             168),
  ('tenant-safety-scan',             '/app/api/cron/tenant-safety-scan',             24),
  ('health-check',                   '/app/api/cron/health-check',                    1),
  ('agent-health-check',             '/app/api/cron/agent-health-check',             24),
  ('deal-health-scan',               '/app/api/cron/deal-health-scan',               24),
  ('listing-health-scan',            '/app/api/cron/listing-health-scan',            24),
  ('stale-contact-monitor',          '/app/api/cron/stale-contact-monitor',          24),
  ('stale-lead-monitor',             '/app/api/cron/stale-lead-monitor',             24),
  ('automation-error-monitor',       '/app/api/cron/automation-error-monitor',        1),
  ('compliance-monitoring',          '/app/api/cron/compliance-monitoring',          24),
  ('contact-enrichment',             '/app/api/cron/contact-enrichment',             24),
  ('enrichment-processor',           '/app/api/cron/enrichment-processor',           24),
  ('engagement-scores',              '/app/api/cron/engagement-scores',              24),
  ('ghost-detection',                '/app/api/cron/ghost-detection',                24),
  ('pattern-scan',                   '/app/api/cron/pattern-scan',                   24),
  ('wealth-opportunity-scan',        '/app/api/cron/wealth-opportunity-scan',       168),
  ('daily-briefing',                 '/app/api/cron/daily-briefing',                 24),
  ('market-data-refresh',            '/app/api/cron/market-data-refresh',            24),
  ('portal-stream-projector',        '/app/api/cron/portal-stream-projector',         1),
  ('deadline-watcher',               '/app/api/cron/deadline-watcher',                1),
  ('calendar-sync',                  '/app/api/cron/calendar-sync',                   1),
  ('onboarding-health',              '/app/api/cron/onboarding-health',              24),
  ('onboarding-progress-tracker',    '/app/api/cron/onboarding-progress-tracker',    24),
  ('onboarding-reminders',           '/app/api/cron/onboarding-reminders',           24),
  ('poll-did-videos',                '/app/api/cron/poll-did-videos',                 1),
  ('poll-did-avatars',               '/app/api/cron/poll-did-avatars',               24),
  ('poll-heygen-videos',             '/app/api/cron/poll-heygen-videos',              1),
  ('team-heatmap-snapshot',          '/app/api/cron/team-heatmap-snapshot',          24),
  ('territory-metrics',              '/app/api/cron/territory-metrics',              24),
  ('generate-brokerage-fee-charges', '/app/api/cron/generate-brokerage-fee-charges', 24),
  ('negotiation-strategy-generator', '/app/api/cron/negotiation-strategy-generator', 24),
  ('publish-social-posts',           '/app/api/cron/publish-social-posts',            1),
  ('social-publisher',               '/app/api/cron/social-publisher',                1),
  ('distribute-podcast-episodes',    '/app/api/cron/distribute-podcast-episodes',    24),
  ('review-request-on-close',        '/app/api/cron/review-request-on-close',        24),
  ('referral-asks',                  '/app/api/cron/referral-asks',                  24),
  ('workflow-retries',               '/app/api/cron/workflow-retries',                1),
  ('retry-errors',                   '/app/api/cron/retry-errors',                    1),
  ('lead-scraping',                  '/app/api/cron/lead-scraping',                  24),
  ('scrape-leads-all-sources',       '/app/api/cron/scrape-leads-all-sources',       24),
  ('gbp-auto-posts',                 '/app/api/cron/gbp-auto-posts',                168),
  ('annual-home-value-reports',      '/app/api/cron/annual-home-value-reports',     8760),
  ('market-insights-weekly',         '/app/api/cron/market-insights-weekly',        168),
  ('predictive-listing-scoring',     '/app/api/cron/predictive-listing-scoring',     24),
  ('predictive-listing-execute',     '/app/api/cron/predictive-listing-execute',     24),
  ('sphere-resonance',               '/app/api/cron/sphere-resonance',              168),
  ('long-term-nurture',              '/app/api/cron/long-term-nurture',             168),
  ('weekly-coaching',                '/app/api/cron/weekly-coaching',               168),
  ('seller-updates',                 '/app/api/cron/seller-updates',                 24),
  ('campaign-sequence-steps',        '/app/api/cron/campaign-sequence-steps',         1),
  ('sync-facebook-audiences',        '/app/api/cron/sync-facebook-audiences',       24),
  ('dotloop-sync',                   '/app/api/cron/dotloop-sync',                   24),
  ('lifetime-customer-touchpoints',  '/app/api/cron/lifetime-customer-touchpoints',  24),
  ('prompt-calibration',             '/app/api/cron/prompt-calibration',            168),
  ('contingency-scan',               '/app/api/cron/contingency-scan',               24),
  ('listing-presentation-prep',      '/app/api/cron/listing-presentation-prep',      24),
  ('brokerage-intelligence-mine',    '/app/api/cron/brokerage-intelligence-mine',    24)
ON CONFLICT (cron_name) DO NOTHING;

COMMIT;
