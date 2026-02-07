-- =====================================================
-- 008: COMPLIANCE & AUDIT POLICIES
-- =====================================================
-- Governance: Compliance data requires the highest level of security
-- Compliance: Audit logs must be immutable and accessible only to authorized roles

-- =====================================================
-- COMPLIANCE CHECKS POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'compliance_checks') THEN
    ALTER TABLE compliance_checks ENABLE ROW LEVEL SECURITY;

    -- SELECT: Brokers and admins can view compliance checks for their brokerage
    DROP POLICY IF EXISTS "brokers_view_compliance_checks" ON compliance_checks;
    CREATE POLICY "brokers_view_compliance_checks"
      ON compliance_checks
      FOR SELECT
      USING (
        brokerage_id = auth_helpers.get_user_brokerage_id()
        AND (
          auth_helpers.user_has_role('broker')
          OR auth_helpers.user_has_role('compliance_officer')
          OR auth_helpers.user_has_role('admin')
        )
      );

    -- INSERT: System and compliance officers can create compliance checks
    DROP POLICY IF EXISTS "compliance_create_checks" ON compliance_checks;
    CREATE POLICY "compliance_create_checks"
      ON compliance_checks
      FOR INSERT
      WITH CHECK (
        auth_helpers.user_has_role('compliance_officer')
        OR auth_helpers.user_has_role('admin')
      );

    -- UPDATE: Compliance officers can update checks
    DROP POLICY IF EXISTS "compliance_update_checks" ON compliance_checks;
    CREATE POLICY "compliance_update_checks"
      ON compliance_checks
      FOR UPDATE
      USING (
        auth_helpers.user_has_role('compliance_officer')
        OR auth_helpers.user_has_role('admin')
      );

    -- DELETE: Only admins can delete compliance checks
    DROP POLICY IF EXISTS "admins_delete_compliance_checks" ON compliance_checks;
    CREATE POLICY "admins_delete_compliance_checks"
      ON compliance_checks
      FOR DELETE
      USING (auth_helpers.user_has_role('admin'));
  END IF;
END $$;

-- =====================================================
-- AUDIT LOGS POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_logs') THEN
    ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

    -- SELECT: Brokers can view audit logs for their brokerage
    DROP POLICY IF EXISTS "brokers_view_audit_logs" ON audit_logs;
    CREATE POLICY "brokers_view_audit_logs"
      ON audit_logs
      FOR SELECT
      USING (
        brokerage_id = auth_helpers.get_user_brokerage_id()
        AND auth_helpers.user_has_role('broker')
      );

    -- SELECT: Admins can view all audit logs
    DROP POLICY IF EXISTS "admins_view_all_audit_logs" ON audit_logs;
    CREATE POLICY "admins_view_all_audit_logs"
      ON audit_logs
      FOR SELECT
      USING (auth_helpers.user_has_role('admin'));

    -- INSERT: System can create audit logs (typically via triggers)
    DROP POLICY IF EXISTS "system_create_audit_logs" ON audit_logs;
    CREATE POLICY "system_create_audit_logs"
      ON audit_logs
      FOR INSERT
      WITH CHECK (true);

    -- UPDATE: Audit logs are immutable (no updates allowed)
    -- DELETE: Only admins can delete old audit logs (for retention policies)
    DROP POLICY IF EXISTS "admins_delete_old_audit_logs" ON audit_logs;
    CREATE POLICY "admins_delete_old_audit_logs"
      ON audit_logs
      FOR DELETE
      USING (
        auth_helpers.user_has_role('admin')
        AND created_at < NOW() - INTERVAL '7 years'
      );
  END IF;
END $$;

-- =====================================================
-- DATA RETENTION POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'data_retention_policies') THEN
    ALTER TABLE data_retention_policies ENABLE ROW LEVEL SECURITY;

    -- SELECT: Brokers and admins can view retention policies
    DROP POLICY IF EXISTS "brokers_view_retention_policies" ON data_retention_policies;
    CREATE POLICY "brokers_view_retention_policies"
      ON data_retention_policies
      FOR SELECT
      USING (
        auth_helpers.user_has_role('broker')
        OR auth_helpers.user_has_role('admin')
      );

    -- INSERT: Only admins can create retention policies
    DROP POLICY IF EXISTS "admins_create_retention_policies" ON data_retention_policies;
    CREATE POLICY "admins_create_retention_policies"
      ON data_retention_policies
      FOR INSERT
      WITH CHECK (auth_helpers.user_has_role('admin'));

    -- UPDATE: Only admins can update retention policies
    DROP POLICY IF EXISTS "admins_update_retention_policies" ON data_retention_policies;
    CREATE POLICY "admins_update_retention_policies"
      ON data_retention_policies
      FOR UPDATE
      USING (auth_helpers.user_has_role('admin'));

    -- DELETE: Only admins can delete retention policies
    DROP POLICY IF EXISTS "admins_delete_retention_policies" ON data_retention_policies;
    CREATE POLICY "admins_delete_retention_policies"
      ON data_retention_policies
      FOR DELETE
      USING (auth_helpers.user_has_role('admin'));
  END IF;
