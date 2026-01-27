-- Ensure all lead intelligence tables exist for AI predictions
-- This script safely creates tables and adds missing columns

-- ============================================
-- CORE LEADS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  lead_source TEXT DEFAULT 'website',
  lead_status TEXT DEFAULT 'new',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add missing columns to leads table if they don't exist
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'brokerage_id') THEN
    ALTER TABLE leads ADD COLUMN brokerage_id UUID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'agent_id') THEN
    ALTER TABLE leads ADD COLUMN agent_id UUID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'lead_stage') THEN
    ALTER TABLE leads ADD COLUMN lead_stage TEXT DEFAULT 'awareness';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'buyer_seller_type') THEN
    ALTER TABLE leads ADD COLUMN buyer_seller_type TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'price_range_min') THEN
    ALTER TABLE leads ADD COLUMN price_range_min NUMERIC;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'price_range_max') THEN
    ALTER TABLE leads ADD COLUMN price_range_max NUMERIC;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'timeline') THEN
    ALTER TABLE leads ADD COLUMN timeline TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'areas_of_interest') THEN
    ALTER TABLE leads ADD COLUMN areas_of_interest TEXT[];
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'notes') THEN
    ALTER TABLE leads ADD COLUMN notes TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'tags') THEN
    ALTER TABLE leads ADD COLUMN tags TEXT[];
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'last_contact_date') THEN
    ALTER TABLE leads ADD COLUMN last_contact_date TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'next_follow_up_date') THEN
    ALTER TABLE leads ADD COLUMN next_follow_up_date TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'assigned_at') THEN
    ALTER TABLE leads ADD COLUMN assigned_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'converted_at') THEN
    ALTER TABLE leads ADD COLUMN converted_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'metadata') THEN
    ALTER TABLE leads ADD COLUMN metadata JSONB DEFAULT '{}';
  END IF;
END $$;

-- ============================================
-- LEAD INTELLIGENCE
-- ============================================

CREATE TABLE IF NOT EXISTS lead_intelligence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  buyer_seller_type TEXT,
  price_range TEXT,
  timeline TEXT,
  motivation_score INTEGER DEFAULT 0,
  qualification_score INTEGER DEFAULT 0,
  readiness_score INTEGER DEFAULT 0,
  financial_readiness TEXT,
  pre_approved BOOLEAN DEFAULT FALSE,
  pre_approval_amount NUMERIC,
  current_housing TEXT,
  reason_for_move TEXT,
  must_haves TEXT[],
  nice_to_haves TEXT[],
  deal_breakers TEXT[],
  ai_summary TEXT,
  last_analyzed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- LEAD BEHAVIORAL DATA
-- ============================================

CREATE TABLE IF NOT EXISTS lead_behavioral_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  event_data JSONB DEFAULT '{}',
  page_url TEXT,
  referrer TEXT,
  device_type TEXT,
  session_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  occurred_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- LEAD ENGAGEMENT SCORES
-- ============================================

CREATE TABLE IF NOT EXISTS lead_engagement_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  overall_score INTEGER DEFAULT 0,
  email_engagement_score INTEGER DEFAULT 0,
  website_engagement_score INTEGER DEFAULT 0,
  property_interest_score INTEGER DEFAULT 0,
  response_rate_score INTEGER DEFAULT 0,
  recency_score INTEGER DEFAULT 0,
  frequency_score INTEGER DEFAULT 0,
  monetary_potential_score INTEGER DEFAULT 0,
  score_breakdown JSONB DEFAULT '{}',
  calculated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- LEAD PROPERTY OWNERSHIP (for seller leads)
-- ============================================

