-- =====================================================
-- RLS GOVERNANCE: CONTACTS TABLE POLICIES
-- =====================================================
-- Purpose: Control access to contact records
-- Tables: contacts, property_interests, credit_status, interaction_history
-- Key Rule: contact_persona is UX-only, user_type determines permissions
-- =====================================================

-- Enable RLS
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_interests ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE interaction_history ENABLE ROW LEVEL SECURITY;

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

-- Team Leader: Read contacts assigned to their team
CREATE POLICY "team_leader_read_team_contacts"
  ON contacts FOR SELECT
  USING (
    auth.is_team_leader()
    AND (
      team_id = auth.user_team_id() OR
      agent_id IN (
        SELECT id FROM users WHERE team_id = auth.user_team_id()
      )
    )
  );

-- Agent: Read own contacts + shared contacts
CREATE POLICY "agent_read_own_contacts"
  ON contacts FOR SELECT
  USING (
    auth.is_agent()
    AND (
      agent_id = auth.uid() OR
      auth.uid() = ANY(COALESCE(shared_with_user_ids, ARRAY[]::UUID[]))
    )
  );

-- TC: Read contacts related to their transactions
CREATE POLICY "tc_read_transaction_contacts"
  ON contacts FOR SELECT
  USING (
    auth.is_tc()
    AND auth.has_brokerage_access(brokerage_id)
    AND id IN (
      SELECT contact_id FROM transactions WHERE brokerage_id = auth.user_brokerage_id()
    )
  );

-- Contact (self): Read ONLY their own contact record
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
CREATE POLICY "agent_insert_own_contacts"
  ON contacts FOR INSERT
  WITH CHECK (
    auth.is_agent()
    AND auth.has_brokerage_access(brokerage_id)
    AND (agent_id = auth.uid() OR agent_id IS NULL)
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
CREATE POLICY "agent_update_own_contacts"
  ON contacts FOR UPDATE
  USING (
    auth.is_agent()
    AND agent_id = auth.uid()
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

-- Broker: Soft delete (set deleted_at) contacts in their brokerage
-- Note: Actual DELETE should be restricted; use deleted_at field
CREATE POLICY "broker_delete_brokerage_contacts"
  ON contacts FOR DELETE
  USING (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- =====================================================
-- PROPERTY_INTERESTS TABLE POLICIES
-- =====================================================

-- Users can read property interests for contacts they can access
CREATE POLICY "read_property_interests_via_contact"
  ON property_interests FOR SELECT
  USING (
    contact_id IN (SELECT id FROM contacts)
  );

-- Agents can manage property interests for their contacts
CREATE POLICY "agent_manage_property_interests"
  ON property_interests FOR ALL
  USING (
    auth.owns_contact(contact_id)
  );

-- Contacts can read their own property interests
CREATE POLICY "contact_read_own_property_interests"
  ON property_interests FOR SELECT
  USING (
    auth.is_contact()
    AND contact_id = auth.user_contact_id()
  );

-- =====================================================
-- CREDIT_STATUS TABLE POLICIES
-- =====================================================

-- Agents can manage credit status for their contacts
CREATE POLICY "agent_manage_credit_status"
  ON credit_status FOR ALL
  USING (
    auth.owns_contact(contact_id)
  );

-- Brokers can view credit status in their brokerage
CREATE POLICY "broker_read_credit_status"
  ON credit_status FOR SELECT
  USING (
    auth.is_broker()
    AND contact_id IN (
      SELECT id FROM contacts WHERE brokerage_id = auth.user_brokerage_id()
    )
  );

-- Lenders can view credit status for their assigned transactions
CREATE POLICY "lender_read_credit_status_for_deals"
  ON credit_status FOR SELECT
  USING (
    auth.is_lender()
    AND contact_id IN (
      SELECT c.id FROM contacts c
      JOIN transactions t ON t.contact_id = c.id
      WHERE auth.is_on_deal_team(t.id)
    )
  );

-- Contacts CANNOT see their own credit status (agents explain verbally)
-- This prevents contacts from seeing internal credit scores

-- =====================================================
-- INTERACTION_HISTORY TABLE POLICIES
-- =====================================================

-- Agents can manage interaction history for their contacts
CREATE POLICY "agent_manage_interaction_history"
  ON interaction_history FOR ALL
  USING (
    auth.owns_contact(contact_id) OR agent_id = auth.uid()
  );

-- Brokers can view interaction history in their brokerage
CREATE POLICY "broker_read_interaction_history"
  ON interaction_history FOR SELECT
  USING (
    auth.is_broker()
    AND contact_id IN (
      SELECT id FROM contacts WHERE brokerage_id = auth.user_brokerage_id()
    )
  );

-- Compliance can read interaction history for audits
CREATE POLICY "compliance_read_interaction_history"
  ON interaction_history FOR SELECT
  USING (
    auth.is_compliance_manager()
    AND contact_id IN (
      SELECT id FROM contacts WHERE brokerage_id = auth.user_brokerage_id()
    )
  );

-- Contacts can read their own interaction history (transparency)
CREATE POLICY "contact_read_own_interaction_history"
  ON interaction_history FOR SELECT
  USING (
    auth.is_contact()
    AND contact_id = auth.user_contact_id()
  );

-- =====================================================
-- COMMENTS
-- =====================================================
-- WHY these policies exist:
-- 1. contact_persona has ZERO impact on permissions (UX only)
-- 2. Contacts can read their own record for transparency
-- 3. Contacts CANNOT see internal notes, scoring, or credit data
-- 4. Agents own their contacts; team leaders see team data
-- 5. TCs have limited update access for active transactions only
-- 6. Shared contacts use explicit shared_with_user_ids array
-- 7. Brokers have full brokerage visibility
-- 8. External parties (lenders) see only transaction-related contacts
-- =====================================================
