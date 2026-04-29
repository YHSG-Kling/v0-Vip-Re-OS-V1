-- =====================================================
-- MIGRATION 014: Fix agent_id RLS Mismatch
-- =====================================================
-- ROOT CAUSE: contacts.agent_id / transactions.agent_id store agents.id
-- (gen_random_uuid from the agents table) but old policies compared
-- against auth.uid() which returns users.id — a different UUID.
-- This migration fixes every policy and helper function that made that
-- incorrect comparison, replacing them with auth.agent_id() which
-- does the correct users.id → agents.id lookup.
-- =====================================================

-- ─── FIX: auth.owns_contact() ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION auth.owns_contact(contact_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM contacts
    WHERE id = $1
    AND agent_id = auth.agent_id()
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- ─── FIX: auth.owns_transaction() ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION auth.owns_transaction(transaction_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM transactions
    WHERE id = $1
    AND (
      agent_id        = auth.agent_id() OR
      seller_agent_id = auth.agent_id() OR
      buyer_agent_id  = auth.agent_id()
    )
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- ─── FIX: auth.owns_listing() ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION auth.owns_listing(listing_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM listings
    WHERE id = $1
    AND agent_id = auth.agent_id()
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- ─── FIX CONTACTS POLICIES ────────────────────────────────────────────────

DROP POLICY IF EXISTS "agent_read_own_contacts"   ON contacts;
DROP POLICY IF EXISTS "agent_insert_own_contacts" ON contacts;
DROP POLICY IF EXISTS "agent_update_own_contacts" ON contacts;
DROP POLICY IF EXISTS "team_leader_read_team_contacts" ON contacts;

-- Agent: read own + shared contacts
CREATE POLICY "agent_read_own_contacts"
  ON contacts FOR SELECT
  USING (
    auth.is_agent()
    AND (
      agent_id = auth.agent_id() OR
      auth.uid() = ANY(COALESCE(shared_with_user_ids, ARRAY[]::UUID[]))
    )
  );

-- Agent: insert contacts assigned to themselves
CREATE POLICY "agent_insert_own_contacts"
  ON contacts FOR INSERT
  WITH CHECK (
    auth.is_agent()
    AND auth.has_brokerage_access(brokerage_id)
    AND (agent_id = auth.agent_id() OR agent_id IS NULL)
  );

-- Agent: update own contacts
CREATE POLICY "agent_update_own_contacts"
  ON contacts FOR UPDATE
  USING (
    auth.is_agent()
    AND agent_id = auth.agent_id()
  );

-- Team leader: read contacts assigned to their team members
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

-- ─── FIX TRANSACTIONS POLICIES ────────────────────────────────────────────
-- Drop the broken policies that used auth.uid() against agent_id columns.

DROP POLICY IF EXISTS "agent_read_own_transactions"   ON transactions;
DROP POLICY IF EXISTS "agent_update_own_transactions" ON transactions;
DROP POLICY IF EXISTS "agent_insert_transactions"     ON transactions;
DROP POLICY IF EXISTS "team_leader_read_team_transactions" ON transactions;

-- Agent: read transactions where they are any agent party
CREATE POLICY "agent_read_own_transactions"
  ON transactions FOR SELECT
  USING (
    auth.is_agent()
    AND (
      agent_id        = auth.agent_id() OR
      seller_agent_id = auth.agent_id() OR
      buyer_agent_id  = auth.agent_id()
    )
  );

-- Agent: update own transactions
CREATE POLICY "agent_update_own_transactions"
  ON transactions FOR UPDATE
  USING (
    auth.is_agent()
    AND (
      agent_id        = auth.agent_id() OR
      seller_agent_id = auth.agent_id() OR
      buyer_agent_id  = auth.agent_id()
    )
  );

-- Agent: insert transactions for their brokerage
CREATE POLICY "agent_insert_transactions"
  ON transactions FOR INSERT
  WITH CHECK (
    auth.is_agent()
    AND auth.has_brokerage_access(brokerage_id)
    AND agent_id = auth.agent_id()
  );

-- Team leader: read team transactions
CREATE POLICY "team_leader_read_team_transactions"
  ON transactions FOR SELECT
  USING (
    auth.is_team_leader()
    AND (
      agent_id IN (
        SELECT a.id FROM agents a JOIN users u ON a.user_id = u.id
        WHERE u.team_id = auth.user_team_id()
      ) OR
      seller_agent_id IN (
        SELECT a.id FROM agents a JOIN users u ON a.user_id = u.id
        WHERE u.team_id = auth.user_team_id()
      ) OR
      buyer_agent_id IN (
        SELECT a.id FROM agents a JOIN users u ON a.user_id = u.id
        WHERE u.team_id = auth.user_team_id()
      )
    )
  );

GRANT EXECUTE ON FUNCTION auth.agent_id() TO authenticated;
GRANT EXECUTE ON FUNCTION auth.owns_contact(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION auth.owns_transaction(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION auth.owns_listing(UUID) TO authenticated;
