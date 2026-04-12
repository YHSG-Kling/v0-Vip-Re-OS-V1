-- =====================================================
-- MIGRATION 014: FIX AGENT_ID RLS ROOT BUG
-- =====================================================
-- Root Bug: contacts.agent_id, transactions.agent_id, listings.agent_id, etc.
-- all store agents.id (UUID from the agents table), NOT auth.uid() (= users.id).
-- The old policies compared agent_id = auth.uid() which always evaluated false
-- for every agent, causing agents to see zero rows from their own data.
--
-- Fix: auth.agent_id() resolves agents.id for the current users.id.
-- All agent_id comparisons now use auth.agent_id() instead of auth.uid().
-- auth.is_own_agent_id() provided as a safe boolean helper.
-- auth.is_self_contact() and auth.user_contact_id() fixed to use contact_user_id FK.
--
-- Idempotent: DROP IF EXISTS + CREATE OR REPLACE on all objects.
-- Apply via: Supabase SQL editor, supabase db push, or MCP apply_migration.
-- =====================================================

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 1: NEW + FIXED HELPER FUNCTIONS
-- ─────────────────────────────────────────────────────────────────────────────

-- Resolves agents.id for the currently authenticated user
CREATE OR REPLACE FUNCTION auth.agent_id()
RETURNS UUID AS $$
  SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1;
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Safe boolean check: does this agents.id belong to the current user?
CREATE OR REPLACE FUNCTION auth.is_own_agent_id(agent_id_to_check UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM agents
    WHERE id = agent_id_to_check
    AND user_id = auth.uid()
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Fix auth.owns_contact — contacts.agent_id stores agents.id, not users.id
CREATE OR REPLACE FUNCTION auth.owns_contact(contact_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM contacts
    WHERE id = $1
    AND agent_id = auth.agent_id()
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Fix auth.owns_transaction — *agent_id columns store agents.id, not users.id
CREATE OR REPLACE FUNCTION auth.owns_transaction(transaction_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM transactions
    WHERE id = $1
    AND (
      agent_id = auth.agent_id() OR
      seller_agent_id = auth.agent_id() OR
      buyer_agent_id = auth.agent_id()
    )
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Fix auth.owns_listing — listings.agent_id stores agents.id, not users.id
CREATE OR REPLACE FUNCTION auth.owns_listing(listing_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM listings
    WHERE id = $1
    AND agent_id = auth.agent_id()
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Fix auth.is_self_contact — use contact_user_id FK, not email JOIN
CREATE OR REPLACE FUNCTION auth.is_self_contact(contact_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM contacts
    WHERE id = $1
    AND contact_user_id = auth.uid()
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Fix auth.user_contact_id — use contact_user_id FK, not email JOIN
CREATE OR REPLACE FUNCTION auth.user_contact_id()
RETURNS UUID AS $$
  SELECT id FROM contacts
  WHERE contact_user_id = auth.uid()
  LIMIT 1;
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

GRANT EXECUTE ON FUNCTION auth.agent_id()                          TO authenticated;
GRANT EXECUTE ON FUNCTION auth.is_own_agent_id(UUID)               TO authenticated;
GRANT EXECUTE ON FUNCTION auth.owns_contact(UUID)                  TO authenticated;
GRANT EXECUTE ON FUNCTION auth.owns_transaction(UUID)              TO authenticated;
GRANT EXECUTE ON FUNCTION auth.owns_listing(UUID)                  TO authenticated;
GRANT EXECUTE ON FUNCTION auth.is_self_contact(UUID)               TO authenticated;
GRANT EXECUTE ON FUNCTION auth.user_contact_id()                   TO authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 2: CONTACTS TABLE — drop & recreate broken agent policies
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "team_leader_read_team_contacts"   ON contacts;
DROP POLICY IF EXISTS "agent_read_own_contacts"          ON contacts;
DROP POLICY IF EXISTS "agent_insert_own_contacts"        ON contacts;
DROP POLICY IF EXISTS "agent_update_own_contacts"        ON contacts;
-- interaction_history exists in live DB but has 0 RLS policies (RLS not enabled).
-- Do NOT create policies on it here; managed at application layer only.
-- DROP IF EXISTS is safe even if no policy exists.
DROP POLICY IF EXISTS "agent_manage_interaction_history" ON interaction_history;

-- Team Leader: join agents -> users for correct team resolution
CREATE POLICY "team_leader_read_team_contacts"
  ON contacts FOR SELECT
  USING (
    auth.is_team_leader()
    AND (
      team_id = auth.user_team_id() OR
      agent_id IN (
        SELECT a.id FROM agents a
        JOIN users u ON a.user_id = u.id
        WHERE u.team_id = auth.user_team_id()
      )
    )
  );

-- Agent SELECT: contacts.agent_id = auth.agent_id()
CREATE POLICY "agent_read_own_contacts"
  ON contacts FOR SELECT
  USING (
    auth.is_agent()
    AND agent_id = auth.agent_id()
  );

-- Agent INSERT: contacts.agent_id = auth.agent_id()
CREATE POLICY "agent_insert_own_contacts"
  ON contacts FOR INSERT
  WITH CHECK (
    auth.is_agent()
    AND auth.has_brokerage_access(brokerage_id)
    AND (agent_id = auth.agent_id() OR agent_id IS NULL)
  );

-- Agent UPDATE: contacts.agent_id = auth.agent_id()
CREATE POLICY "agent_update_own_contacts"
  ON contacts FOR UPDATE
  USING (
    auth.is_agent()
    AND agent_id = auth.agent_id()
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 3: TRANSACTIONS TABLE — drop & recreate broken agent policies
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "agent_read_own_transactions"            ON transactions;
DROP POLICY IF EXISTS "team_leader_read_team_transactions"     ON transactions;
DROP POLICY IF EXISTS "agent_insert_own_transactions"          ON transactions;
DROP POLICY IF EXISTS "agent_update_own_transactions"          ON transactions;
DROP POLICY IF EXISTS "agent_manage_offers"                    ON offers;
-- NOTE: Live DB uses "agent_commissions" table (not "commissions")
-- The old "commissions" table doesn't exist — skip DROP to avoid error
DROP POLICY IF EXISTS "agent_read_own_commission_calculations" ON commission_calculations;

-- Agent SELECT: all agent_id columns use auth.agent_id()
CREATE POLICY "agent_read_own_transactions"
  ON transactions FOR SELECT
  USING (
    auth.is_agent()
    AND (
      agent_id = auth.agent_id() OR
      seller_agent_id = auth.agent_id() OR
      buyer_agent_id = auth.agent_id()
    )
  );

-- Team Leader: join agents -> users for team resolution on all agent columns
CREATE POLICY "team_leader_read_team_transactions"
  ON transactions FOR SELECT
  USING (
    auth.is_team_leader()
    AND (
      agent_id IN (
        SELECT a.id FROM agents a JOIN users u ON a.user_id = u.id WHERE u.team_id = auth.user_team_id()
      ) OR
      seller_agent_id IN (
        SELECT a.id FROM agents a JOIN users u ON a.user_id = u.id WHERE u.team_id = auth.user_team_id()
      ) OR
      buyer_agent_id IN (
        SELECT a.id FROM agents a JOIN users u ON a.user_id = u.id WHERE u.team_id = auth.user_team_id()
      )
    )
  );

-- Agent INSERT: all agent_id columns use auth.agent_id()
CREATE POLICY "agent_insert_own_transactions"
  ON transactions FOR INSERT
  WITH CHECK (
    auth.is_agent()
    AND auth.has_brokerage_access(brokerage_id)
    AND (
      agent_id = auth.agent_id() OR
      seller_agent_id = auth.agent_id() OR
      buyer_agent_id = auth.agent_id()
    )
  );

-- Agent UPDATE: all agent_id columns use auth.agent_id()
CREATE POLICY "agent_update_own_transactions"
  ON transactions FOR UPDATE
  USING (
    auth.is_agent()
    AND (
      agent_id = auth.agent_id() OR
      seller_agent_id = auth.agent_id() OR
      buyer_agent_id = auth.agent_id()
    )
  );

-- Offers: agent_id in sub-selects use auth.agent_id()
CREATE POLICY "agent_manage_offers"
  ON offers FOR ALL
  USING (
    auth.is_agent()
    AND (
      transaction_id IN (SELECT id FROM transactions WHERE agent_id = auth.agent_id()) OR
      listing_id IN (SELECT id FROM listings WHERE agent_id = auth.agent_id())
    )
  );

-- agent_commissions: live DB table name (not "commissions")
-- agent_commissions.agent_id stores agents.id
CREATE POLICY "agent_read_own_agent_commissions"
  ON agent_commissions FOR SELECT
  USING (
    auth.is_agent()
    AND agent_id = auth.agent_id()
  );

-- Commission calculations: via transactions.agent_id
CREATE POLICY "agent_read_own_commission_calculations"
  ON commission_calculations FOR SELECT
  USING (
    auth.is_agent()
    AND transaction_id IN (
      SELECT id FROM transactions WHERE agent_id = auth.agent_id()
    )
  );

-- ─────────────────────────────────────────────────────────────────────────────
-- STEP 4: LISTINGS TABLE — drop auth_helpers policies & recreate with auth.*
-- ─────────────────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "agents_view_brokerage_listings"     ON listings;
DROP POLICY IF EXISTS "brokers_view_all_listings"          ON listings;
DROP POLICY IF EXISTS "admins_view_all_listings"           ON listings;
DROP POLICY IF EXISTS "tc_view_transaction_listings"       ON listings;
DROP POLICY IF EXISTS "agents_create_listings"             ON listings;
DROP POLICY IF EXISTS "brokers_create_listings"            ON listings;
DROP POLICY IF EXISTS "admins_create_listings"             ON listings;
DROP POLICY IF EXISTS "agents_update_own_listings"         ON listings;
DROP POLICY IF EXISTS "brokers_update_brokerage_listings"  ON listings;
DROP POLICY IF EXISTS "admins_update_all_listings"         ON listings;
DROP POLICY IF EXISTS "brokers_delete_brokerage_listings"  ON listings;
DROP POLICY IF EXISTS "admins_delete_all_listings"         ON listings;
DROP POLICY IF EXISTS "admin_read_all_listings"            ON listings;
DROP POLICY IF EXISTS "broker_read_brokerage_listings"     ON listings;
DROP POLICY IF EXISTS "agent_read_own_listings"            ON listings;
DROP POLICY IF EXISTS "team_leader_read_team_listings"     ON listings;
DROP POLICY IF EXISTS "compliance_read_brokerage_listings" ON listings;
DROP POLICY IF EXISTS "tc_read_brokerage_listings"         ON listings;
DROP POLICY IF EXISTS "agent_insert_own_listings"          ON listings;
DROP POLICY IF EXISTS "broker_insert_listings"             ON listings;
DROP POLICY IF EXISTS "admin_insert_listings"              ON listings;
DROP POLICY IF EXISTS "agent_update_own_listings"          ON listings;
DROP POLICY IF EXISTS "broker_update_brokerage_listings"   ON listings;
DROP POLICY IF EXISTS "admin_update_listings"              ON listings;
DROP POLICY IF EXISTS "broker_delete_brokerage_listings"   ON listings;
DROP POLICY IF EXISTS "admin_delete_listings"              ON listings;

-- Admin
CREATE POLICY "admin_read_all_listings"    ON listings FOR SELECT USING (auth.is_admin());
CREATE POLICY "admin_insert_listings"      ON listings FOR INSERT WITH CHECK (auth.is_admin());
CREATE POLICY "admin_update_listings"      ON listings FOR UPDATE USING (auth.is_admin()) WITH CHECK (auth.is_admin());
CREATE POLICY "admin_delete_listings"      ON listings FOR DELETE USING (auth.is_admin());

-- Broker
CREATE POLICY "broker_read_brokerage_listings"
  ON listings FOR SELECT
  USING (auth.is_broker() AND auth.has_brokerage_access(brokerage_id));

CREATE POLICY "broker_insert_listings"
  ON listings FOR INSERT
  WITH CHECK (auth.is_broker() AND auth.has_brokerage_access(brokerage_id));

CREATE POLICY "broker_update_brokerage_listings"
  ON listings FOR UPDATE
  USING (auth.is_broker() AND auth.has_brokerage_access(brokerage_id))
  WITH CHECK (auth.is_broker() AND auth.has_brokerage_access(brokerage_id));

CREATE POLICY "broker_delete_brokerage_listings"
  ON listings FOR DELETE
  USING (auth.is_broker() AND auth.has_brokerage_access(brokerage_id));

-- Compliance
CREATE POLICY "compliance_read_brokerage_listings"
  ON listings FOR SELECT
  USING (auth.is_compliance_manager() AND auth.has_brokerage_access(brokerage_id));

-- TC
CREATE POLICY "tc_read_brokerage_listings"
  ON listings FOR SELECT
  USING (auth.is_tc() AND auth.has_brokerage_access(brokerage_id));

-- Agent SELECT: brokerage-scoped (agents need to see all brokerage listings for MLS)
CREATE POLICY "agent_read_own_listings"
  ON listings FOR SELECT
  USING (auth.is_agent() AND auth.has_brokerage_access(brokerage_id));

-- Agent INSERT: listings.agent_id = auth.agent_id()
CREATE POLICY "agent_insert_own_listings"
  ON listings FOR INSERT
  WITH CHECK (
    auth.is_agent()
    AND auth.has_brokerage_access(brokerage_id)
    AND (agent_id = auth.agent_id() OR agent_id IS NULL)
  );

-- Agent UPDATE: listings.agent_id = auth.agent_id()
CREATE POLICY "agent_update_own_listings"
  ON listings FOR UPDATE
  USING (auth.is_agent() AND agent_id = auth.agent_id())
  WITH CHECK (auth.is_agent() AND agent_id = auth.agent_id() AND auth.has_brokerage_access(brokerage_id));

-- Team Leader: join agents -> users for correct team resolution
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

-- ─────────────────────────────────────────────────────────────────────────────
-- VERIFICATION COMMENT
-- ─────────────────────────────────────────────────────────────────────────────
-- After applying this migration, an authenticated agent should be able to:
--   SELECT * FROM contacts WHERE agent_id = auth.agent_id()  → their records
--   SELECT * FROM listings WHERE agent_id = auth.agent_id()  → their listings
--   SELECT * FROM transactions WHERE agent_id = auth.agent_id() → their deals
-- Previously all of these returned 0 rows because auth.uid() ≠ agents.id
-- =====================================================
