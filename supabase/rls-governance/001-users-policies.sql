-- =====================================================
-- RLS GOVERNANCE: USERS TABLE POLICIES
-- =====================================================
-- Purpose: Control access to user records
-- Tables: users, user_profiles, user_activity
-- =====================================================

-- Enable RLS
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_activity ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can view own data" ON users;
DROP POLICY IF EXISTS "admin_read_all_users" ON users;
DROP POLICY IF EXISTS "broker_read_brokerage_users" ON users;
DROP POLICY IF EXISTS "agent_read_own_user" ON users;
DROP POLICY IF EXISTS "contact_read_own_user" ON users;
DROP POLICY IF EXISTS "admin_update_users" ON users;
DROP POLICY IF EXISTS "user_update_own_profile" ON users;

-- =====================================================
-- USERS TABLE: SELECT POLICIES
-- =====================================================

-- Admin: Read all users across all brokerages
CREATE POLICY "admin_read_all_users"
  ON users FOR SELECT
  USING (auth.is_admin());

-- Broker: Read all users in their brokerage
CREATE POLICY "broker_read_brokerage_users"
  ON users FOR SELECT
  USING (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id::uuid)
  );

-- Agent/TC/Compliance: Read users in their brokerage
CREATE POLICY "staff_read_brokerage_users"
  ON users FOR SELECT
  USING (
    (auth.is_agent() OR auth.is_tc() OR auth.is_compliance_manager() OR auth.is_team_leader())
    AND auth.has_brokerage_access(brokerage_id::uuid)
  );

-- Contact: Read only their own user record
CREATE POLICY "contact_read_own_user"
  ON users FOR SELECT
  USING (
    auth.is_contact()
    AND id = auth.uid()
  );

-- Vendor/Lender/Title: Read only their own user record
CREATE POLICY "external_read_own_user"
  ON users FOR SELECT
  USING (
    (auth.is_vendor() OR auth.is_lender() OR auth.is_title_agent())
    AND id = auth.uid()
  );

-- =====================================================
-- USERS TABLE: UPDATE POLICIES
-- =====================================================

-- Admin: Update any user
CREATE POLICY "admin_update_users"
  ON users FOR UPDATE
  USING (auth.is_admin());

-- Broker: Update users in their brokerage (except other brokers)
CREATE POLICY "broker_update_brokerage_users"
  ON users FOR UPDATE
  USING (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id::uuid)
    AND user_type != 'broker' -- Cannot modify other brokers
    AND user_type != 'admin' -- Cannot modify admins
  );

-- Any user: Update their own profile fields (name, phone, avatar)
CREATE POLICY "user_update_own_profile"
  ON users FOR UPDATE
  USING (id = auth.uid())
  WITH CHECK (
    id = auth.uid()
    -- Prevent changing critical fields
    AND user_type = (SELECT user_type FROM users WHERE id = auth.uid())
    AND brokerage_id = (SELECT brokerage_id FROM users WHERE id = auth.uid())
  );

-- =====================================================
-- USERS TABLE: INSERT POLICIES
-- =====================================================

-- Admin: Insert any user
CREATE POLICY "admin_insert_users"
  ON users FOR INSERT
  WITH CHECK (auth.is_admin());

-- Broker: Insert users into their brokerage (except admin/broker)
CREATE POLICY "broker_insert_brokerage_users"
  ON users FOR INSERT
  WITH CHECK (
    auth.is_broker()
    AND auth.has_brokerage_access(brokerage_id::uuid)
    AND user_type NOT IN ('admin', 'broker')
  );

-- =====================================================
-- USERS TABLE: DELETE POLICIES
-- =====================================================

-- Only admin can delete users
CREATE POLICY "admin_delete_users"
  ON users FOR DELETE
  USING (auth.is_admin());

-- =====================================================
-- USER_PROFILES TABLE POLICIES
-- =====================================================

-- Users can view their own profile
CREATE POLICY "user_read_own_profile"
  ON user_profiles FOR SELECT
  USING (user_id = auth.uid());

-- Users can update their own profile
CREATE POLICY "user_update_own_profile_table"
  ON user_profiles FOR UPDATE
  USING (user_id = auth.uid());

-- Users can insert their own profile
CREATE POLICY "user_insert_own_profile"
  ON user_profiles FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Admin can read all profiles
CREATE POLICY "admin_read_all_profiles"
  ON user_profiles FOR SELECT
  USING (auth.is_admin());

-- =====================================================
-- USER_ACTIVITY TABLE POLICIES
-- =====================================================

-- Users can view their own activity
CREATE POLICY "user_read_own_activity"
  ON user_activity FOR SELECT
  USING (user_id = auth.uid());

-- Admin can view all activity
CREATE POLICY "admin_read_all_activity"
  ON user_activity FOR SELECT
  USING (auth.is_admin());

-- Broker can view activity in their brokerage
CREATE POLICY "broker_read_brokerage_activity"
  ON user_activity FOR SELECT
  USING (
    auth.is_broker()
    AND user_id IN (
      SELECT id FROM users WHERE brokerage_id = auth.user_brokerage_id()
    )
  );

-- System can insert activity for any user
CREATE POLICY "system_insert_activity"
  ON user_activity FOR INSERT
  WITH CHECK (true);

-- =====================================================
-- COMMENTS
-- =====================================================
-- WHY these policies exist:
-- 1. Users table contains sensitive permission data (user_type)
-- 2. Brokers manage their team but can't escalate privileges
-- 3. Contacts only see their own record (privacy)
-- 4. External parties are isolated to their own data
-- 5. Profile updates don't allow privilege escalation
-- =====================================================
