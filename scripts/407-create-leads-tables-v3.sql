-- Lead Intelligence Tables - Ultra Safe Version
-- All operations wrapped in checks to prevent conflicts

-- 1. LEADS TABLE (core lead tracking)
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  source TEXT,
  status TEXT DEFAULT 'new',
  agent_id UUID,
  brokerage_id UUID,
  lead_score INTEGER DEFAULT 0,
  contact_persona TEXT,
  property_interest JSONB DEFAULT '{}',
  notes TEXT,
  tags TEXT[],
  last_contacted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. LEAD_INTELLIGENCE TABLE
CREATE TABLE IF NOT EXISTS lead_intelligence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID,
  intelligence_type TEXT,
  data JSONB DEFAULT '{}',
  confidence_score NUMERIC(5,2),
  source TEXT,
  verified BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. LEAD_BEHAVIORAL_DATA TABLE
CREATE TABLE IF NOT EXISTS lead_behavioral_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID,
  event_type TEXT,
  event_data JSONB DEFAULT '{}',
  page_url TEXT,
  session_id TEXT,
  device_info JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. LEAD_ENGAGEMENT_SCORES TABLE
CREATE TABLE IF NOT EXISTS lead_engagement_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID,
  score_type TEXT,
  score_value NUMERIC(5,2),
  factors JSONB DEFAULT '{}',
  calculated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. LEAD_PROPERTY_OWNERSHIP TABLE
CREATE TABLE IF NOT EXISTS lead_property_ownership (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID,
  property_address TEXT,
  property_data JSONB DEFAULT '{}',
  ownership_status TEXT,
  equity_estimate NUMERIC(12,2),
  mortgage_info JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. LEAD_PEOPLE_DATA TABLE
CREATE TABLE IF NOT EXISTS lead_people_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID,
  data_source TEXT,
  person_data JSONB DEFAULT '{}',
  social_profiles JSONB DEFAULT '{}',
  employment_info JSONB DEFAULT '{}',
  enriched_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. LEAD_MOTIVATED_SELLER_SIGNALS TABLE
CREATE TABLE IF NOT EXISTS lead_motivated_seller_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID,
  signal_type TEXT,
  signal_strength NUMERIC(5,2),
  signal_data JSONB DEFAULT '{}',
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. LEAD_IDX_PROPERTY_INTERACTIONS TABLE
CREATE TABLE IF NOT EXISTS lead_idx_property_interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID,
  property_id TEXT,
  interaction_type TEXT,
  interaction_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. CLIENT_DETAILED_PERSONAS TABLE
CREATE TABLE IF NOT EXISTS client_detailed_personas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID,
  lead_id UUID,
  persona_type TEXT,
  persona_data JSONB DEFAULT '{}',
  lifestyle_factors JSONB DEFAULT '{}',
  communication_preferences JSONB DEFAULT '{}',
  buying_motivations JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. CHAT_SESSIONS TABLE
CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  lead_id UUID,
  contact_id UUID,
  session_type TEXT DEFAULT 'general',
  title TEXT,
  messages JSONB DEFAULT '[]',
  context JSONB DEFAULT '{}',
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on all tables
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

-- Drop existing policies to avoid conflicts
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

-- Create permissive policies for authenticated users
CREATE POLICY "leads_all" ON leads FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "lead_intelligence_all" ON lead_intelligence FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "lead_behavioral_data_all" ON lead_behavioral_data FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "lead_engagement_scores_all" ON lead_engagement_scores FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "lead_property_ownership_all" ON lead_property_ownership FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "lead_people_data_all" ON lead_people_data FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "lead_motivated_seller_signals_all" ON lead_motivated_seller_signals FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "lead_idx_property_interactions_all" ON lead_idx_property_interactions FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "client_detailed_personas_all" ON client_detailed_personas FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "chat_sessions_all" ON chat_sessions FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Create indexes (only on columns we know exist from CREATE TABLE above)
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_agent_id ON leads(agent_id);
CREATE INDEX IF NOT EXISTS idx_lead_intelligence_lead_id ON lead_intelligence(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_behavioral_data_lead_id ON lead_behavioral_data(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_engagement_scores_lead_id ON lead_engagement_scores(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_property_ownership_lead_id ON lead_property_ownership(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_people_data_lead_id ON lead_people_data(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_motivated_seller_signals_lead_id ON lead_motivated_seller_signals(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_idx_property_interactions_lead_id ON lead_idx_property_interactions(lead_id);
CREATE INDEX IF NOT EXISTS idx_client_detailed_personas_contact_id ON client_detailed_personas(contact_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_lead_id ON chat_sessions(lead_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_contact_id ON chat_sessions(contact_id);
