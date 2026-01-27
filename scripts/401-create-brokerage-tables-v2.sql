-- Core Brokerage Platform Tables v2
-- This script creates tables without foreign key constraints to auth.users
-- to avoid conflicts with existing schema

-- =============================================
-- BROKERAGES TABLE
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
-- PROFILES TABLE (standalone, no auth.users FK)
-- =============================================
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  email TEXT,
  full_name TEXT,
  avatar_url TEXT,
  role TEXT DEFAULT 'agent',
  brokerage_id UUID,
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
-- AGENTS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  brokerage_id UUID,
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
  brokerage_id UUID,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  secondary_phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  contact_type TEXT DEFAULT 'lead',
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
  brokerage_id UUID,
  agent_id UUID,
  contact_id UUID,
  co_agent_id UUID,
  property_address TEXT NOT NULL,
  city TEXT,
  state TEXT,
  zip TEXT,
  mls_number TEXT,
  property_type TEXT,
  transaction_type TEXT,
  status TEXT DEFAULT 'new',
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
  brokerage_id UUID,
  transaction_id UUID,
  contact_id UUID,
  assigned_to UUID,
  created_by UUID,
  title TEXT NOT NULL,
  description TEXT,
  task_type TEXT,
  priority TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'pending',
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
  status TEXT DEFAULT 'pending',
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
  brokerage_id UUID,
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
  status TEXT DEFAULT 'pending',
  paid_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- COMPLIANCE FLAGS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS compliance_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID,
  agent_id UUID,
  transaction_id UUID,
  content_id UUID,
  flag_type TEXT NOT NULL,
  severity TEXT DEFAULT 'warning',
  status TEXT DEFAULT 'open',
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
  brokerage_id UUID,
  agent_id UUID,
  contact_id UUID,
  listing_id UUID,
  property_address TEXT NOT NULL,
  property_data JSONB DEFAULT '{}',
  showing_date DATE NOT NULL,
  showing_time TIME,
  duration_minutes INTEGER DEFAULT 30,
  status TEXT DEFAULT 'requested',
  feedback TEXT,
  rating INTEGER,
  interest_level TEXT,
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
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- COMMUNICATIONS TABLE
-- =============================================
CREATE TABLE IF NOT EXISTS communications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID,
  agent_id UUID,
  contact_id UUID,
  transaction_id UUID,
  channel TEXT NOT NULL,
  direction TEXT NOT NULL,
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
  status TEXT DEFAULT 'draft',
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
  brokerage_id UUID,
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
  status TEXT DEFAULT 'draft',
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
