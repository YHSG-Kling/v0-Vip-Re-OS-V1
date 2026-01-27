-- Core Brokerage Tables - Safe Creation (no foreign keys to avoid conflicts)
-- This script uses IF NOT EXISTS and avoids foreign key constraints

-- 1. Brokerages table
CREATE TABLE IF NOT EXISTS brokerages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  logo_url TEXT,
  address TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  license_number TEXT,
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Profiles table (extends auth.users)
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY,
  email TEXT,
  full_name TEXT,
  avatar_url TEXT,
  phone TEXT,
  role TEXT DEFAULT 'agent',
  brokerage_id UUID,
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Agents table
CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  brokerage_id UUID,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  license_number TEXT,
  license_expiry DATE,
  avatar_url TEXT,
  bio TEXT,
  specialties TEXT[],
  is_active BOOLEAN DEFAULT true,
  commission_split DECIMAL(5,2) DEFAULT 70.00,
  hire_date DATE,
  settings JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. Contacts table
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  brokerage_id UUID,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  contact_type TEXT DEFAULT 'lead',
  contact_persona TEXT,
  stage TEXT DEFAULT 'new',
  source TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  notes TEXT,
  tags TEXT[],
  last_contact_date TIMESTAMPTZ,
  next_follow_up DATE,
  credit_score INTEGER,
  pre_approved BOOLEAN DEFAULT false,
  budget_min DECIMAL(12,2),
  budget_max DECIMAL(12,2),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Transactions table
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  brokerage_id UUID,
  contact_id UUID,
  listing_id UUID,
  property_address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  sale_price DECIMAL(12,2),
  list_price DECIMAL(12,2),
  status TEXT DEFAULT 'new',
  transaction_type TEXT DEFAULT 'purchase',
  contract_date DATE,
  closing_date DATE,
  inspection_date DATE,
  appraisal_date DATE,
  financing_type TEXT,
  earnest_money DECIMAL(10,2),
  commission_rate DECIMAL(5,4),
  commission_amount DECIMAL(10,2),
  notes TEXT,
  health_score INTEGER DEFAULT 75,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Tasks table
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  assigned_to UUID,
  contact_id UUID,
  transaction_id UUID,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'pending',
  priority TEXT DEFAULT 'medium',
  due_date DATE,
  due_time TIME,
  completed_at TIMESTAMPTZ,
  reminder_at TIMESTAMPTZ,
  task_type TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. Showings table
CREATE TABLE IF NOT EXISTS showings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  contact_id UUID,
  listing_id UUID,
  property_address TEXT,
  scheduled_date DATE,
  scheduled_time TIME,
  duration_minutes INTEGER DEFAULT 30,
  status TEXT DEFAULT 'scheduled',
  showing_type TEXT DEFAULT 'in_person',
  notes TEXT,
  feedback TEXT,
  rating INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Listings table
CREATE TABLE IF NOT EXISTS listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  brokerage_id UUID,
  mls_number TEXT,
  property_address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  list_price DECIMAL(12,2),
  beds INTEGER,
  baths DECIMAL(3,1),
  sqft INTEGER,
  lot_size DECIMAL(10,2),
  year_built INTEGER,
  property_type TEXT,
  status TEXT DEFAULT 'coming_soon',
  description TEXT,
  features TEXT[],
  photos TEXT[],
  virtual_tour_url TEXT,
  listed_date DATE,
  contract_date DATE,
  sold_date DATE,
  sold_price DECIMAL(12,2),
  days_on_market INTEGER,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. Offers table
CREATE TABLE IF NOT EXISTS offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID,
  agent_id UUID,
  buyer_contact_id UUID,
  offer_price DECIMAL(12,2),
  earnest_money DECIMAL(10,2),
  down_payment_percent DECIMAL(5,2),
  financing_type TEXT,
  closing_date DATE,
  contingencies TEXT[],
  status TEXT DEFAULT 'pending',
  counter_offer_price DECIMAL(12,2),
  notes TEXT,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. Communications table
CREATE TABLE IF NOT EXISTS communications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  contact_id UUID,
  channel TEXT DEFAULT 'email',
  direction TEXT DEFAULT 'outbound',
  subject TEXT,
  body TEXT,
  status TEXT DEFAULT 'sent',
  sent_at TIMESTAMPTZ,
  read_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 11. Compliance Flags table
CREATE TABLE IF NOT EXISTS compliance_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID,
  agent_id UUID,
  transaction_id UUID,
  flag_type TEXT NOT NULL,
  severity TEXT DEFAULT 'medium',
  status TEXT DEFAULT 'open',
  description TEXT,
  resolution TEXT,
  resolved_by UUID,
  resolved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 12. Saved Properties table
CREATE TABLE IF NOT EXISTS saved_properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID,
  property_id TEXT,
  property_address TEXT,
  property_data JSONB DEFAULT '{}',
  notes TEXT,
  rating INTEGER,
  is_favorite BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 13. Transaction Documents table
CREATE TABLE IF NOT EXISTS transaction_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID,
  document_type TEXT,
  name TEXT,
  file_url TEXT,
  status TEXT DEFAULT 'pending',
  due_date DATE,
  signed_at TIMESTAMPTZ,
  uploaded_by UUID,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 14. Agent Commissions table
CREATE TABLE IF NOT EXISTS agent_commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  brokerage_id UUID,
  transaction_id UUID,
  gross_commission DECIMAL(10,2),
  agent_split DECIMAL(5,2),
  agent_amount DECIMAL(10,2),
  brokerage_amount DECIMAL(10,2),
  status TEXT DEFAULT 'pending',
  paid_at TIMESTAMPTZ,
  date DATE DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add missing columns to existing tables if they exist
DO $$
BEGIN
  -- Add date column to agent_commissions if it doesn't exist
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_commissions' AND column_name = 'date') THEN
    ALTER TABLE agent_commissions ADD COLUMN date DATE DEFAULT CURRENT_DATE;
  END IF;
  
  -- Add brokerage_id to agent_commissions if it doesn't exist
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_commissions' AND column_name = 'brokerage_id') THEN
    ALTER TABLE agent_commissions ADD COLUMN brokerage_id UUID;
  END IF;
END $$;

-- Create indexes for performance (only if column exists)
CREATE INDEX IF NOT EXISTS idx_contacts_agent_id ON contacts(agent_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_transactions_agent_id ON transactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_showings_agent_id ON showings(agent_id);
CREATE INDEX IF NOT EXISTS idx_showings_scheduled_date ON showings(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_listings_agent_id ON listings(agent_id);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_compliance_flags_status ON compliance_flags(status);
CREATE INDEX IF NOT EXISTS idx_agent_commissions_agent_id ON agent_commissions(agent_id);

-- Create date index only if column exists
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_commissions' AND column_name = 'date') THEN
    CREATE INDEX IF NOT EXISTS idx_agent_commissions_date ON agent_commissions(date);
  END IF;
END $$;

-- Enable RLS on all tables
ALTER TABLE brokerages ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE showings ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_commissions ENABLE ROW LEVEL SECURITY;

-- Create permissive policies for authenticated users
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY['brokerages', 'profiles', 'agents', 'contacts', 'transactions', 'tasks', 'showings', 'listings', 'offers', 'communications', 'compliance_flags', 'saved_properties', 'transaction_documents', 'agent_commissions'])
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_auth_all ON %I', tbl, tbl);
    EXECUTE format('CREATE POLICY %I_auth_all ON %I FOR ALL TO authenticated USING (true) WITH CHECK (true)', tbl, tbl);
  END LOOP;
END $$;
