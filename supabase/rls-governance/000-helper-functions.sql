-- =====================================================
-- RLS GOVERNANCE: HELPER FUNCTIONS
-- =====================================================
-- These functions provide consistent access checks across all RLS policies.
-- They reference user_type as the authoritative permission field.
--
-- IMPORTANT: These functions must be applied via the Supabase Dashboard
-- SQL editor (superuser required). They cannot be applied via the project
-- database URL (connection string) due to auth schema restrictions.
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
  SELECT user_type IN ('admin', 'super_admin')
  FROM users
  WHERE id = auth.uid();
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Check if user is broker
CREATE OR REPLACE FUNCTION auth.is_broker()
RETURNS BOOLEAN AS $$
  SELECT user_type IN ('broker', 'broker_owner')
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

-- ─── THE SPELLINGS BELOW WERE THE SOURCE OF A SCHEMA-WIDE DEFECT (m440) ──────
--
-- None of these auth.* functions has ever been installed on the database — this
-- file's own header says it needs a dashboard superuser, and it was never run.
-- What WAS run is scripts/111-fix-agent-id-rls-policies.sql, which inlines these
-- BODIES into real policies. So the three single-value spellings below travelled
-- into live RLS on `contacts`, `listings` and `transactions` — and every one of
-- them names a user_type that users_user_type_check CANNOT store, which made
-- those policies false for every user who will ever exist.
--
-- The live vocabulary is: admin, agent, broker, broker_owner, compliance_officer,
-- contact, isa, lender, superadmin, support, system, tc, team_lead, vendor.
-- lib/security/types.ts LEGACY_ROLE_MAP is the repository's mapping from the old
-- spellings onto it. Each roster below is now POSITIVE and names both, exactly as
-- the built public.is_team_lead_role() / public.is_compliance_officer_role() /
-- public.is_tc_role() do — a dead literal beside a live one widens a roster to
-- nobody, which is harmless; a dead literal alone IS the roster, which is not.
--
-- Prefer the public.* helpers in new policies. These exist so this file's own
-- policy sets are not written against a vocabulary the database rejects.

-- Check if user is a team lead ('team_leader' is the legacy spelling)
CREATE OR REPLACE FUNCTION auth.is_team_leader()
RETURNS BOOLEAN AS $$
  SELECT user_type IN ('team_lead', 'team_leader')
  FROM users
  WHERE id = auth.uid();
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Check if user is a transaction coordinator ('transaction_coordinator' is the
-- legacy spelling; the stored value is 'tc')
CREATE OR REPLACE FUNCTION auth.is_tc()
RETURNS BOOLEAN AS $$
  SELECT user_type IN ('tc', 'transaction_coordinator', 'coordinator')
  FROM users
  WHERE id = auth.uid();
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- Check if user is a compliance officer ('compliance_manager' is the legacy
-- spelling; the stored value is 'compliance_officer')
CREATE OR REPLACE FUNCTION auth.is_compliance_manager()
RETURNS BOOLEAN AS $$
  SELECT user_type IN ('compliance_officer', 'compliance_manager')
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

-- Check if user is title_agent.
-- WARNING: 'title_agent' was REMOVED from users.user_type by m307 and
-- users_user_type_check will not store it, so this function is FALSE for every
-- user who will ever exist. A title company is a VENDOR here — vendors.category
-- includes 'title', and the live title account carries user_type = 'vendor'.
-- m438 and m440 dropped the five policies that gated on this; do not write a
-- sixth. Kept only so this file still parses against older policy sets.
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
-- ROOT FIX: contacts/transactions/listings.*agent_id stores agents.id, NOT users.id.
-- Old code compared agent_id = auth.uid() which always returned false for agents.
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
-- contact_user_id was added in migration 111 (scripts/111-fix-agent-id-rls-policies.sql)
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

-- Get agent.id for the current user (agents.id ≠ users.id)
-- contacts.agent_id / transactions.agent_id store agents.id, not users.id.
-- Always use this instead of auth.uid() when comparing against agent_id columns.
CREATE OR REPLACE FUNCTION auth.agent_id()
RETURNS UUID AS $$
  SELECT id FROM agents WHERE user_id = auth.uid() LIMIT 1;
$$ LANGUAGE SQL SECURITY DEFINER STABLE;

-- =====================================================
-- GRANT EXECUTE TO AUTHENTICATED USERS
-- =====================================================

GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA auth TO authenticated;
