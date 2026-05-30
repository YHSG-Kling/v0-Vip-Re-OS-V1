-- =====================================================
-- RLS GOVERNANCE: CONTACTS TABLE POLICIES
-- =====================================================
-- Purpose: Control access to contact records
-- Tables: contacts
-- Key Rule: contact_persona is UX-only, user_type determines permissions
--
-- NOTE: property_interests, credit_status, interaction_history tables
-- do not have RLS enabled in the live DB (0 policies). These are managed
-- via brokerage-level access controls at the application layer only.
-- =====================================================

-- Enable RLS
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they conflict
DROP POLICY IF EXISTS "Users can view their contacts" ON contacts;
DROP POLICY IF EXISTS "users_view_own_contacts" ON contacts;
DROP POLICY IF EXISTS "users_insert_contacts" ON contacts;
DROP POLICY IF EXISTS "users_update_own_contacts" ON contacts;
DROP POLICY IF EXISTS "users_delete_own_contacts" ON contacts;
DROP POLICY IF EXISTS "admins_view_all_contacts" ON contacts;
DROP POLICY IF EXISTS "brokers_view_team_contacts" ON contacts;

-- =====================================================
-- CONTACTS TABLE: SELECT POLICIES
-- =====================================================

-- Admin: Read all contacts across all brokerages
CREATE POLICY "admin_read_all_contacts"
  ON contacts FOR SELECT
  USING (auth.is_admin());

-- Broker: Read all contacts in their brokerage
CREATE POLICY "broker_read_brokerage_contacts"
  ON contacts FOR SELECT
  USING (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- Compliance Manager: Read all contacts in their brokerage (audit purposes)
CREATE POLICY "compliance_read_brokerage_contacts"
  ON contacts FOR SELECT
  USING (
    auth.is_compliance_manager()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- TC: Read contacts in their brokerage (for transaction coordination)
CREATE POLICY "tc_read_brokerage_contacts"
  ON contacts FOR SELECT
  USING (
    auth.is_tc()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- Team Leader: Read contacts assigned to their team
-- FIX: contacts.agent_id stores agents.id; must join agents -> users to resolve team membership
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

-- Agent: Read own contacts
-- FIX: contacts.agent_id stores agents.id (not users.id) — use auth.agent_id()
CREATE POLICY "agent_read_own_contacts"
  ON contacts FOR SELECT
  USING (
    auth.is_agent()
    AND agent_id = auth.agent_id()
  );

-- Contact (self): Read ONLY their own contact record
-- FIX: uses contact_user_id FK (added in migration 111) instead of email JOIN
CREATE POLICY "contact_read_self"
  ON contacts FOR SELECT
  USING (
    auth.is_contact()
    AND auth.is_self_contact(id)
  );

-- =====================================================
-- CONTACTS TABLE: INSERT POLICIES
-- =====================================================

-- Admin: Insert any contact
CREATE POLICY "admin_insert_contacts"
  ON contacts FOR INSERT
  WITH CHECK (auth.is_admin());

-- Broker: Insert contacts in their brokerage
CREATE POLICY "broker_insert_contacts"
  ON contacts FOR INSERT
  WITH CHECK (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- Agent: Insert contacts in their brokerage (assigned to themselves)
-- FIX: agent_id stores agents.id — use auth.agent_id()
CREATE POLICY "agent_insert_own_contacts"
  ON contacts FOR INSERT
  WITH CHECK (
    auth.is_agent()
    AND auth.has_brokerage_access(brokerage_id)
    AND (agent_id = auth.agent_id() OR agent_id IS NULL)
  );

-- =====================================================
-- CONTACTS TABLE: UPDATE POLICIES
-- =====================================================

-- Admin: Update any contact
CREATE POLICY "admin_update_contacts"
  ON contacts FOR UPDATE
  USING (auth.is_admin());

-- Broker: Update contacts in their brokerage
CREATE POLICY "broker_update_brokerage_contacts"
  ON contacts FOR UPDATE
  USING (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- Agent: Update own contacts
-- FIX: agent_id stores agents.id — use auth.agent_id()
CREATE POLICY "agent_update_own_contacts"
  ON contacts FOR UPDATE
  USING (
    auth.is_agent()
    AND agent_id = auth.agent_id()
  );

-- TC: Update contact communication details for active transactions
CREATE POLICY "tc_update_contact_communication"
  ON contacts FOR UPDATE
  USING (
    auth.is_tc()
    AND auth.has_brokerage_access(brokerage_id)
    AND id IN (
      SELECT contact_id FROM transactions 
      WHERE brokerage_id = auth.user_brokerage_id()
      AND status NOT IN ('closed', 'cancelled')
    )
  )
  WITH CHECK (
    -- TC can only update communication fields, not ownership
    agent_id = (SELECT agent_id FROM contacts WHERE id = contacts.id)
  );

-- Contact (self): Update LIMITED fields on their own record
CREATE POLICY "contact_update_self_limited"
  ON contacts FOR UPDATE
  USING (
    auth.is_contact()
    AND auth.is_self_contact(id)
  )
  WITH CHECK (
    -- Contact can only update: phone, email, notes (not status, agent, etc.)
    agent_id = (SELECT agent_id FROM contacts WHERE id = contacts.id)
    AND brokerage_id = (SELECT brokerage_id FROM contacts WHERE id = contacts.id)
    AND status = (SELECT status FROM contacts WHERE id = contacts.id)
  );

-- =====================================================
-- CONTACTS TABLE: DELETE POLICIES
-- =====================================================

-- Admin: Delete any contact
CREATE POLICY "admin_delete_contacts"
  ON contacts FOR DELETE
  USING (auth.is_admin());

-- Broker: Delete contacts in their brokerage
-- Note: Actual DELETE should be restricted; prefer using deleted_at field
CREATE POLICY "broker_delete_brokerage_contacts"
  ON contacts FOR DELETE
  USING (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- =====================================================
-- COMMENTS
-- =====================================================
-- WHY these policies exist:
-- 1. contact_persona has ZERO impact on permissions (UX only)
-- 2. Contacts can read their own record for transparency (via contact_user_id FK)
-- 3. Contacts CANNOT see internal notes, scoring, or credit data
-- 4. Agents own their contacts; team leaders see team data
-- 5. TCs have read access to brokerage contacts + limited update for active txns
-- 6. Brokers have full brokerage visibility
-- 7. contacts.agent_id stores agents.id (not users.id) — always use auth.agent_id()
-- 8. contact_user_id FK (added in migration 111) links contacts to auth users
-- 9. property_interests, credit_status, interaction_history: no RLS in live DB
--    (application-layer access control only)
-- =====================================================
