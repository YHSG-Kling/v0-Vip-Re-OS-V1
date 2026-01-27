-- =====================================================
-- MULTI-TENANT RBAC SYSTEM MIGRATION
-- =====================================================
-- This migration establishes a clean multi-tenant model with:
-- 1. Brokerages table as the tenant root
-- 2. Roles and capabilities system
-- 3. User-brokerage-role mappings
-- 4. Comprehensive RLS policies for all domain tables
-- =====================================================

-- =====================================================
-- STEP 1: CREATE CORE RBAC TABLES
-- =====================================================

-- Brokerages table (tenant root)
CREATE TABLE IF NOT EXISTS brokerages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  code TEXT UNIQUE NOT NULL, -- Short identifier like "KELLER_TX"
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  phone TEXT,
  email TEXT,
  logo_url TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive', 'suspended')),
  subscription_tier TEXT DEFAULT 'basic' CHECK (subscription_tier IN ('basic', 'pro', 'enterprise')),
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Roles table
CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL, -- 'BrokerOwner', 'ManagingBroker', 'Agent', 'TC', 'Compliance'
  description TEXT,
  created_at TIMESTAMP DEFAULT now()
);

-- Role capabilities (granular permissions)
CREATE TABLE IF NOT EXISTS role_capabilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  capability TEXT NOT NULL, -- e.g., 'contacts:read', 'transactions:write', 'reports:admin'
  created_at TIMESTAMP DEFAULT now(),
  UNIQUE(role_id, capability)
);

