-- =====================================================
-- RLS GOVERNANCE: HELPER FUNCTIONS
-- =====================================================
-- These functions provide consistent access checks across all RLS policies.
-- They reference user_type as the authoritative permission field.
-- =====================================================

-- Get current user's user_type
CREATE OR REPLACE FUNCTION auth.user_type()
RETURNS TEXT AS $$
  SELECT user_type
  FROM users
  WHERE id = auth.uid();
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Get current user's brokerage_id
CREATE OR REPLACE FUNCTION auth.user_brokerage_id()
RETURNS UUID AS $$
  SELECT brokerage_id::uuid
  FROM users
  WHERE id = auth.uid();
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Check if user is admin
CREATE OR REPLACE FUNCTION auth.is_admin()
RETURNS BOOLEAN AS $$
  SELECT user_type = 'admin'
  FROM users
  WHERE id = auth.uid();
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Check if user is broker
CREATE OR REPLACE FUNCTION auth.is_broker()
RETURNS BOOLEAN AS $$
  SELECT user_type = 'broker'
  FROM users
  WHERE id = auth.uid();
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Check if user is agent
CREATE OR REPLACE FUNCTION auth.is_agent()
RETURNS BOOLEAN AS $$
  SELECT user_type = 'agent'
  FROM users
  WHERE id = auth.uid();
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Check if user is team_leader
CREATE OR REPLACE FUNCTION auth.is_team_leader()
RETURNS BOOLEAN AS $$
  SELECT user_type = 'team_leader'
  FROM users
  WHERE id = auth.uid();
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Check if user is transaction_coordinator
CREATE OR REPLACE FUNCTION auth.is_tc()
RETURNS BOOLEAN AS $$
  SELECT user_type = 'transaction_coordinator'
  FROM users
  WHERE id = auth.uid();
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Check if user is compliance_manager
CREATE OR REPLACE FUNCTION auth.is_compliance_manager()
RETURNS BOOLEAN AS $$
  SELECT user_type = 'compliance_manager'
  FROM users
  WHERE id = auth.uid();
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Check if user is vendor
CREATE OR REPLACE FUNCTION auth.is_vendor()
RETURNS BOOLEAN AS $$
  SELECT user_type = 'vendor'
  FROM users
  WHERE id = auth.uid();
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Check if user is lender
CREATE OR REPLACE FUNCTION auth.is_lender()
RETURNS BOOLEAN AS $$
  SELECT user_type = 'lender'
  FROM users
  WHERE id = auth.uid();
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Check if user is title_agent
CREATE OR REPLACE FUNCTION auth.is_title_agent()
RETURNS BOOLEAN AS $$
  SELECT user_type = 'title_agent'
  FROM users
  WHERE id = auth.uid();
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Check if user is contact (end client)
CREATE OR REPLACE FUNCTION auth.is_contact()
RETURNS BOOLEAN AS $$
  SELECT user_type = 'contact'
  FROM users
  WHERE id = auth.uid();
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Check if user has access to specific brokerage
CREATE OR REPLACE FUNCTION auth.has_brokerage_access(target_brokerage_id UUID)
RETURNS BOOLEAN AS $$
  SELECT 
    auth.is_admin() OR -- Admins bypass brokerage isolation
    auth.user_brokerage_id() = target_brokerage_id; -- Same brokerage
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Get user's team_id
CREATE OR REPLACE FUNCTION auth.user_team_id()
RETURNS UUID AS $$
  SELECT team_id
  FROM users
  WHERE id = auth.uid();
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Check if user is on specific team
CREATE OR REPLACE FUNCTION auth.is_on_team(target_team_id UUID)
RETURNS BOOLEAN AS $$
  SELECT team_id = target_team_id
  FROM users
  WHERE id = auth.uid();
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Check if user is assigned to a transaction (via deal_team_members)
CREATE OR REPLACE FUNCTION auth.is_on_deal_team(transaction_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM deal_team_members dtm
    JOIN users u ON u.email = dtm.email
    WHERE dtm.transaction_id = $1
    AND u.id = auth.uid()
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Resolves the current user's agents.id from the agents table.
-- Returns NULL if the user has no agent profile.
-- This is the canonical way to resolve agents.id from auth.uid() (= users.id).
CREATE OR REPLACE FUNCTION auth.agent_id()
RETURNS UUID AS $$
  SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1;
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Checks if the given agent_id belongs to the current authenticated user.
-- Safe: returns false (not error) if no agent profile exists.
CREATE OR REPLACE FUNCTION auth.is_own_agent_id(agent_id_to_check UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM agents
    WHERE id = agent_id_to_check
    AND user_id = auth.uid()
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Check if user is agent assigned to a contact
-- FIX: contacts.agent_id stores agents.id (not users.id), so use auth.agent_id()
CREATE OR REPLACE FUNCTION auth.owns_contact(contact_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM contacts
    WHERE id = $1
    AND agent_id = auth.agent_id()
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Check if user is agent assigned to a transaction
-- FIX: transactions.agent_id stores agents.id (not users.id), so use auth.agent_id()
CREATE OR REPLACE FUNCTION auth.owns_transaction(transaction_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM transactions
    WHERE id = $1
    AND (
      agent_id = auth.agent_id() OR
      seller_agent_id = auth.agent_id() OR
      buyer_agent_id = auth.agent_id()
    )
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Check if user is agent assigned to a listing
-- FIX: listings.agent_id stores agents.id (not users.id), so use auth.agent_id()
CREATE OR REPLACE FUNCTION auth.owns_listing(listing_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1
    FROM listings
    WHERE id = $1
    AND agent_id = auth.agent_id()
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Check if user is the contact themselves (for self-visibility)
-- FIX: use contact_user_id FK instead of email JOIN (email is case-sensitive and unreliable)
CREATE OR REPLACE FUNCTION auth.is_self_contact(contact_id UUID)
RETURNS BOOLEAN AS $$
  SELECT EXISTS (
    SELECT 1 FROM contacts
    WHERE id = $1
    AND contact_user_id = auth.uid()
  );
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Get contact_id for current user (if they are a contact)
-- FIX: use contact_user_id FK instead of email JOIN
CREATE OR REPLACE FUNCTION auth.user_contact_id()
RETURNS UUID AS $$
  SELECT id FROM contacts
  WHERE contact_user_id = auth.uid()
  LIMIT 1;
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- =====================================================
-- GRANT EXECUTE TO AUTHENTICATED USERS
-- =====================================================

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO authenticated;
