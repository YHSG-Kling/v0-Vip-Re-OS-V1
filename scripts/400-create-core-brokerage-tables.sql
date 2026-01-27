-- Core Brokerage Platform Tables
-- This script creates all essential tables for the brokerage platform

-- =============================================
-- BROKERAGES TABLE (create first - no dependencies)
-- =============================================
CREATE TABLE IF NOT EXISTS brokerages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  legal_name TEXT,
  license_number TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  logo_url TEXT,
  primary_color TEXT DEFAULT '#4F46E5',
  settings JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- PROFILES TABLE (extends auth.users)
-- =============================================
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT,
  full_name TEXT,
  avatar_url TEXT,
  role TEXT DEFAULT 'agent' CHECK (role IN ('super_admin', 'admin', 'broker', 'team_lead', 'agent', 'tc', 'compliance', 'vendor', 'lender')),
  brokerage_id UUID REFERENCES brokerages(id),
  team_id UUID,
  phone TEXT,
  license_number TEXT,
  license_state TEXT,
  license_expiry DATE,
  bio TEXT,
  specializations TEXT[],
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- AGENTS TABLE (for agent-specific data)
-- =============================================
CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  team_id UUID,
  full_name TEXT,
  email TEXT,
  phone TEXT,
  license_number TEXT,
  license_state TEXT,
  license_expiry DATE,
  commission_split DECIMAL(5,2) DEFAULT 70.00,
  cap_amount DECIMAL(12,2),
  cap_reset_date DATE,
  ytd_volume DECIMAL(15,2) DEFAULT 0,
  ytd_gci DECIMAL(12,2) DEFAULT 0,
  specializations TEXT[],
  bio TEXT,
  avatar_url TEXT,
  is_active BOOLEAN DEFAULT true,
  hire_date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- CONTACTS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  brokerage_id UUID REFERENCES brokerages(id),
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  secondary_phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  contact_type TEXT DEFAULT 'lead' CHECK (contact_type IN ('lead', 'prospect', 'client', 'past_client', 'sphere', 'vendor', 'other')),
  contact_persona TEXT,
  lead_source TEXT,
  lead_score INTEGER DEFAULT 0,
  stage TEXT DEFAULT 'new',
  status TEXT DEFAULT 'active',
  tags TEXT[],
  notes TEXT,
  last_contact_date TIMESTAMPTZ,
  next_followup_date DATE,
  assigned_playbook TEXT,
  portal_access_granted BOOLEAN DEFAULT false,
  portal_access_token TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- TRANSACTIONS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID REFERENCES brokerages(id),
  agent_id UUID,
  contact_id UUID,
  co_agent_id UUID,
  property_address TEXT NOT NULL,
  city TEXT,
  state TEXT,
  zip TEXT,
  mls_number TEXT,
  property_type TEXT,
  transaction_type TEXT CHECK (transaction_type IN ('listing', 'buyer', 'dual', 'referral')),
  status TEXT DEFAULT 'new' CHECK (status IN ('new', 'negotiation', 'under_contract', 'inspection', 'financing', 'closing', 'closed', 'cancelled', 'expired')),
  list_price DECIMAL(12,2),
  sale_price DECIMAL(12,2),
  commission_rate DECIMAL(5,4),
  commission_amount DECIMAL(12,2),
  listing_date DATE,
  contract_date DATE,
  closing_date DATE,
  actual_closing_date DATE,
  days_on_market INTEGER,
  client_name TEXT,
  client_email TEXT,
  client_phone TEXT,
  notes TEXT,
  health_score INTEGER DEFAULT 75,
  next_task TEXT,
  missing_docs_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- TASKS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID REFERENCES brokerages(id),
  transaction_id UUID,
  contact_id UUID,
  assigned_to UUID,
  created_by UUID,
  title TEXT NOT NULL,
  description TEXT,
  task_type TEXT,
  priority TEXT DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'urgent')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  due_date DATE,
  due_time TIME,
  completed_at TIMESTAMPTZ,
  reminder_date TIMESTAMPTZ,
  is_automated BOOLEAN DEFAULT false,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- TRANSACTION DOCUMENTS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS transaction_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID,
  name TEXT NOT NULL,
  document_type TEXT,
  file_url TEXT,
  file_size INTEGER,
  mime_type TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'received', 'reviewed', 'approved', 'rejected')),
  due_date DATE,
  priority TEXT DEFAULT 'medium',
  uploaded_by UUID,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- AGENT COMMISSIONS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS agent_commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID REFERENCES brokerages(id),
  agent_id UUID,
  transaction_id UUID,
  gross_commission DECIMAL(12,2) NOT NULL,
  agent_split DECIMAL(5,2),
  agent_amount DECIMAL(12,2),
  brokerage_amount DECIMAL(12,2),
  referral_fee DECIMAL(12,2) DEFAULT 0,
  other_deductions DECIMAL(12,2) DEFAULT 0,
  net_to_agent DECIMAL(12,2),
  date DATE DEFAULT CURRENT_DATE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid')),
  paid_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- COMPLIANCE FLAGS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS compliance_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID REFERENCES brokerages(id),
  agent_id UUID,
  transaction_id UUID,
  content_id UUID,
  flag_type TEXT NOT NULL,
  severity TEXT DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved', 'dismissed')),
  title TEXT NOT NULL,
  description TEXT,
  source TEXT,
  flagged_content TEXT,
  resolution TEXT,
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- SHOWINGS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS showings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID REFERENCES brokerages(id),
  agent_id UUID,
  contact_id UUID,
  listing_id UUID,
  property_address TEXT NOT NULL,
  property_data JSONB DEFAULT '{}',
  showing_date DATE NOT NULL,
  showing_time TIME,
  duration_minutes INTEGER DEFAULT 30,
  status TEXT DEFAULT 'requested' CHECK (status IN ('requested', 'confirmed', 'completed', 'cancelled', 'no_show')),
  feedback TEXT,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  interest_level TEXT CHECK (interest_level IN ('not_interested', 'maybe', 'interested', 'very_interested')),
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- SAVED PROPERTIES TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS saved_properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID,
  property_id TEXT NOT NULL,
  property_address TEXT,
  property_data JSONB DEFAULT '{}',
  notes TEXT,
  is_favorite BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(contact_id, property_id)
);