-- User-Brokerage-Role mapping (links Supabase auth.users to brokerages and roles)
CREATE TABLE IF NOT EXISTS user_brokerage_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  is_primary BOOLEAN DEFAULT true, -- User's primary brokerage
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  UNIQUE(user_id, brokerage_id, role_id)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_user_brokerage_roles_user_id ON user_brokerage_roles(user_id);
CREATE INDEX IF NOT EXISTS idx_user_brokerage_roles_brokerage_id ON user_brokerage_roles(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_user_brokerage_roles_role_id ON user_brokerage_roles(role_id);
CREATE INDEX IF NOT EXISTS idx_role_capabilities_role_id ON role_capabilities(role_id);

-- =====================================================
-- STEP 2: SEED ROLES AND CAPABILITIES
-- =====================================================

-- Insert default roles
INSERT INTO roles (name, description) VALUES
  ('BrokerOwner', 'Owner of the brokerage with full administrative access'),
  ('ManagingBroker', 'Managing broker with oversight of all agents and transactions'),
  ('Agent', 'Real estate agent with access to their own contacts and deals'),
  ('TC', 'Transaction Coordinator with access to all transactions'),
  ('Compliance', 'Compliance officer with read access to all data for auditing')
ON CONFLICT (name) DO NOTHING;

-- Insert capabilities for BrokerOwner (full access)
INSERT INTO role_capabilities (role_id, capability)
SELECT id, capability FROM roles, (VALUES
  ('contacts:read'), ('contacts:write'), ('contacts:delete'),
  ('transactions:read'), ('transactions:write'), ('transactions:delete'),
  ('listings:read'), ('listings:write'), ('listings:delete'),
  ('users:read'), ('users:write'), ('users:delete'),
  ('reports:read'), ('reports:admin'),
  ('settings:read'), ('settings:write'),
  ('billing:read'), ('billing:write')
) AS caps(capability)
WHERE roles.name = 'BrokerOwner'
ON CONFLICT (role_id, capability) DO NOTHING;

-- Insert capabilities for ManagingBroker
INSERT INTO role_capabilities (role_id, capability)
SELECT id, capability FROM roles, (VALUES
  ('contacts:read'), ('contacts:write'),
  ('transactions:read'), ('transactions:write'),
  ('listings:read'), ('listings:write'),
  ('users:read'), ('users:write'),
  ('reports:read')
) AS caps(capability)
WHERE roles.name = 'ManagingBroker'
ON CONFLICT (role_id, capability) DO NOTHING;

-- Insert capabilities for Agent
INSERT INTO role_capabilities (role_id, capability)
SELECT id, capability FROM roles, (VALUES
  ('contacts:read'), ('contacts:write'),
  ('transactions:read'), ('transactions:write'),
  ('listings:read'), ('listings:write'),
  ('reports:read')
) AS caps(capability)
WHERE roles.name = 'Agent'
ON CONFLICT (role_id, capability) DO NOTHING;

-- Insert capabilities for TC
INSERT INTO role_capabilities (role_id, capability)
SELECT id, capability FROM roles, (VALUES
  ('transactions:read'), ('transactions:write'),
  ('transaction_milestones:read'), ('transaction_milestones:write'),
  ('documents:read'), ('documents:write')
) AS caps(capability)
WHERE roles.name = 'TC'
ON CONFLICT (role_id, capability) DO NOTHING;

-- Insert capabilities for Compliance
INSERT INTO role_capabilities (role_id, capability)
SELECT id, capability FROM roles, (VALUES
  ('contacts:read'),
  ('transactions:read'),
  ('listings:read'),
  ('documents:read'),
  ('reports:read')
) AS caps(capability)
WHERE roles.name = 'Compliance'
ON CONFLICT (role_id, capability) DO NOTHING;

-- =====================================================
-- STEP 3: ADD BROKERAGE_ID TO ALL DOMAIN TABLES
-- =====================================================

-- Add brokerage_id to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_users_brokerage_id ON users(brokerage_id);

-- Add brokerage_id to contacts table
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_contacts_brokerage_id ON contacts(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_contacts_agent_id ON contacts(agent_id);

-- Add brokerage_id to transactions table
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_transactions_brokerage_id ON transactions(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_transactions_agent_id ON transactions(agent_id);

-- Add brokerage_id to listings table
ALTER TABLE listings ADD COLUMN IF NOT EXISTS brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_listings_brokerage_id ON listings(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_listings_agent_id ON listings(agent_id);

-- Add brokerage_id to vendors table
ALTER TABLE vendors ADD COLUMN IF NOT EXISTS brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_vendors_brokerage_id ON vendors(brokerage_id);

-- Add brokerage_id to plan_tasks table
ALTER TABLE plan_tasks ADD COLUMN IF NOT EXISTS brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_plan_tasks_brokerage_id ON plan_tasks(brokerage_id);

-- Add brokerage_id to copilot_plans table
ALTER TABLE copilot_plans ADD COLUMN IF NOT EXISTS brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_copilot_plans_brokerage_id ON copilot_plans(brokerage_id);

-- Add shared_with_user_ids to contacts for explicit sharing
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS shared_with_user_ids UUID[] DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_contacts_shared_with_user_ids ON contacts USING GIN(shared_with_user_ids);

-- Add shared_with_user_ids to transactions for explicit sharing
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS shared_with_user_ids UUID[] DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_transactions_shared_with_user_ids ON transactions USING GIN(shared_with_user_ids);

-- Add assigned_agent_id if not already present (for agent-specific filtering)
-- This allows us to distinguish between agent_id (listing agent) and assigned_agent_id (deal owner)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS assigned_agent_id UUID REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_contacts_assigned_agent_id ON contacts(assigned_agent_id);

ALTER TABLE transactions ADD COLUMN IF NOT EXISTS assigned_agent_id UUID REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_transactions_assigned_agent_id ON transactions(assigned_agent_id);

-- =====================================================
-- STEP 4: HELPER FUNCTIONS FOR RLS
-- =====================================================

-- Function to get user's brokerage IDs
CREATE OR REPLACE FUNCTION auth.user_brokerage_ids()
RETURNS UUID[] AS $$
  SELECT ARRAY_AGG(DISTINCT brokerage_id)
  FROM user_brokerage_roles
  WHERE user_id = auth.uid();
$$ LANGUAGE SQL SECURITY DEFINER;

-- Function to check if user has a specific role
CREATE OR REPLACE FUNCTION auth.user_has_role(role_name TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS(
    SELECT 1
    FROM user_brokerage_roles ubr
    JOIN roles r ON ubr.role_id = r.id
    WHERE ubr.user_id = auth.uid()
    AND r.name = role_name
  );
$$ LANGUAGE SQL SECURITY DEFINER;

-- Function to check if user has a capability
CREATE OR REPLACE FUNCTION auth.user_has_capability(cap TEXT)
RETURNS BOOLEAN AS $$
  SELECT EXISTS(
    SELECT 1
    FROM user_brokerage_roles ubr
    JOIN role_capabilities rc ON ubr.role_id = rc.role_id
    WHERE ubr.user_id = auth.uid()
    AND rc.capability = cap
  );
$$ LANGUAGE SQL SECURITY DEFINER;

-- Function to check if user is admin (BrokerOwner or ManagingBroker)
CREATE OR REPLACE FUNCTION auth.user_is_admin()
RETURNS BOOLEAN AS $$
  SELECT EXISTS(
    SELECT 1
    FROM user_brokerage_roles ubr
    JOIN roles r ON ubr.role_id = r.id
    WHERE ubr.user_id = auth.uid()
    AND r.name IN ('BrokerOwner', 'ManagingBroker')
  );
$$ LANGUAGE SQL SECURITY DEFINER;

-- =====================================================
-- STEP 5: ENABLE RLS ON ALL TABLES
-- =====================================================

ALTER TABLE brokerages ENABLE ROW LEVEL SECURITY;
ALTER TABLE roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_capabilities ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_brokerage_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendors ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE copilot_plans ENABLE ROW LEVEL SECURITY;

-- =====================================================
-- STEP 6: RLS POLICIES FOR CORE TABLES
-- =====================================================

-- Brokerages: Users can see only their own brokerage(s)
CREATE POLICY "Users can view their own brokerages"
  ON brokerages FOR SELECT
  USING (id = ANY(auth.user_brokerage_ids()));

CREATE POLICY "Admins can update their brokerage"
  ON brokerages FOR UPDATE
  USING (id = ANY(auth.user_brokerage_ids()) AND auth.user_is_admin());

-- Roles: Everyone can view roles (needed for UI)
CREATE POLICY "Everyone can view roles"
  ON roles FOR SELECT
  TO authenticated
  USING (true);

-- Role Capabilities: Everyone can view capabilities
CREATE POLICY "Everyone can view capabilities"
  ON role_capabilities FOR SELECT
  TO authenticated
  USING (true);

-- User Brokerage Roles: Users can view their own mappings, admins can view all in brokerage
CREATE POLICY "Users can view their own role mappings"
  ON user_brokerage_roles FOR SELECT
  USING (user_id = auth.uid() OR (brokerage_id = ANY(auth.user_brokerage_ids()) AND auth.user_is_admin()));

CREATE POLICY "Admins can insert role mappings"
  ON user_brokerage_roles FOR INSERT
  WITH CHECK (brokerage_id = ANY(auth.user_brokerage_ids()) AND auth.user_is_admin());

CREATE POLICY "Admins can update role mappings"
  ON user_brokerage_roles FOR UPDATE
  USING (brokerage_id = ANY(auth.user_brokerage_ids()) AND auth.user_is_admin());

CREATE POLICY "Admins can delete role mappings"
  ON user_brokerage_roles FOR DELETE
  USING (brokerage_id = ANY(auth.user_brokerage_ids()) AND auth.user_is_admin());

-- =====================================================
-- STEP 7: RLS POLICIES FOR DOMAIN TABLES
-- =====================================================

-- CONTACTS TABLE
-- Agents see only their own contacts + shared contacts
-- Admins see all contacts in their brokerage
CREATE POLICY "Users can view contacts in their brokerage"
  ON contacts FOR SELECT
  USING (
    brokerage_id = ANY(auth.user_brokerage_ids())
    AND (
      auth.user_is_admin() -- Admins see all
      OR assigned_agent_id = auth.uid() -- Agents see their own
      OR agent_id = auth.uid() -- Legacy agent_id field
      OR auth.uid() = ANY(shared_with_user_ids) -- Explicitly shared
    )
  );

CREATE POLICY "Users can insert contacts in their brokerage"
  ON contacts FOR INSERT
  WITH CHECK (
    brokerage_id = ANY(auth.user_brokerage_ids())
    AND auth.user_has_capability('contacts:write')
  );

CREATE POLICY "Users can update their own contacts"
  ON contacts FOR UPDATE
  USING (
    brokerage_id = ANY(auth.user_brokerage_ids())
    AND (
      auth.user_is_admin()
      OR assigned_agent_id = auth.uid()
      OR agent_id = auth.uid()
    )
    AND auth.user_has_capability('contacts:write')
  );

CREATE POLICY "Admins can delete contacts"
  ON contacts FOR DELETE
  USING (
    brokerage_id = ANY(auth.user_brokerage_ids())
    AND auth.user_has_capability('contacts:delete')
  );

-- TRANSACTIONS TABLE
-- TC and Compliance can see all transactions in brokerage
-- Agents see only their own + shared
CREATE POLICY "Users can view transactions in their brokerage"
  ON transactions FOR SELECT
  USING (
    brokerage_id = ANY(auth.user_brokerage_ids())
    AND (
      auth.user_is_admin() -- Admins see all
      OR auth.user_has_role('TC') -- TC sees all transactions
      OR auth.user_has_role('Compliance') -- Compliance sees all
      OR assigned_agent_id = auth.uid() -- Agents see their own
      OR agent_id = auth.uid() -- Legacy agent_id field
      OR auth.uid() = ANY(shared_with_user_ids) -- Explicitly shared
    )
  );

CREATE POLICY "Users can insert transactions"
  ON transactions FOR INSERT
  WITH CHECK (
    brokerage_id = ANY(auth.user_brokerage_ids())
    AND auth.user_has_capability('transactions:write')
  );

CREATE POLICY "Users can update transactions"
  ON transactions FOR UPDATE
  USING (
    brokerage_id = ANY(auth.user_brokerage_ids())
    AND (
      auth.user_is_admin()
      OR auth.user_has_role('TC')
      OR assigned_agent_id = auth.uid()
      OR agent_id = auth.uid()
    )
    AND auth.user_has_capability('transactions:write')
  );

CREATE POLICY "Admins can delete transactions"
  ON transactions FOR DELETE
  USING (
    brokerage_id = ANY(auth.user_brokerage_ids())
    AND auth.user_has_capability('transactions:delete')
  );

-- LISTINGS TABLE
CREATE POLICY "Users can view listings in their brokerage"
  ON listings FOR SELECT
  USING (
    brokerage_id = ANY(auth.user_brokerage_ids())
    AND (
      auth.user_is_admin()
      OR agent_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert listings"
  ON listings FOR INSERT
  WITH CHECK (
    brokerage_id = ANY(auth.user_brokerage_ids())
    AND auth.user_has_capability('listings:write')
  );

CREATE POLICY "Users can update their own listings"
  ON listings FOR UPDATE
  USING (
    brokerage_id = ANY(auth.user_brokerage_ids())
    AND (
      auth.user_is_admin()
      OR agent_id = auth.uid()
    )
    AND auth.user_has_capability('listings:write')
  );

CREATE POLICY "Admins can delete listings"
  ON listings FOR DELETE
  USING (
    brokerage_id = ANY(auth.user_brokerage_ids())
    AND auth.user_has_capability('listings:delete')
  );

-- VENDORS TABLE
CREATE POLICY "Users can view vendors in their brokerage"
  ON vendors FOR SELECT
  USING (brokerage_id = ANY(auth.user_brokerage_ids()));

CREATE POLICY "Admins can manage vendors"
  ON vendors FOR ALL
  USING (brokerage_id = ANY(auth.user_brokerage_ids()) AND auth.user_is_admin());

-- PLAN_TASKS TABLE
CREATE POLICY "Users can view plan_tasks in their brokerage"
  ON plan_tasks FOR SELECT
  USING (brokerage_id = ANY(auth.user_brokerage_ids()));

CREATE POLICY "Users can manage plan_tasks"
  ON plan_tasks FOR ALL
  USING (brokerage_id = ANY(auth.user_brokerage_ids()));

-- COPILOT_PLANS TABLE
CREATE POLICY "Users can view copilot_plans in their brokerage"
  ON copilot_plans FOR SELECT
  USING (brokerage_id = ANY(auth.user_brokerage_ids()));

CREATE POLICY "Users can manage copilot_plans"
  ON copilot_plans FOR ALL
  USING (brokerage_id = ANY(auth.user_brokerage_ids()));

-- =====================================================
-- STEP 8: TRIGGERS FOR AUTOMATIC BROKERAGE_ID
-- =====================================================

-- Function to set brokerage_id from current user's primary brokerage
CREATE OR REPLACE FUNCTION set_brokerage_id_from_user()
RETURNS TRIGGER AS $$
BEGIN
  -- If brokerage_id is not set, get it from user's primary brokerage
  IF NEW.brokerage_id IS NULL THEN
    SELECT brokerage_id INTO NEW.brokerage_id
    FROM user_brokerage_roles
    WHERE user_id = auth.uid()
    AND is_primary = true
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Apply trigger to domain tables
CREATE TRIGGER set_brokerage_id_contacts
  BEFORE INSERT ON contacts
  FOR EACH ROW
  EXECUTE FUNCTION set_brokerage_id_from_user();

CREATE TRIGGER set_brokerage_id_transactions
  BEFORE INSERT ON transactions
  FOR EACH ROW
  EXECUTE FUNCTION set_brokerage_id_from_user();

CREATE TRIGGER set_brokerage_id_listings
  BEFORE INSERT ON listings
  FOR EACH ROW
  EXECUTE FUNCTION set_brokerage_id_from_user();

-- =====================================================
-- STEP 9: SEED SAMPLE BROKERAGE (OPTIONAL FOR TESTING)
-- =====================================================

-- Insert a sample brokerage
INSERT INTO brokerages (name, code, city, state, status)
VALUES ('Demo Realty Group', 'DEMO_TX', 'Austin', 'TX', 'active')
ON CONFLICT (code) DO NOTHING;

-- =====================================================
-- MIGRATION COMPLETE
-- =====================================================
-- Next steps:
-- 1. Run this migration in Supabase SQL Editor
-- 2. Create user_brokerage_roles entries for your users
-- 3. Use the TypeScript helpers in lib/auth/permissions.ts
-- =====================================================
