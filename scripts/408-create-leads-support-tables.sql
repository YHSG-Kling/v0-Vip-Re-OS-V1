-- Create ONLY new tables that don't exist yet
-- Does NOT modify existing tables like 'leads'

-- Lead Intelligence (enrichment data)
CREATE TABLE IF NOT EXISTS lead_intelligence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  data_source TEXT,
  enrichment_data JSONB DEFAULT '{}',
  confidence_score DECIMAL(5,2),
  last_enriched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Lead Behavioral Data
CREATE TABLE IF NOT EXISTS lead_behavioral_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  event_type TEXT NOT NULL,
  event_data JSONB DEFAULT '{}',
  page_url TEXT,
  session_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Lead Engagement Scores
CREATE TABLE IF NOT EXISTS lead_engagement_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  score_type TEXT NOT NULL,
  score DECIMAL(5,2) NOT NULL,
  factors JSONB DEFAULT '{}',
  calculated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Lead Property Ownership (for FSBO/investor detection)
CREATE TABLE IF NOT EXISTS lead_property_ownership (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  property_address TEXT,
  property_data JSONB DEFAULT '{}',
  ownership_type TEXT,
  estimated_value DECIMAL(12,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Lead People Data (social/professional info)
CREATE TABLE IF NOT EXISTS lead_people_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  data_source TEXT,
  profile_data JSONB DEFAULT '{}',
  social_profiles JSONB DEFAULT '{}',
  employment_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Motivated Seller Signals
CREATE TABLE IF NOT EXISTS lead_motivated_seller_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  signal_type TEXT NOT NULL,
  signal_strength DECIMAL(5,2),
  signal_data JSONB DEFAULT '{}',
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- IDX Property Interactions
CREATE TABLE IF NOT EXISTS lead_idx_property_interactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  property_id TEXT,
  interaction_type TEXT NOT NULL,
  interaction_data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Client Detailed Personas
CREATE TABLE IF NOT EXISTS client_detailed_personas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID,
  lead_id UUID,
  persona_type TEXT NOT NULL,
  persona_data JSONB DEFAULT '{}',
  confidence_score DECIMAL(5,2),
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chat Sessions
CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  lead_id UUID,
  contact_id UUID,
  session_type TEXT DEFAULT 'general',
  messages JSONB DEFAULT '[]',
  context JSONB DEFAULT '{}',
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on all tables
ALTER TABLE lead_intelligence ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_behavioral_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_engagement_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_property_ownership ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_people_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_motivated_seller_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_idx_property_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_detailed_personas ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;

-- Create permissive policies
DROP POLICY IF EXISTS "lead_intelligence_all" ON lead_intelligence;
CREATE POLICY "lead_intelligence_all" ON lead_intelligence FOR ALL TO authenticated USING (true);

DROP POLICY IF EXISTS "lead_behavioral_data_all" ON lead_behavioral_data;
CREATE POLICY "lead_behavioral_data_all" ON lead_behavioral_data FOR ALL TO authenticated USING (true);

DROP POLICY IF EXISTS "lead_engagement_scores_all" ON lead_engagement_scores;
CREATE POLICY "lead_engagement_scores_all" ON lead_engagement_scores FOR ALL TO authenticated USING (true);

DROP POLICY IF EXISTS "lead_property_ownership_all" ON lead_property_ownership;
CREATE POLICY "lead_property_ownership_all" ON lead_property_ownership FOR ALL TO authenticated USING (true);

DROP POLICY IF EXISTS "lead_people_data_all" ON lead_people_data;
CREATE POLICY "lead_people_data_all" ON lead_people_data FOR ALL TO authenticated USING (true);

DROP POLICY IF EXISTS "lead_motivated_seller_signals_all" ON lead_motivated_seller_signals;
CREATE POLICY "lead_motivated_seller_signals_all" ON lead_motivated_seller_signals FOR ALL TO authenticated USING (true);

DROP POLICY IF EXISTS "lead_idx_property_interactions_all" ON lead_idx_property_interactions;
CREATE POLICY "lead_idx_property_interactions_all" ON lead_idx_property_interactions FOR ALL TO authenticated USING (true);

DROP POLICY IF EXISTS "client_detailed_personas_all" ON client_detailed_personas;
CREATE POLICY "client_detailed_personas_all" ON client_detailed_personas FOR ALL TO authenticated USING (true);

DROP POLICY IF EXISTS "chat_sessions_all" ON chat_sessions;
CREATE POLICY "chat_sessions_all" ON chat_sessions FOR ALL TO authenticated USING (true);

-- Create indexes on new tables only
CREATE INDEX IF NOT EXISTS idx_lead_intelligence_lead_id ON lead_intelligence(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_behavioral_data_lead_id ON lead_behavioral_data(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_engagement_scores_lead_id ON lead_engagement_scores(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_property_ownership_lead_id ON lead_property_ownership(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_people_data_lead_id ON lead_people_data(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_motivated_seller_signals_lead_id ON lead_motivated_seller_signals(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_idx_property_interactions_lead_id ON lead_idx_property_interactions(lead_id);
CREATE INDEX IF NOT EXISTS idx_client_detailed_personas_contact_id ON client_detailed_personas(contact_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_id ON chat_sessions(user_id);
