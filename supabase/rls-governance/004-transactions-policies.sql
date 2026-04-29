-- =====================================================
-- RLS GOVERNANCE: TRANSACTIONS TABLE POLICIES
-- =====================================================
-- Purpose: Control access to transaction records
-- Tables: transactions, transaction_milestones, offers, commission_calculations
-- Key Rules:
-- - TCs have full access to transactions in their brokerage
-- - Compliance managers have read-only access
-- - Contacts see their own transactions (transparency)
-- - External parties see only assigned transactions
--
-- NOTE: Live DB uses "agent_commissions" (not "commissions").
-- commission_calculations references transactions.agent_id (= agents.id).
-- =====================================================

-- Enable RLS
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_calculations ENABLE ROW LEVEL SECURITY;

-- Drop existing policies that conflict
DROP POLICY IF EXISTS "Users can view their transactions" ON transactions;
DROP POLICY IF EXISTS "users_view_own_transactions" ON transactions;
DROP POLICY IF EXISTS "users_insert_transactions" ON transactions;
DROP POLICY IF EXISTS "users_update_own_transactions" ON transactions;
DROP POLICY IF EXISTS "admins_view_all_transactions" ON transactions;

-- =====================================================
-- TRANSACTIONS TABLE: SELECT POLICIES
-- =====================================================

-- Admin: Read all transactions
CREATE POLICY "admin_read_all_transactions"
  ON transactions FOR SELECT
  USING (auth.is_admin());