-- =============================================
-- COMMUNICATIONS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS communications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID REFERENCES brokerages(id),
  agent_id UUID,
  contact_id UUID,
  transaction_id UUID,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'call', 'chat', 'portal')),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  subject TEXT,
  content TEXT,
  status TEXT DEFAULT 'sent',
  read_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- OFFERS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID,
  listing_id UUID,
  contact_id UUID,
  agent_id UUID,
  property_address TEXT NOT NULL,
  offer_amount DECIMAL(12,2) NOT NULL,
  earnest_money DECIMAL(12,2),
  down_payment_percent DECIMAL(5,2),
  financing_type TEXT,
  contingencies JSONB DEFAULT '[]',
  closing_date_requested DATE,
  expiration_date TIMESTAMPTZ,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'countered', 'accepted', 'rejected', 'expired', 'withdrawn')),
  counter_offer_amount DECIMAL(12,2),
  notes TEXT,
  submitted_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- LISTINGS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID REFERENCES brokerages(id),
  agent_id UUID,
  contact_id UUID,
  mls_number TEXT,
  property_address TEXT NOT NULL,
  city TEXT,
  state TEXT,
  zip TEXT,
  property_type TEXT,
  bedrooms INTEGER,
  bathrooms DECIMAL(3,1),
  sqft INTEGER,
  lot_size TEXT,
  year_built INTEGER,
  list_price DECIMAL(12,2),
  original_price DECIMAL(12,2),
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'coming_soon', 'active', 'pending', 'sold', 'expired', 'cancelled', 'withdrawn')),
  listing_date DATE,
  expiration_date DATE,
  days_on_market INTEGER DEFAULT 0,
  description TEXT,
  features JSONB DEFAULT '[]',
  photos JSONB DEFAULT '[]',
  virtual_tour_url TEXT,
  showing_instructions TEXT,
  lockbox_code TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- INDEXES
