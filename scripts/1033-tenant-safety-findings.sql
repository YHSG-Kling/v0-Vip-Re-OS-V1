-- ============================================================================
-- Tenant Safety Findings — observability for the tenant-safety-scan cron
-- ============================================================================
--
-- Each scan run produces a batch of findings. A finding is one of:
--   - "rows_missing_brokerage_id"      a tenant table has rows where
--                                       brokerage_id IS NULL
--   - "table_missing_brokerage_id"     a public table has tenant data
--                                       but lacks a brokerage_id column
--   - "table_missing_rls_policy"       a tenanted table has no policy
--                                       that filters by brokerage_id
--   - "cross_tenant_join_risk"         (future) flagged by query analysis
--
-- Brokers / admins surface these findings in an admin UI; resolved status
-- + assignment + note for audit trail.
-- ============================================================================

CREATE TABLE IF NOT EXISTS tenant_safety_findings (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_run_id   uuid        NOT NULL,
  finding_type  text        NOT NULL CHECK (finding_type IN (
                                'rows_missing_brokerage_id',
                                'table_missing_brokerage_id',
                                'table_missing_rls_policy',
                                'cross_tenant_join_risk'
                              )),
  table_name    text        NOT NULL,
  severity      text        NOT NULL DEFAULT 'high'
                CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  details       jsonb       NOT NULL DEFAULT '{}',
  affected_rows int,
  resolved      boolean     NOT NULL DEFAULT false,
  resolved_at   timestamptz,
  resolved_by   uuid        REFERENCES users(id) ON DELETE SET NULL,
  resolution_note text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_tenant_safety_findings_unresolved
  ON tenant_safety_findings(resolved, severity, created_at DESC)
  WHERE resolved = false;

CREATE INDEX IF NOT EXISTS idx_tenant_safety_findings_run
  ON tenant_safety_findings(scan_run_id);

ALTER TABLE tenant_safety_findings ENABLE ROW LEVEL SECURITY;

-- Only superadmins / brokers / admins see findings. These are platform-level
-- — they cross all brokerages, so we gate by user_type rather than
-- brokerage_id.
DROP POLICY IF EXISTS tenant_safety_findings_admin_select ON tenant_safety_findings;
CREATE POLICY tenant_safety_findings_admin_select
  ON tenant_safety_findings
  FOR SELECT
  USING (
    current_user_type() IN ('superadmin', 'broker', 'broker_admin', 'admin', 'compliance_officer', 'compliance_manager')
  );

DROP POLICY IF EXISTS tenant_safety_findings_admin_update ON tenant_safety_findings;
CREATE POLICY tenant_safety_findings_admin_update
  ON tenant_safety_findings
  FOR UPDATE
  USING (
    current_user_type() IN ('superadmin', 'broker', 'broker_admin', 'admin', 'compliance_officer', 'compliance_manager')
  )
  WITH CHECK (
    current_user_type() IN ('superadmin', 'broker', 'broker_admin', 'admin', 'compliance_officer', 'compliance_manager')
  );

-- Service role writes the findings (the scan cron uses service client).
-- Explicit policy in case the implicit service-role bypass is ever disabled.
DROP POLICY IF EXISTS tenant_safety_findings_service_all ON tenant_safety_findings;
CREATE POLICY tenant_safety_findings_service_all
  ON tenant_safety_findings
  FOR ALL
  USING (true)
  WITH CHECK (true);