END $$;

-- =====================================================
-- CONSENT MANAGEMENT POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'consent_records') THEN
    ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;

    -- SELECT: Users can view consent records for contacts in their brokerage
    DROP POLICY IF EXISTS "users_view_consent_records" ON consent_records;
    CREATE POLICY "users_view_consent_records"
      ON consent_records
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM contacts c
          WHERE c.id = consent_records.contact_id
          AND c.brokerage_id = auth_helpers.get_user_brokerage_id()
        )
        OR auth_helpers.user_has_role('admin')
      );

    -- INSERT: System and agents can create consent records
    DROP POLICY IF EXISTS "agents_create_consent_records" ON consent_records;
    CREATE POLICY "agents_create_consent_records"
      ON consent_records
      FOR INSERT
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM contacts c
          WHERE c.id = consent_records.contact_id
          AND c.brokerage_id = auth_helpers.get_user_brokerage_id()
        )
      );

    -- UPDATE: Consent records should be immutable (no updates)
    -- DELETE: Only admins can delete consent records
    DROP POLICY IF EXISTS "admins_delete_consent_records" ON consent_records;
    CREATE POLICY "admins_delete_consent_records"
      ON consent_records
      FOR DELETE
      USING (auth_helpers.user_has_role('admin'));
  END IF;
END $$;

-- =====================================================
-- LEAD DEDUPLICATION LOG POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'lead_deduplication_log') THEN
    ALTER TABLE lead_deduplication_log ENABLE ROW LEVEL SECURITY;

    -- SELECT: Brokers and admins can view deduplication logs
    DROP POLICY IF EXISTS "brokers_view_dedup_log" ON lead_deduplication_log;
    CREATE POLICY "brokers_view_dedup_log"
      ON lead_deduplication_log
      FOR SELECT
      USING (
        auth_helpers.user_has_role('broker')
        OR auth_helpers.user_has_role('admin')
      );

    -- INSERT: System can create deduplication logs
    DROP POLICY IF EXISTS "system_create_dedup_log" ON lead_deduplication_log;
    CREATE POLICY "system_create_dedup_log"
      ON lead_deduplication_log
      FOR INSERT
      WITH CHECK (true);

    -- UPDATE: Deduplication logs are immutable
    -- DELETE: Only admins can delete old logs
    DROP POLICY IF EXISTS "admins_delete_old_dedup_logs" ON lead_deduplication_log;
    CREATE POLICY "admins_delete_old_dedup_logs"
      ON lead_deduplication_log
      FOR DELETE
      USING (
        auth_helpers.user_has_role('admin')
        AND created_at < NOW() - INTERVAL '1 year'
      );
  END IF;
END $$;

-- =====================================================
-- VENDOR USAGE TRACKING POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'vendor_usage_tracking') THEN
    ALTER TABLE vendor_usage_tracking ENABLE ROW LEVEL SECURITY;

    -- SELECT: Brokers can view vendor usage for their brokerage
    DROP POLICY IF EXISTS "brokers_view_vendor_usage" ON vendor_usage_tracking;
    CREATE POLICY "brokers_view_vendor_usage"
      ON vendor_usage_tracking
      FOR SELECT
      USING (
        brokerage_id = auth_helpers.get_user_brokerage_id()
        AND (
          auth_helpers.user_has_role('broker')
          OR auth_helpers.user_has_role('admin')
        )
      );

    -- INSERT: System can create vendor usage records
    DROP POLICY IF EXISTS "system_create_vendor_usage" ON vendor_usage_tracking;
    CREATE POLICY "system_create_vendor_usage"
      ON vendor_usage_tracking
      FOR INSERT
      WITH CHECK (true);

    -- UPDATE: Vendor usage records are immutable
    -- DELETE: Only admins can delete old usage records
    DROP POLICY IF EXISTS "admins_delete_old_vendor_usage" ON vendor_usage_tracking;
    CREATE POLICY "admins_delete_old_vendor_usage"
      ON vendor_usage_tracking
      FOR DELETE
      USING (
        auth_helpers.user_has_role('admin')
        AND created_at < NOW() - INTERVAL '2 years'
      );
  END IF;
END $$;

-- =====================================================
-- AUDIT LOG
-- =====================================================

COMMENT ON SCHEMA public IS 'RLS Policies Applied: 008-compliance-policies.sql - Enforces strict compliance and audit trail security with immutable logs';
