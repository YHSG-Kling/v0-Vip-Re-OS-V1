-- Consolidated Master Schema for Real Estate AI CRM
-- This ensures all core tables exist with proper structure, RLS, and indexes
-- Run this after all other migrations to ensure schema consistency

-- Enable necessary extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- for text search

-- ============================================================================
-- CORE ENTITIES
-- ============================================================================

-- Brokerages (root tenant entity)
CREATE TABLE IF NOT EXISTS brokerages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  logo_url TEXT,
  phone TEXT,
  email TEXT,
  address JSONB,
  license_number TEXT,
  settings JSONB DEFAULT '{}',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Profiles (extends auth.users for agents/staff)
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  email TEXT UNIQUE NOT NULL,
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'agent', -- super_admin, broker, team_lead, agent, coordinator
  ghl_phone_number TEXT,
  ghl_user_id TEXT,
  license_number TEXT,
  bio TEXT,
  settings JSONB DEFAULT '{}',
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Contacts (leads, clients, past clients)
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  ghl_contact_id TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  source TEXT, -- website, zillow_premier, realtor_com_premier, referral, open_house
  status TEXT DEFAULT 'new', -- new, contacted, qualified, appointment_booked, signed_agreement, pre_listing, active_listing, contingent, pending, sold, lifetime_customer
  contact_type TEXT, -- buyer, seller, investor, renter
  contact_persona TEXT, -- first_time_buyer, luxury_buyer, empty_nester, relocation, etc.
  timeline TEXT, -- immediate, 30_days, 60_days, 90_days, 6_months, 1_year, just_browsing
  budget_min INTEGER,
  budget_max INTEGER,
  lead_score INTEGER DEFAULT 0,
  intent_score INTEGER DEFAULT 0,
  engagement_score INTEGER DEFAULT 0,
  enriched BOOLEAN DEFAULT false,
  last_enriched_at TIMESTAMPTZ,
  tags JSONB DEFAULT '[]',
  custom_fields JSONB DEFAULT '{}',
  -- Credit fields
  credit_status TEXT, -- unknown, good, fair, poor, in_program, target_reached
  credit_score_band TEXT, -- 300-579, 580-669, 670-739, 740+
  lender_status TEXT, -- none, pre_approved, denied, in_review
  credit_pipeline_stage TEXT, -- none, intake, referred, in_program, target_score_reached, dropped
  -- Video engagement tracking
  last_video_watched_at TIMESTAMPTZ,
  total_video_watch_time INTEGER DEFAULT 0,
  videos_watched_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Listings
CREATE TABLE IF NOT EXISTS listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  seller_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  idx_listing_id TEXT,
  mls_number TEXT,
  address TEXT NOT NULL,
  city TEXT,
  state TEXT,
  zip TEXT,
  price INTEGER NOT NULL,
  bedrooms INTEGER,
  bathrooms DECIMAL(3,1),
  square_feet INTEGER,
  lot_size_acres DECIMAL(10,2),
  property_type TEXT,
  status TEXT DEFAULT 'draft', -- draft, coming_soon, active, pending, sold, cancelled
  listing_date DATE,
  sold_date DATE,
  photos JSONB DEFAULT '[]',
  description TEXT,
  features JSONB DEFAULT '{}',
  current_stage TEXT, -- pre_listing, coming_soon, active, under_contract, pending, closed
  stage_history JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Transactions
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
  buyer_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  seller_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  transaction_type TEXT NOT NULL, -- buyer_side, seller_side, dual
  status TEXT DEFAULT 'pending', -- pending, under_contract, contingent, closing, closed, cancelled
  property_address TEXT NOT NULL,
  purchase_price INTEGER,
  contract_date DATE,
  estimated_close_date DATE,
  actual_close_date DATE,
  commission_total INTEGER,
  commission_split JSONB DEFAULT '{}',
  dotloop_loop_id TEXT,
  notes TEXT,
  custom_fields JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Tasks
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assigned_to UUID REFERENCES profiles(id) ON DELETE SET NULL,
  created_by UUID REFERENCES profiles(id) ON DELETE SET NULL,
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  due_date TIMESTAMPTZ,
  priority TEXT DEFAULT 'medium', -- low, medium, high, urgent
  status TEXT DEFAULT 'pending', -- pending, in_progress, completed, cancelled
  completed_at TIMESTAMPTZ,
  auto_generated BOOLEAN DEFAULT false,
  source_type TEXT, -- ai_suggestion, playbook, manual, milestone
  source_id UUID,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Communications
CREATE TABLE IF NOT EXISTS communications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES profiles(id) ON DELETE SET NULL,
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  direction TEXT NOT NULL, -- inbound, outbound
  channel TEXT NOT NULL, -- sms, email, call, in_person, video
  subject TEXT,
  body TEXT,
  ghl_message_id TEXT,
  read_at TIMESTAMPTZ,
  replied_at TIMESTAMPTZ,
  sentiment_score DECIMAL(3,2),
  them_first_score DECIMAL(3,2),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- INDEXES FOR CORE ENTITIES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_profiles_brokerage_id ON profiles(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles(email);
CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);

