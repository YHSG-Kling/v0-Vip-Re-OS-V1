-- =====================================================
-- 009: VENDOR ACCESS POLICIES
-- =====================================================
-- Governance: External vendor data must be isolated and tracked
-- Compliance: Third-party integrations require audit trails and cost tracking

-- =====================================================
-- RAW SCRAPED LEADS POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'raw_scraped_leads') THEN
    ALTER TABLE raw_scraped_leads ENABLE ROW LEVEL SECURITY;

    -- SELECT: Brokers and admins can view raw leads for their brokerage
    DROP POLICY IF EXISTS "brokers_view_raw_leads" ON raw_scraped_leads;
    CREATE POLICY "brokers_view_raw_leads"
      ON raw_scraped_leads
      FOR SELECT
      USING (
        brokerage_id = auth_helpers.get_user_brokerage_id()
        AND (
          auth_helpers.user_has_role('broker')
          OR auth_helpers.user_has_role('admin')
        )
      );

    -- INSERT: System can insert raw scraped leads
    DROP POLICY IF EXISTS "system_insert_raw_leads" ON raw_scraped_leads;
    CREATE POLICY "system_insert_raw_leads"
      ON raw_scraped_leads
      FOR INSERT
      WITH CHECK (true);

    -- UPDATE: System can update processing status
    DROP POLICY IF EXISTS "system_update_raw_leads" ON raw_scraped_leads;
    CREATE POLICY "system_update_raw_leads"
      ON raw_scraped_leads
      FOR UPDATE
      USING (true)
      WITH CHECK (true);

    -- DELETE: Only admins can delete raw leads
    DROP POLICY IF EXISTS "admins_delete_raw_leads" ON raw_scraped_leads;
    CREATE POLICY "admins_delete_raw_leads"
      ON raw_scraped_leads
      FOR DELETE
      USING (auth_helpers.user_has_role('admin'));
  END IF;
END $$;

-- =====================================================
-- API KEYS & CREDENTIALS POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'api_credentials') THEN
    ALTER TABLE api_credentials ENABLE ROW LEVEL SECURITY;

    -- SELECT: Only brokers can view API credentials for their brokerage
    DROP POLICY IF EXISTS "brokers_view_api_credentials" ON api_credentials;
    CREATE POLICY "brokers_view_api_credentials"
      ON api_credentials
      FOR SELECT
      USING (
        brokerage_id = auth_helpers.get_user_brokerage_id()
        AND auth_helpers.user_has_role('broker')
      );

    -- SELECT: Admins can view all API credentials
    DROP POLICY IF EXISTS "admins_view_all_api_credentials" ON api_credentials;
    CREATE POLICY "admins_view_all_api_credentials"
      ON api_credentials
      FOR SELECT
      USING (auth_helpers.user_has_role('admin'));

    -- INSERT: Only brokers and admins can create API credentials
    DROP POLICY IF EXISTS "brokers_create_api_credentials" ON api_credentials;
    CREATE POLICY "brokers_create_api_credentials"
      ON api_credentials
      FOR INSERT
      WITH CHECK (
        brokerage_id = auth_helpers.get_user_brokerage_id()
        AND (
          auth_helpers.user_has_role('broker')
          OR auth_helpers.user_has_role('admin')
        )
      );

    -- UPDATE: Only brokers can update their brokerage's API credentials
    DROP POLICY IF EXISTS "brokers_update_api_credentials" ON api_credentials;
    CREATE POLICY "brokers_update_api_credentials"
      ON api_credentials
      FOR UPDATE
      USING (
        brokerage_id = auth_helpers.get_user_brokerage_id()
        AND auth_helpers.user_has_role('broker')
      );

    -- DELETE: Only brokers can delete their brokerage's API credentials
    DROP POLICY IF EXISTS "brokers_delete_api_credentials" ON api_credentials;
    CREATE POLICY "brokers_delete_api_credentials"
      ON api_credentials
      FOR DELETE
      USING (
        brokerage_id = auth_helpers.get_user_brokerage_id()
        AND auth_helpers.user_has_role('broker')
      );
  END IF;
END $$;

-- =====================================================
-- EXTERNAL INTEGRATIONS POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'external_integrations') THEN
    ALTER TABLE external_integrations ENABLE ROW LEVEL SECURITY;

    -- SELECT: Users can view integrations for their brokerage
    DROP POLICY IF EXISTS "users_view_integrations" ON external_integrations;
    CREATE POLICY "users_view_integrations"
      ON external_integrations
      FOR SELECT
      USING (
        brokerage_id = auth_helpers.get_user_brokerage_id()
      );

    -- INSERT: Brokers can create integrations
    DROP POLICY IF EXISTS "brokers_create_integrations" ON external_integrations;
    CREATE POLICY "brokers_create_integrations"
      ON external_integrations
      FOR INSERT
      WITH CHECK (
        brokerage_id = auth_helpers.get_user_brokerage_id()
        AND auth_helpers.user_has_role('broker')
      );

    -- UPDATE: Brokers can update integrations
    DROP POLICY IF EXISTS "brokers_update_integrations" ON external_integrations;
    CREATE POLICY "brokers_update_integrations"
      ON external_integrations
      FOR UPDATE
      USING (
        brokerage_id = auth_helpers.get_user_brokerage_id()
        AND auth_helpers.user_has_role('broker')
      );

    -- DELETE: Brokers can delete integrations
    DROP POLICY IF EXISTS "brokers_delete_integrations" ON external_integrations;
    CREATE POLICY "brokers_delete_integrations"
      ON external_integrations
      FOR DELETE
      USING (
        brokerage_id = auth_helpers.get_user_brokerage_id()
        AND auth_helpers.user_has_role('broker')
      );
  END IF;