CREATE TABLE IF NOT EXISTS lead_property_ownership (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  property_address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  estimated_value NUMERIC,
  equity_estimate NUMERIC,
  ownership_length_years INTEGER,
  property_type TEXT,
  bedrooms INTEGER,
  bathrooms NUMERIC,
  sqft INTEGER,
  lot_size NUMERIC,
  year_built INTEGER,
  tax_assessment NUMERIC,
  mortgage_balance NUMERIC,
  data_source TEXT,
  last_updated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- LEAD PEOPLE DATA (enrichment)
-- ============================================

CREATE TABLE IF NOT EXISTS lead_people_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  full_name TEXT,
  age_range TEXT,
  gender TEXT,
  occupation TEXT,
  employer TEXT,
  income_range TEXT,
  net_worth_range TEXT,
  education_level TEXT,
  marital_status TEXT,
  household_size INTEGER,
  interests TEXT[],
  social_profiles JSONB DEFAULT '{}',
  data_source TEXT,
  confidence_score NUMERIC,
  last_enriched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- MOTIVATED SELLER SIGNALS
-- ============================================

CREATE TABLE IF NOT EXISTS lead_motivated_seller_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID,
  property_address TEXT,
  signal_type TEXT NOT NULL,
  signal_strength INTEGER DEFAULT 50,
  signal_details JSONB DEFAULT '{}',
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- IDX PROPERTY INTERACTIONS
-- ============================================

CREATE TABLE IF NOT EXISTS lead_idx_property_interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  property_id TEXT,
  mls_number TEXT,
  interaction_type TEXT NOT NULL,
  property_address TEXT,
  property_price NUMERIC,
  property_details JSONB DEFAULT '{}',
  view_duration_seconds INTEGER,
  is_saved BOOLEAN DEFAULT FALSE,
  is_hidden BOOLEAN DEFAULT FALSE,
  notes TEXT,
  occurred_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- CLIENT DETAILED PERSONAS
-- ============================================

CREATE TABLE IF NOT EXISTS client_detailed_personas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID,
  lead_id UUID,
  persona_type TEXT,
  persona_details JSONB DEFAULT '{}',
  communication_preferences JSONB DEFAULT '{}',
  decision_factors TEXT[],
  objections TEXT[],
  hot_buttons TEXT[],
  lifestyle_notes TEXT,
  generated_by TEXT DEFAULT 'ai',
  confidence_score NUMERIC,
  last_updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- CHAT SESSIONS
-- ============================================

CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  lead_id UUID,
  contact_id UUID,
  session_type TEXT DEFAULT 'general',
  title TEXT,
  messages JSONB DEFAULT '[]',
  context JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT TRUE,
  last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INDEXES (only create if column exists)
-- ============================================

DO $$
BEGIN
  -- Leads indexes
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'agent_id') THEN
    CREATE INDEX IF NOT EXISTS idx_leads_agent_id ON leads(agent_id);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'lead_status') THEN
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(lead_status);
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'leads' AND column_name = 'email') THEN
    CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
  END IF;
END $$;

-- Other table indexes
CREATE INDEX IF NOT EXISTS idx_lead_intelligence_lead_id ON lead_intelligence(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_behavioral_lead_id ON lead_behavioral_data(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_behavioral_event_type ON lead_behavioral_data(event_type);
CREATE INDEX IF NOT EXISTS idx_lead_engagement_lead_id ON lead_engagement_scores(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_property_lead_id ON lead_property_ownership(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_people_lead_id ON lead_people_data(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_signals_lead_id ON lead_motivated_seller_signals(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_signals_type ON lead_motivated_seller_signals(signal_type);
CREATE INDEX IF NOT EXISTS idx_lead_idx_lead_id ON lead_idx_property_interactions(lead_id);
CREATE INDEX IF NOT EXISTS idx_client_personas_contact_id ON client_detailed_personas(contact_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON chat_sessions(user_id);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_intelligence ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_behavioral_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_engagement_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_property_ownership ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_people_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_motivated_seller_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_idx_property_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_detailed_personas ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;

-- Drop existing policies first
DROP POLICY IF EXISTS "leads_all" ON leads;
DROP POLICY IF EXISTS "lead_intelligence_all" ON lead_intelligence;
DROP POLICY IF EXISTS "lead_behavioral_all" ON lead_behavioral_data;
DROP POLICY IF EXISTS "lead_engagement_all" ON lead_engagement_scores;
DROP POLICY IF EXISTS "lead_property_all" ON lead_property_ownership;
DROP POLICY IF EXISTS "lead_people_all" ON lead_people_data;
DROP POLICY IF EXISTS "lead_signals_all" ON lead_motivated_seller_signals;
DROP POLICY IF EXISTS "lead_idx_all" ON lead_idx_property_interactions;
DROP POLICY IF EXISTS "client_personas_all" ON client_detailed_personas;
DROP POLICY IF EXISTS "chat_sessions_all" ON chat_sessions;

-- Create new policies
CREATE POLICY "leads_all" ON leads FOR ALL TO authenticated USING (true);
CREATE POLICY "lead_intelligence_all" ON lead_intelligence FOR ALL TO authenticated USING (true);
CREATE POLICY "lead_behavioral_all" ON lead_behavioral_data FOR ALL TO authenticated USING (true);
CREATE POLICY "lead_engagement_all" ON lead_engagement_scores FOR ALL TO authenticated USING (true);
CREATE POLICY "lead_property_all" ON lead_property_ownership FOR ALL TO authenticated USING (true);
CREATE POLICY "lead_people_all" ON lead_people_data FOR ALL TO authenticated USING (true);
CREATE POLICY "lead_signals_all" ON lead_motivated_seller_signals FOR ALL TO authenticated USING (true);
CREATE POLICY "lead_idx_all" ON lead_idx_property_interactions FOR ALL TO authenticated USING (true);
CREATE POLICY "client_personas_all" ON client_detailed_personas FOR ALL TO authenticated USING (true);
CREATE POLICY "chat_sessions_all" ON chat_sessions FOR ALL TO authenticated USING (true);
