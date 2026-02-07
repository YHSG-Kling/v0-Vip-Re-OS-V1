-- =====================================================
-- 005: LISTINGS POLICIES
-- =====================================================
-- Governance: Listings belong to brokerages and are managed by agents
-- Compliance: Listings require proper authorization and MLS compliance

-- Enable RLS
ALTER TABLE listings ENABLE ROW LEVEL SECURITY;

-- =====================================================
-- SELECT POLICIES
-- =====================================================

-- Policy: Agents can view their brokerage's listings
DROP POLICY IF EXISTS "agents_view_brokerage_listings" ON listings;
CREATE POLICY "agents_view_brokerage_listings"
  ON listings
  FOR SELECT
  USING (
    brokerage_id = auth_helpers.get_user_brokerage_id()
    AND auth_helpers.user_has_role('agent')
  );

-- Policy: Brokers can view all listings in their brokerage
DROP POLICY IF EXISTS "brokers_view_all_listings" ON listings;
CREATE POLICY "brokers_view_all_listings"
  ON listings
  FOR SELECT
  USING (
    brokerage_id = auth_helpers.get_user_brokerage_id()
    AND auth_helpers.user_has_role('broker')
  );

-- Policy: Admins can view all listings across all brokerages
DROP POLICY IF EXISTS "admins_view_all_listings" ON listings;
CREATE POLICY "admins_view_all_listings"
  ON listings
  FOR SELECT
  USING (auth_helpers.user_has_role('admin'));

-- Policy: Transaction Coordinators can view listings related to their transactions
DROP POLICY IF EXISTS "tc_view_transaction_listings" ON listings;
CREATE POLICY "tc_view_transaction_listings"
  ON listings
  FOR SELECT
  USING (
    auth_helpers.user_has_role('transaction_coordinator')
    AND EXISTS (
      SELECT 1 FROM transactions t
      WHERE t.listing_id = listings.id
      AND t.brokerage_id = auth_helpers.get_user_brokerage_id()
    )
  );

-- =====================================================
-- INSERT POLICIES
-- =====================================================

-- Policy: Agents can create listings for their brokerage
DROP POLICY IF EXISTS "agents_create_listings" ON listings;
CREATE POLICY "agents_create_listings"
  ON listings
  FOR INSERT
  WITH CHECK (
    brokerage_id = auth_helpers.get_user_brokerage_id()
    AND auth_helpers.user_has_role('agent')
    AND agent_id = auth_helpers.get_user_agent_id()
  );

-- Policy: Brokers can create listings for their brokerage
DROP POLICY IF EXISTS "brokers_create_listings" ON listings;
CREATE POLICY "brokers_create_listings"
  ON listings
  FOR INSERT
  WITH CHECK (
    brokerage_id = auth_helpers.get_user_brokerage_id()
    AND auth_helpers.user_has_role('broker')
  );

-- Policy: Admins can create listings for any brokerage
DROP POLICY IF EXISTS "admins_create_listings" ON listings;
CREATE POLICY "admins_create_listings"
  ON listings
  FOR INSERT
  WITH CHECK (auth_helpers.user_has_role('admin'));

-- =====================================================
-- UPDATE POLICIES
-- =====================================================

-- Policy: Agents can update their own listings
DROP POLICY IF EXISTS "agents_update_own_listings" ON listings;
CREATE POLICY "agents_update_own_listings"
  ON listings
  FOR UPDATE
  USING (
    agent_id = auth_helpers.get_user_agent_id()
    AND auth_helpers.user_has_role('agent')
  )
  WITH CHECK (
    agent_id = auth_helpers.get_user_agent_id()
    AND brokerage_id = auth_helpers.get_user_brokerage_id()
  );

-- Policy: Brokers can update any listing in their brokerage
DROP POLICY IF EXISTS "brokers_update_brokerage_listings" ON listings;
CREATE POLICY "brokers_update_brokerage_listings"
  ON listings
  FOR UPDATE
  USING (
    brokerage_id = auth_helpers.get_user_brokerage_id()
    AND auth_helpers.user_has_role('broker')
  )
  WITH CHECK (
    brokerage_id = auth_helpers.get_user_brokerage_id()
  );

-- Policy: Admins can update any listing
DROP POLICY IF EXISTS "admins_update_all_listings" ON listings;
CREATE POLICY "admins_update_all_listings"
  ON listings
  FOR UPDATE
  USING (auth_helpers.user_has_role('admin'))
  WITH CHECK (auth_helpers.user_has_role('admin'));

-- =====================================================
-- DELETE POLICIES
-- =====================================================

-- Policy: Brokers can delete listings in their brokerage
DROP POLICY IF EXISTS "brokers_delete_brokerage_listings" ON listings;
CREATE POLICY "brokers_delete_brokerage_listings"
  ON listings
  FOR DELETE
  USING (
    brokerage_id = auth_helpers.get_user_brokerage_id()
    AND auth_helpers.user_has_role('broker')
  );

-- Policy: Admins can delete any listing
DROP POLICY IF EXISTS "admins_delete_all_listings" ON listings;
CREATE POLICY "admins_delete_all_listings"
  ON listings
  FOR DELETE
  USING (auth_helpers.user_has_role('admin'));

-- =====================================================
-- LISTING MEDIA POLICIES (if listing_media table exists)
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'listing_media') THEN
    ALTER TABLE listing_media ENABLE ROW LEVEL SECURITY;

    -- Agents can view media for listings they can access
    DROP POLICY IF EXISTS "agents_view_listing_media" ON listing_media;
    CREATE POLICY "agents_view_listing_media"
      ON listing_media
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM listings l
          WHERE l.id = listing_media.listing_id
          AND l.brokerage_id = auth_helpers.get_user_brokerage_id()
        )
      );

    -- Agents can create media for their listings
    DROP POLICY IF EXISTS "agents_create_listing_media" ON listing_media;
    CREATE POLICY "agents_create_listing_media"
      ON listing_media
      FOR INSERT
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM listings l
          WHERE l.id = listing_media.listing_id
          AND l.agent_id = auth_helpers.get_user_agent_id()
        )
      );

    -- Agents can update media for their listings
    DROP POLICY IF EXISTS "agents_update_listing_media" ON listing_media;
    CREATE POLICY "agents_update_listing_media"
      ON listing_media
      FOR UPDATE
      USING (
        EXISTS (
          SELECT 1 FROM listings l
          WHERE l.id = listing_media.listing_id
          AND l.agent_id = auth_helpers.get_user_agent_id()
        )
      );

    -- Brokers can manage all listing media in their brokerage
    DROP POLICY IF EXISTS "brokers_manage_listing_media" ON listing_media;
    CREATE POLICY "brokers_manage_listing_media"
      ON listing_media
      FOR ALL
      USING (
        auth_helpers.user_has_role('broker')
        AND EXISTS (
          SELECT 1 FROM listings l
          WHERE l.id = listing_media.listing_id
          AND l.brokerage_id = auth_helpers.get_user_brokerage_id()
        )
      );

    -- Admins can manage all listing media
    DROP POLICY IF EXISTS "admins_manage_all_listing_media" ON listing_media;
    CREATE POLICY "admins_manage_all_listing_media"
      ON listing_media
      FOR ALL
      USING (auth_helpers.user_has_role('admin'));
  END IF;
END $$;

-- =====================================================
-- AUDIT LOG
-- =====================================================

COMMENT ON TABLE listings IS 'RLS Policies Applied: 005-listings-policies.sql - Enforces brokerage isolation, agent ownership, and role-based access for listings';