END $$;

-- =====================================================
-- WEBHOOK LOGS POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'webhook_logs') THEN
    ALTER TABLE webhook_logs ENABLE ROW LEVEL SECURITY;

    -- SELECT: Brokers can view webhook logs for their brokerage
    DROP POLICY IF EXISTS "brokers_view_webhook_logs" ON webhook_logs;
    CREATE POLICY "brokers_view_webhook_logs"
      ON webhook_logs
      FOR SELECT
      USING (
        brokerage_id = auth_helpers.get_user_brokerage_id()
        AND auth_helpers.user_has_role('broker')
      );

    -- SELECT: Admins can view all webhook logs
    DROP POLICY IF EXISTS "admins_view_all_webhook_logs" ON webhook_logs;
    CREATE POLICY "admins_view_all_webhook_logs"
      ON webhook_logs
      FOR SELECT
      USING (auth_helpers.user_has_role('admin'));

    -- INSERT: System can create webhook logs
    DROP POLICY IF EXISTS "system_create_webhook_logs" ON webhook_logs;
    CREATE POLICY "system_create_webhook_logs"
      ON webhook_logs
      FOR INSERT
      WITH CHECK (true);

    -- UPDATE: Webhook logs are immutable
    -- DELETE: Only admins can delete old webhook logs
    DROP POLICY IF EXISTS "admins_delete_old_webhook_logs" ON webhook_logs;
    CREATE POLICY "admins_delete_old_webhook_logs"
      ON webhook_logs
      FOR DELETE
      USING (
        auth_helpers.user_has_role('admin')
        AND created_at < NOW() - INTERVAL '90 days'
      );
  END IF;
END $$;

-- =====================================================
-- MLS INTEGRATION POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'mls_listings') THEN
    ALTER TABLE mls_listings ENABLE ROW LEVEL SECURITY;

    -- SELECT: All authenticated users can view MLS listings
    DROP POLICY IF EXISTS "users_view_mls_listings" ON mls_listings;
    CREATE POLICY "users_view_mls_listings"
      ON mls_listings
      FOR SELECT
      USING (auth.uid() IS NOT NULL);

    -- INSERT: System can import MLS listings
    DROP POLICY IF EXISTS "system_insert_mls_listings" ON mls_listings;
    CREATE POLICY "system_insert_mls_listings"
      ON mls_listings
      FOR INSERT
      WITH CHECK (true);

    -- UPDATE: System can update MLS listings
    DROP POLICY IF EXISTS "system_update_mls_listings" ON mls_listings;
    CREATE POLICY "system_update_mls_listings"
      ON mls_listings
      FOR UPDATE
      USING (true);

    -- DELETE: Only admins can delete MLS listings
    DROP POLICY IF EXISTS "admins_delete_mls_listings" ON mls_listings;
    CREATE POLICY "admins_delete_mls_listings"
      ON mls_listings
      FOR DELETE
      USING (auth_helpers.user_has_role('admin'));
  END IF;
END $$;

-- =====================================================
-- THIRD-PARTY DATA SYNC POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'data_sync_logs') THEN
    ALTER TABLE data_sync_logs ENABLE ROW LEVEL SECURITY;

    -- SELECT: Brokers can view sync logs for their brokerage
    DROP POLICY IF EXISTS "brokers_view_sync_logs" ON data_sync_logs;
    CREATE POLICY "brokers_view_sync_logs"
      ON data_sync_logs
      FOR SELECT
      USING (
        brokerage_id = auth_helpers.get_user_brokerage_id()
        AND auth_helpers.user_has_role('broker')
      );

    -- SELECT: Admins can view all sync logs
    DROP POLICY IF EXISTS "admins_view_all_sync_logs" ON data_sync_logs;
    CREATE POLICY "admins_view_all_sync_logs"
      ON data_sync_logs
      FOR SELECT
      USING (auth_helpers.user_has_role('admin'));

    -- INSERT: System can create sync logs
    DROP POLICY IF EXISTS "system_create_sync_logs" ON data_sync_logs;
    CREATE POLICY "system_create_sync_logs"
      ON data_sync_logs
      FOR INSERT
      WITH CHECK (true);

    -- UPDATE: Sync logs are immutable
    -- DELETE: Admins can delete old sync logs
    DROP POLICY IF EXISTS "admins_delete_old_sync_logs" ON data_sync_logs;
    CREATE POLICY "admins_delete_old_sync_logs"
      ON data_sync_logs
      FOR DELETE
      USING (
        auth_helpers.user_has_role('admin')
        AND created_at < NOW() - INTERVAL '180 days'
      );
  END IF;
END $$;

-- =====================================================
-- AUDIT LOG
-- =====================================================

COMMENT ON SCHEMA public IS 'RLS Policies Applied: 009-vendor-access-policies.sql - Enforces strict access control for external vendor data and API integrations';