-- =============================================
CREATE INDEX IF NOT EXISTS idx_profiles_brokerage ON profiles(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);
CREATE INDEX IF NOT EXISTS idx_agents_brokerage ON agents(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_agents_user ON agents(user_id);
CREATE INDEX IF NOT EXISTS idx_contacts_agent ON contacts(agent_id);
CREATE INDEX IF NOT EXISTS idx_contacts_type ON contacts(contact_type);
CREATE INDEX IF NOT EXISTS idx_contacts_persona ON contacts(contact_persona);
CREATE INDEX IF NOT EXISTS idx_transactions_agent ON transactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_transactions_brokerage ON transactions(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_showings_agent ON showings(agent_id);
CREATE INDEX IF NOT EXISTS idx_showings_contact ON showings(contact_id);
CREATE INDEX IF NOT EXISTS idx_showings_date ON showings(showing_date);
CREATE INDEX IF NOT EXISTS idx_compliance_status ON compliance_flags(status);
CREATE INDEX IF NOT EXISTS idx_communications_contact ON communications(contact_id);
CREATE INDEX IF NOT EXISTS idx_offers_status ON offers(status);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_agent ON listings(agent_id);

-- =============================================
-- ROW LEVEL SECURITY
-- =============================================
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE brokerages ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE showings ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications ENABLE ROW LEVEL SECURITY;
ALTER TABLE offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings ENABLE ROW LEVEL SECURITY;

-- Basic RLS policies (allow authenticated users for now)
-- Drop existing policies first to avoid conflicts
DROP POLICY IF EXISTS "profiles_select" ON profiles;
DROP POLICY IF EXISTS "profiles_insert" ON profiles;
DROP POLICY IF EXISTS "profiles_update" ON profiles;
DROP POLICY IF EXISTS "contacts_all" ON contacts;
DROP POLICY IF EXISTS "transactions_all" ON transactions;
DROP POLICY IF EXISTS "tasks_all" ON tasks;
DROP POLICY IF EXISTS "showings_all" ON showings;
DROP POLICY IF EXISTS "agents_all" ON agents;
DROP POLICY IF EXISTS "brokerages_all" ON brokerages;
DROP POLICY IF EXISTS "listings_all" ON listings;
DROP POLICY IF EXISTS "offers_all" ON offers;
DROP POLICY IF EXISTS "communications_all" ON communications;
DROP POLICY IF EXISTS "compliance_flags_all" ON compliance_flags;
DROP POLICY IF EXISTS "saved_properties_all" ON saved_properties;
DROP POLICY IF EXISTS "transaction_documents_all" ON transaction_documents;
DROP POLICY IF EXISTS "agent_commissions_all" ON agent_commissions;

-- Create new policies
CREATE POLICY "profiles_select" ON profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "profiles_insert" ON profiles FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "profiles_update" ON profiles FOR UPDATE TO authenticated USING (true);

CREATE POLICY "contacts_all" ON contacts FOR ALL TO authenticated USING (true);
CREATE POLICY "transactions_all" ON transactions FOR ALL TO authenticated USING (true);
CREATE POLICY "tasks_all" ON tasks FOR ALL TO authenticated USING (true);
CREATE POLICY "showings_all" ON showings FOR ALL TO authenticated USING (true);
CREATE POLICY "agents_all" ON agents FOR ALL TO authenticated USING (true);
CREATE POLICY "brokerages_all" ON brokerages FOR ALL TO authenticated USING (true);
CREATE POLICY "listings_all" ON listings FOR ALL TO authenticated USING (true);
CREATE POLICY "offers_all" ON offers FOR ALL TO authenticated USING (true);
CREATE POLICY "communications_all" ON communications FOR ALL TO authenticated USING (true);
CREATE POLICY "compliance_flags_all" ON compliance_flags FOR ALL TO authenticated USING (true);
CREATE POLICY "saved_properties_all" ON saved_properties FOR ALL TO authenticated USING (true);
CREATE POLICY "transaction_documents_all" ON transaction_documents FOR ALL TO authenticated USING (true);
CREATE POLICY "agent_commissions_all" ON agent_commissions FOR ALL TO authenticated USING (true);