-- Broker: Read all transactions in their brokerage
CREATE POLICY "broker_read_brokerage_transactions"
  ON transactions FOR SELECT
  USING (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- TC: Read all transactions in their brokerage
CREATE POLICY "tc_read_brokerage_transactions"
  ON transactions FOR SELECT
  USING (
    auth.is_tc()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- Compliance Manager: Read all transactions in their brokerage
CREATE POLICY "compliance_read_brokerage_transactions"
  ON transactions FOR SELECT
  USING (
    auth.is_compliance_manager()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- Agent: Read own transactions
-- FIX: transactions.*agent_id stores agents.id (not users.id) — use auth.agent_id()
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

-- Team Leader: Read team transactions
-- FIX: *agent_id stores agents.id; must join agents -> users to resolve team membership
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

-- Contact: Read ONLY their own transactions (transparency)
CREATE POLICY "contact_read_own_transactions"
  ON transactions FOR SELECT
  USING (
    auth.is_contact()
    AND contact_id = auth.user_contact_id()
  );

-- Vendor/Lender/Title: Read only transactions they're assigned to
CREATE POLICY "external_read_assigned_transactions"
  ON transactions FOR SELECT
  USING (
    (auth.is_vendor() OR auth.is_lender() OR auth.is_title_agent())
    AND auth.is_on_deal_team(id)
  );

-- =====================================================
-- TRANSACTIONS TABLE: INSERT POLICIES
-- =====================================================

-- Admin: Insert any transaction
CREATE POLICY "admin_insert_transactions"
  ON transactions FOR INSERT
  WITH CHECK (auth.is_admin());

-- Broker: Insert transactions in their brokerage
CREATE POLICY "broker_insert_transactions"
  ON transactions FOR INSERT
  WITH CHECK (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- Agent: Insert transactions in their brokerage (where they're the agent)
-- FIX: *agent_id stores agents.id — use auth.agent_id()
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

-- TC: Insert transactions in their brokerage
CREATE POLICY "tc_insert_transactions"
  ON transactions FOR INSERT
  WITH CHECK (
    auth.is_tc()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- =====================================================
-- TRANSACTIONS TABLE: UPDATE POLICIES
-- =====================================================

-- Admin: Update any transaction
CREATE POLICY "admin_update_transactions"
  ON transactions FOR UPDATE
  USING (auth.is_admin());

-- Broker: Update transactions in their brokerage
CREATE POLICY "broker_update_brokerage_transactions"
  ON transactions FOR UPDATE
  USING (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- TC: Update transactions in their brokerage
CREATE POLICY "tc_update_brokerage_transactions"
  ON transactions FOR UPDATE
  USING (
    auth.is_tc()
    AND auth.has_brokerage_access(brokerage_id)
  );

-- Agent: Update own transactions
-- FIX: *agent_id stores agents.id — use auth.agent_id()
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

-- Contacts: CANNOT update transactions (read-only transparency)

-- =====================================================
-- TRANSACTIONS TABLE: DELETE POLICIES
-- =====================================================

-- Only Admin can delete transactions
CREATE POLICY "admin_delete_transactions"
  ON transactions FOR DELETE
  USING (auth.is_admin());

-- =====================================================
-- TRANSACTION_MILESTONES TABLE POLICIES
-- =====================================================

-- TCs can fully manage milestones
CREATE POLICY "tc_manage_milestones"
  ON transaction_milestones FOR ALL
  USING (
    auth.is_tc()
    AND transaction_id IN (
      SELECT id FROM transactions WHERE brokerage_id = auth.user_brokerage_id()
    )
  );

-- Agents can manage milestones for their transactions
CREATE POLICY "agent_manage_own_milestones"
  ON transaction_milestones FOR ALL
  USING (
    auth.is_agent()
    AND auth.owns_transaction(transaction_id)
  );

-- Brokers can manage all milestones in their brokerage
CREATE POLICY "broker_manage_milestones"
  ON transaction_milestones FOR ALL
  USING (
    auth.is_broker()
    AND transaction_id IN (
      SELECT id FROM transactions WHERE brokerage_id = auth.user_brokerage_id()
    )
  );

-- Contacts can read milestones for their transactions (transparency)
CREATE POLICY "contact_read_own_milestones"
  ON transaction_milestones FOR SELECT
  USING (
    auth.is_contact()
    AND transaction_id IN (
      SELECT id FROM transactions WHERE contact_id = auth.user_contact_id()
    )
  );

-- =====================================================
-- OFFERS TABLE POLICIES
-- =====================================================

-- Agents can manage offers for their transactions
-- FIX: agent_id stores agents.id — use auth.agent_id()
CREATE POLICY "agent_manage_offers"
  ON offers FOR ALL
  USING (
    auth.is_agent()
    AND (
      transaction_id IN (SELECT id FROM transactions WHERE agent_id = auth.agent_id()) OR
      listing_id IN (SELECT id FROM listings WHERE agent_id = auth.agent_id())
    )
  );

-- Brokers can manage all offers in their brokerage
CREATE POLICY "broker_manage_offers"
  ON offers FOR ALL
  USING (
    auth.is_broker()
    AND (
      transaction_id IN (SELECT id FROM transactions WHERE brokerage_id = auth.user_brokerage_id()) OR
      listing_id IN (SELECT id FROM listings WHERE brokerage_id = auth.user_brokerage_id())
    )
  );

-- TCs can manage offers
CREATE POLICY "tc_manage_offers"
  ON offers FOR ALL
  USING (
    auth.is_tc()
    AND transaction_id IN (
      SELECT id FROM transactions WHERE brokerage_id = auth.user_brokerage_id()
    )
  );

-- Contacts can read offers related to their transactions (transparency)
CREATE POLICY "contact_read_own_offers"
  ON offers FOR SELECT
  USING (
    auth.is_contact()
    AND contact_id = auth.user_contact_id()
  );

-- =====================================================
-- COMMISSION_CALCULATIONS TABLE POLICIES
-- =====================================================
-- NOTE: Live DB table is "agent_commissions" (not "commissions").
-- commission_calculations is a separate calculations/breakdown table.
-- FIX: transactions.agent_id stores agents.id — use auth.agent_id()

CREATE POLICY "agent_read_own_commission_calculations"
  ON commission_calculations FOR SELECT
  USING (
    auth.is_agent()
    AND transaction_id IN (
      SELECT id FROM transactions WHERE agent_id = auth.agent_id()
    )
  );

CREATE POLICY "broker_manage_commission_calculations"
  ON commission_calculations FOR ALL
  USING (
    auth.is_broker()
    AND transaction_id IN (
      SELECT id FROM transactions WHERE brokerage_id = auth.user_brokerage_id()
    )
  );

CREATE POLICY "admin_manage_commission_calculations"
  ON commission_calculations FOR ALL
  USING (auth.is_admin());

-- =====================================================
-- COMMENTS
-- =====================================================
-- WHY these policies exist:
-- 1. TCs have full transaction access (their core job function)
-- 2. Compliance managers have read-only access for auditing
-- 3. Contacts see their transactions but NOT internal notes/commissions
-- 4. Agents own their transactions; team leaders see team deals
-- 5. External parties (lenders, title agents) see only assigned deals
-- 6. Milestones are managed by TCs and agents
-- 7. Live DB uses "agent_commissions" table (not "commissions")
--    commission_calculations is the calculations breakdown table
-- 8. Contacts have transparency but cannot modify transaction truth
-- 9. *_agent_id columns store agents.id (not users.id) — always use auth.agent_id()
-- =====================================================
