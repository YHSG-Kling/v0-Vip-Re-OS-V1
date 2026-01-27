-- Ensure all lead intelligence tables exist for AI predictions
-- This script uses IF NOT EXISTS to avoid conflicts

-- ============================================
-- CORE LEADS TABLE
-- ============================================

CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID,
  agent_id UUID,
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  lead_source TEXT DEFAULT 'website',
  lead_status TEXT DEFAULT 'new',
  lead_stage TEXT DEFAULT 'awareness',
  buyer_seller_type TEXT,
  price_range_min NUMERIC,
  price_range_max NUMERIC,
  timeline TEXT,
  areas_of_interest TEXT[],
  notes TEXT,
  tags TEXT[],
  last_contact_date TIMESTAMPTZ,
  next_follow_up_date TIMESTAMPTZ,
  assigned_at TIMESTAMPTZ,
  converted_at TIMESTAMPTZ,
  lost_at TIMESTAMPTZ,
  lost_reason TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

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
-- LEAD PROPERTY OWNERSHIP
-- ============================================

CREATE TABLE IF NOT EXISTS lead_property_ownership (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  property_address TEXT,
  property_type TEXT,
  purchase_date DATE,
  purchase_price NUMERIC,
  current_value_estimate NUMERIC,
  equity_estimate NUMERIC,
  mortgage_balance NUMERIC,
  is_primary_residence BOOLEAN DEFAULT TRUE,
  ownership_type TEXT,
  data_source TEXT,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- LEAD PEOPLE DATA (OSINT)
-- ============================================

CREATE TABLE IF NOT EXISTS lead_people_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  full_name TEXT,
  age_range TEXT,
  gender TEXT,
  occupation TEXT,
  employer TEXT,
  linkedin_url TEXT,
  facebook_url TEXT,
  twitter_url TEXT,
  education TEXT,
  marital_status TEXT,
  household_size INTEGER,
  financial_indicators JSONB DEFAULT '{}',
  interests TEXT[],
  data_source TEXT,
  confidence_score NUMERIC,
  last_enriched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- MOTIVATED SELLER SIGNALS
-- ============================================

CREATE TABLE IF NOT EXISTS lead_motivated_seller_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  signal_type TEXT NOT NULL,
  signal_strength TEXT DEFAULT 'medium',
  signal_data JSONB DEFAULT '{}',
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  verified BOOLEAN DEFAULT FALSE,
  notes TEXT,
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
  property_address TEXT,
  interaction_type TEXT NOT NULL,
  view_duration_seconds INTEGER,
  saved BOOLEAN DEFAULT FALSE,
  shared BOOLEAN DEFAULT FALSE,
  requested_showing BOOLEAN DEFAULT FALSE,
  notes TEXT,
  occurred_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- CLIENT DETAILED PERSONAS
-- ============================================

CREATE TABLE IF NOT EXISTS client_detailed_personas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID,
  contact_id UUID,
  primary_persona TEXT,
  secondary_personas TEXT[],
  is_first_time_buyer BOOLEAN DEFAULT FALSE,
  is_investor BOOLEAN DEFAULT FALSE,
  is_luxury_buyer BOOLEAN DEFAULT FALSE,
  is_military_buyer BOOLEAN DEFAULT FALSE,
  is_military_seller BOOLEAN DEFAULT FALSE,
  is_divorce_buyer BOOLEAN DEFAULT FALSE,
  is_divorce_seller BOOLEAN DEFAULT FALSE,
  is_probate_seller BOOLEAN DEFAULT FALSE,
  is_relocating BOOLEAN DEFAULT FALSE,
  is_downsizing BOOLEAN DEFAULT FALSE,
  is_upsizing BOOLEAN DEFAULT FALSE,
  communication_preference TEXT,
  decision_making_style TEXT,
  risk_tolerance TEXT,
  persona_confidence NUMERIC,
  persona_factors JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- CHAT SESSIONS
-- ============================================

CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID,
  contact_id UUID,
  agent_id UUID,
  session_type TEXT DEFAULT 'ai_chat',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  message_count INTEGER DEFAULT 0,
  them_first_score INTEGER DEFAULT 0,
  sentiment_score NUMERIC,
  topics_discussed TEXT[],
  intent_detected TEXT,
  summary TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INDEXES FOR PERFORMANCE
-- ============================================

CREATE INDEX IF NOT EXISTS idx_leads_agent_id ON leads(agent_id);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(lead_status);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at);

CREATE INDEX IF NOT EXISTS idx_lead_intelligence_lead_id ON lead_intelligence(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_behavioral_data_lead_id ON lead_behavioral_data(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_behavioral_data_event_type ON lead_behavioral_data(event_type);
CREATE INDEX IF NOT EXISTS idx_lead_engagement_scores_lead_id ON lead_engagement_scores(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_property_ownership_lead_id ON lead_property_ownership(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_people_data_lead_id ON lead_people_data(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_motivated_seller_signals_lead_id ON lead_motivated_seller_signals(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_idx_property_interactions_lead_id ON lead_idx_property_interactions(lead_id);
CREATE INDEX IF NOT EXISTS idx_client_detailed_personas_lead_id ON client_detailed_personas(lead_id);
CREATE INDEX IF NOT EXISTS idx_client_detailed_personas_contact_id ON client_detailed_personas(contact_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_lead_id ON chat_sessions(lead_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_contact_id ON chat_sessions(contact_id);

-- ============================================
-- ENABLE RLS
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

-- ============================================
-- RLS POLICIES
-- ============================================

DROP POLICY IF EXISTS "leads_all" ON leads;
DROP POLICY IF EXISTS "lead_intelligence_all" ON lead_intelligence;
DROP POLICY IF EXISTS "lead_behavioral_data_all" ON lead_behavioral_data;
DROP POLICY IF EXISTS "lead_engagement_scores_all" ON lead_engagement_scores;
DROP POLICY IF EXISTS "lead_property_ownership_all" ON lead_property_ownership;
DROP POLICY IF EXISTS "lead_people_data_all" ON lead_people_data;
DROP POLICY IF EXISTS "lead_motivated_seller_signals_all" ON lead_motivated_seller_signals;
DROP POLICY IF EXISTS "lead_idx_property_interactions_all" ON lead_idx_property_interactions;
DROP POLICY IF EXISTS "client_detailed_personas_all" ON client_detailed_personas;
DROP POLICY IF EXISTS "chat_sessions_all" ON chat_sessions;

CREATE POLICY "leads_all" ON leads FOR ALL TO authenticated USING (true);
CREATE POLICY "lead_intelligence_all" ON lead_intelligence FOR ALL TO authenticated USING (true);
CREATE POLICY "lead_behavioral_data_all" ON lead_behavioral_data FOR ALL TO authenticated USING (true);
CREATE POLICY "lead_engagement_scores_all" ON lead_engagement_scores FOR ALL TO authenticated USING (true);
CREATE POLICY "lead_property_ownership_all" ON lead_property_ownership FOR ALL TO authenticated USING (true);
CREATE POLICY "lead_people_data_all" ON lead_people_data FOR ALL TO authenticated USING (true);
CREATE POLICY "lead_motivated_seller_signals_all" ON lead_motivated_seller_signals FOR ALL TO authenticated USING (true);
CREATE POLICY "lead_idx_property_interactions_all" ON lead_idx_property_interactions FOR ALL TO authenticated USING (true);
CREATE POLICY "client_detailed_personas_all" ON client_detailed_personas FOR ALL TO authenticated USING (true);
CREATE POLICY "chat_sessions_all" ON chat_sessions FOR ALL TO authenticated USING (true);
