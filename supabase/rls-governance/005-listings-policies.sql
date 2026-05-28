-- =====================================================
-- RLS GOVERNANCE: LISTINGS TABLE POLICIES
-- =====================================================
-- Purpose: Control access to listing records
-- Tables: listings, listing_media
-- Key Rules:
--   - listings.agent_id stores agents.id (NOT users.id) — use auth.agent_id()
--   - Brokerage isolation is always enforced via brokerage_id
--   - auth_helpers.* was non-existent; all policies now use canonical auth.* schema
-- =====================================================

-- Enable RLS
ALTER TABLE listings ENABLE ROW LEVEL SECURITY;

-- Drop all old policies (covers both old auth_helpers and auth naming conventions)
DROP POLICY IF EXISTS "agents_view_brokerage_listings"      ON listings;
DROP POLICY IF EXISTS "brokers_view_all_listings"           ON listings;
DROP POLICY IF EXISTS "admins_view_all_listings"            ON listings;
DROP POLICY IF EXISTS "tc_view_transaction_listings"        ON listings;
DROP POLICY IF EXISTS "agents_create_listings"              ON listings;
DROP POLICY IF EXISTS "brokers_create_listings"             ON listings;
DROP POLICY IF EXISTS "admins_create_listings"              ON listings;
DROP POLICY IF EXISTS "agents_update_own_listings"          ON listings;
DROP POLICY IF EXISTS "brokers_update_brokerage_listings"   ON listings;
DROP POLICY IF EXISTS "admins_update_all_listings"          ON listings;
DROP POLICY IF EXISTS "brokers_delete_brokerage_listings"   ON listings;
DROP POLICY IF EXISTS "admins_delete_all_listings"          ON listings;
DROP POLICY IF EXISTS "admin_read_all_listings"             ON listings;
DROP POLICY IF EXISTS "broker_read_brokerage_listings"      ON listings;
DROP POLICY IF EXISTS "agent_read_own_listings"             ON listings;
DROP POLICY IF EXISTS "team_leader_read_team_listings"      ON listings;
DROP POLICY IF EXISTS "compliance_read_brokerage_listings"  ON listings;
DROP POLICY IF EXISTS "tc_read_brokerage_listings"          ON listings;
DROP POLICY IF EXISTS "agent_insert_own_listings"           ON listings;
DROP POLICY IF EXISTS "broker_insert_listings"              ON listings;
DROP POLICY IF EXISTS "admin_insert_listings"               ON listings;
DROP POLICY IF EXISTS "agent_update_own_listings"           ON listings;
DROP POLICY IF EXISTS "broker_update_brokerage_listings"    ON listings;
DROP POLICY IF EXISTS "admin_update_listings"               ON listings;
DROP POLICY IF EXISTS "broker_delete_brokerage_listings"    ON listings;
DROP POLICY IF EXISTS "admin_delete_listings"               ON listings;

-- =====================================================
-- LISTINGS TABLE: SELECT POLICIES
-- =====================================================

-- Admin: Read all listings across all brokerages
CREATE POLICY "admin_read_all_listings"
  ON listings FOR SELECT
  USING (auth.is_admin());