CREATE INDEX IF NOT EXISTS idx_contacts_agent_id ON contacts(agent_id);
CREATE INDEX IF NOT EXISTS idx_contacts_brokerage_id ON contacts(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_phone ON contacts(phone);
CREATE INDEX IF NOT EXISTS idx_contacts_ghl_contact_id ON contacts(ghl_contact_id);

CREATE INDEX IF NOT EXISTS idx_listings_agent_id ON listings(agent_id);
CREATE INDEX IF NOT EXISTS idx_listings_brokerage_id ON listings(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_mls_number ON listings(mls_number);

CREATE INDEX IF NOT EXISTS idx_transactions_agent_id ON transactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_transactions_brokerage_id ON transactions(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);

CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_brokerage_id ON tasks(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);

CREATE INDEX IF NOT EXISTS idx_communications_contact_id ON communications(contact_id);
CREATE INDEX IF NOT EXISTS idx_communications_agent_id ON communications(agent_id);
CREATE INDEX IF NOT EXISTS idx_communications_brokerage_id ON communications(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_communications_created_at ON communications(created_at);

-- ============================================================================
-- RLS POLICIES FOR CORE ENTITIES
-- ============================================================================

-- Enable RLS
ALTER TABLE brokerages ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications ENABLE ROW LEVEL SECURITY;

-- Brokerages: Admins see only their brokerage
CREATE POLICY IF NOT EXISTS "Users can view their brokerage"
  ON brokerages FOR SELECT
  USING (id IN (SELECT brokerage_id FROM profiles WHERE id = auth.uid()));

CREATE POLICY IF NOT EXISTS "Admins can update their brokerage"
  ON brokerages FOR UPDATE
  USING (
    id IN (
      SELECT brokerage_id FROM profiles 
      WHERE id = auth.uid() 
      AND role IN ('super_admin', 'broker')
    )
  );

-- Profiles: Users see profiles in their brokerage
CREATE POLICY IF NOT EXISTS "Users can view profiles in their brokerage"
  ON profiles FOR SELECT
  USING (
    brokerage_id IN (
      SELECT brokerage_id FROM profiles WHERE id = auth.uid()
    )
  );

CREATE POLICY IF NOT EXISTS "Users can update their own profile"
  ON profiles FOR UPDATE
  USING (id = auth.uid());

-- Contacts: Agents see own contacts, admins see all in brokerage
CREATE POLICY IF NOT EXISTS "Agents see own contacts, admins see all"
  ON contacts FOR SELECT
  USING (
    agent_id = auth.uid() 
    OR brokerage_id IN (
      SELECT brokerage_id FROM profiles 
      WHERE id = auth.uid() 
      AND role IN ('super_admin', 'broker', 'team_lead')
    )
  );

CREATE POLICY IF NOT EXISTS "Agents can insert contacts"
  ON contacts FOR INSERT
  WITH CHECK (
    agent_id = auth.uid()
    AND brokerage_id IN (SELECT brokerage_id FROM profiles WHERE id = auth.uid())
  );

CREATE POLICY IF NOT EXISTS "Agents can update own contacts"
  ON contacts FOR UPDATE
  USING (
    agent_id = auth.uid()
    OR brokerage_id IN (
      SELECT brokerage_id FROM profiles 
      WHERE id = auth.uid() 
      AND role IN ('super_admin', 'broker', 'team_lead')
    )
  );

-- Similar RLS policies for listings, transactions, tasks, communications
-- (Following same pattern: agents see own, admins see all in brokerage)

CREATE POLICY IF NOT EXISTS "Agents see own listings, admins see all"
  ON listings FOR SELECT
  USING (
    agent_id = auth.uid()
    OR brokerage_id IN (
      SELECT brokerage_id FROM profiles 
      WHERE id = auth.uid() 
      AND role IN ('super_admin', 'broker', 'team_lead')
    )
  );

CREATE POLICY IF NOT EXISTS "Agents see own transactions, admins see all"
  ON transactions FOR SELECT
  USING (
    agent_id = auth.uid()
    OR brokerage_id IN (
      SELECT brokerage_id FROM profiles 
      WHERE id = auth.uid() 
      AND role IN ('super_admin', 'broker', 'team_lead')
    )
  );

CREATE POLICY IF NOT EXISTS "Users see relevant tasks"
  ON tasks FOR SELECT
  USING (
    assigned_to = auth.uid()
    OR created_by = auth.uid()
    OR brokerage_id IN (
      SELECT brokerage_id FROM profiles 
      WHERE id = auth.uid() 
      AND role IN ('super_admin', 'broker', 'team_lead')
    )
  );

CREATE POLICY IF NOT EXISTS "Users see relevant communications"
  ON communications FOR SELECT
  USING (
    agent_id = auth.uid()
    OR brokerage_id IN (
      SELECT brokerage_id FROM profiles 
      WHERE id = auth.uid() 
      AND role IN ('super_admin', 'broker', 'team_lead')
    )
  );

-- ============================================================================
-- TRIGGERS FOR UPDATED_AT
-- ============================================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_brokerages_updated_at BEFORE UPDATE ON brokerages
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_contacts_updated_at BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_listings_updated_at BEFORE UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_transactions_updated_at BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_tasks_updated_at BEFORE UPDATE ON tasks
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