-- Broker: Read all listings in their brokerage
CREATE POLICY "broker_read_brokerage_listings"
  ON listings FOR SELECT
  USING (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- Compliance Manager: Read all listings in their brokerage (audit)
CREATE POLICY "compliance_read_brokerage_listings"
  ON listings FOR SELECT
  USING (
    auth.is_compliance_manager()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- TC: Read listings tied to their brokerage's transactions
CREATE POLICY "tc_read_brokerage_listings"
  ON listings FOR SELECT
  USING (
    auth.is_tc()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- Agent: Read own listings + brokerage listings (agents need to see all brokerage listings for MLS/co-op)
-- FIX: listings.agent_id stores agents.id — use auth.agent_id()
CREATE POLICY "agent_read_own_listings"
  ON listings FOR SELECT
  USING (
    auth.is_agent()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- Team Leader: Read listings for agents on their team
-- FIX: listings.agent_id stores agents.id; must join agents -> users for team lookup
CREATE POLICY "team_leader_read_team_listings"
  ON listings FOR SELECT
  USING (
    auth.is_team_leader()
    AND (
      auth.has_brokerage_access(brokerage_id) OR
      agent_id IN (
        SELECT a.id FROM agents a
        JOIN users u ON a.user_id = u.id
        WHERE u.team_id = auth.user_team_id()
      )
    )
  );

-- =====================================================
-- LISTINGS TABLE: INSERT POLICIES
-- =====================================================

-- Admin: Insert any listing
CREATE POLICY "admin_insert_listings"
  ON listings FOR INSERT
  WITH CHECK (auth.is_admin());

-- Broker: Insert listings in their brokerage
CREATE POLICY "broker_insert_listings"
  ON listings FOR INSERT
  WITH CHECK (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- Agent: Insert listings in their brokerage assigned to themselves
-- FIX: listings.agent_id stores agents.id — use auth.agent_id()
CREATE POLICY "agent_insert_own_listings"
  ON listings FOR INSERT
  WITH CHECK (
    auth.is_agent()
    AND auth.has_brokerage_access(brokerage_id)
    AND (agent_id = auth.agent_id() OR agent_id IS NULL)
  );

-- =====================================================
-- LISTINGS TABLE: UPDATE POLICIES
-- =====================================================

-- Admin: Update any listing
CREATE POLICY "admin_update_listings"
  ON listings FOR UPDATE
  USING (auth.is_admin())
  WITH CHECK (auth.is_admin());

-- Broker: Update any listing in their brokerage
CREATE POLICY "broker_update_brokerage_listings"
  ON listings FOR UPDATE
  USING (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  )
  WITH CHECK (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- Agent: Update only their own listings
-- FIX: listings.agent_id stores agents.id — use auth.agent_id()
CREATE POLICY "agent_update_own_listings"
  ON listings FOR UPDATE
  USING (
    auth.is_agent()
    AND agent_id = auth.agent_id()
  )
  WITH CHECK (
    auth.is_agent()
    AND agent_id = auth.agent_id()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- =====================================================
-- LISTINGS TABLE: DELETE POLICIES
-- =====================================================

-- Admin: Delete any listing
CREATE POLICY "admin_delete_listings"
  ON listings FOR DELETE
  USING (auth.is_admin());

-- Broker: Delete listings in their brokerage (soft-delete preferred via status field)
CREATE POLICY "broker_delete_brokerage_listings"
  ON listings FOR DELETE
  USING (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- =====================================================
-- LISTING_MEDIA TABLE POLICIES
-- =====================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'listing_media') THEN
    ALTER TABLE listing_media ENABLE ROW LEVEL SECURITY;

    DROP POLICY IF EXISTS "agents_view_listing_media"      ON listing_media;
    DROP POLICY IF EXISTS "agents_create_listing_media"    ON listing_media;
    DROP POLICY IF EXISTS "agents_update_listing_media"    ON listing_media;
    DROP POLICY IF EXISTS "brokers_manage_listing_media"   ON listing_media;
    DROP POLICY IF EXISTS "admins_manage_all_listing_media" ON listing_media;
    DROP POLICY IF EXISTS "agent_read_listing_media"       ON listing_media;
    DROP POLICY IF EXISTS "agent_insert_listing_media"     ON listing_media;
    DROP POLICY IF EXISTS "agent_update_listing_media"     ON listing_media;
    DROP POLICY IF EXISTS "broker_manage_listing_media"    ON listing_media;
    DROP POLICY IF EXISTS "admin_manage_listing_media"     ON listing_media;

    -- Agents can view media for their brokerage's listings
    CREATE POLICY "agent_read_listing_media"
      ON listing_media FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM listings l
          WHERE l.id = listing_media.listing_id
          AND auth.has_brokerage_access(l.brokerage_id)
        )
      );

    -- Agents can insert/update media for their own listings
    -- FIX: listings.agent_id stores agents.id — use auth.agent_id()
    CREATE POLICY "agent_insert_listing_media"
      ON listing_media FOR INSERT
      WITH CHECK (
        EXISTS (
          SELECT 1 FROM listings l
          WHERE l.id = listing_media.listing_id
          AND l.agent_id = auth.agent_id()
        )
      );

    CREATE POLICY "agent_update_listing_media"
      ON listing_media FOR UPDATE
      USING (
        EXISTS (
          SELECT 1 FROM listings l
          WHERE l.id = listing_media.listing_id
          AND l.agent_id = auth.agent_id()
        )
      );

    -- Brokers can manage all listing media in their brokerage
    CREATE POLICY "broker_manage_listing_media"
      ON listing_media FOR ALL
      USING (
        auth.is_broker()
        AND EXISTS (
          SELECT 1 FROM listings l
          WHERE l.id = listing_media.listing_id
          AND auth.has_brokerage_access(l.brokerage_id)
        )
      );

    -- Admins can manage all listing media
    CREATE POLICY "admin_manage_listing_media"
      ON listing_media FOR ALL
      USING (auth.is_admin());
  END IF;
END $$;

-- =====================================================
-- AUDIT LOG
-- =====================================================

COMMENT ON TABLE listings IS 'RLS Policies Applied: 005-listings-policies.sql (rewritten) — uses canonical auth.* helpers; listings.agent_id is agents.id, not users.id; auth_helpers.* removed.';
