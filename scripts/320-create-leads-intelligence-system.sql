-- Lead Intelligence System - Separate from Contacts
-- LEADS = New people discovered from EXTERNAL scraping (NOT in our system yet)
-- CONTACTS = People who ARE in our system and assigned to an agent

-- ============================================
-- 1. CORE LEADS TABLE (Separate from Contacts)
-- ============================================
CREATE TABLE IF NOT EXISTS leads (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  -- Basic Info (may be partial from scraping)
  first_name TEXT,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip_code TEXT,
  
  -- Lead Source & Status
  lead_source TEXT NOT NULL, -- 'zillow', 'realtor', 'nextdoor', 'facebook', 'craigslist', 'reddit', 'batchdata', 'google', 'apify'
  lead_status TEXT DEFAULT 'new', -- 'new', 'reviewing', 'qualified', 'assigned', 'converted', 'rejected'
  scraped_from TEXT, -- URL or source identifier
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Intelligence Scores (calculated)
  motivation_score INTEGER DEFAULT 0, -- 0-100
  qualification_score INTEGER DEFAULT 0, -- 0-100
  engagement_score INTEGER DEFAULT 0, -- 0-100
  intent_type TEXT, -- 'buyer', 'seller', 'both', 'investor', 'unknown'
  intent_confidence INTEGER DEFAULT 0, -- 0-100
  temperature TEXT DEFAULT 'cold', -- 'cold', 'warm', 'hot', 'urgent'
  
  -- Assignment
  assigned_agent_id UUID REFERENCES users(id),
  assigned_at TIMESTAMPTZ,
  converted_to_contact_id UUID REFERENCES contacts(id),
  converted_at TIMESTAMPTZ,
  
  -- Metadata
  raw_scraped_data JSONB, -- Original scraped data
  notes TEXT,
  tags TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 2. LEAD INTELLIGENCE PROFILE
-- ============================================
CREATE TABLE IF NOT EXISTS lead_intelligence (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE UNIQUE,
  buyer_seller_type TEXT,
  identified_interests JSONB,
  property_preferences JSONB,
  price_range TEXT,
  property_type TEXT[],
  location_preferences TEXT[],
  timeline TEXT,
  motivation_score INTEGER DEFAULT 0,
  qualification_score INTEGER DEFAULT 0,
  data_sources JSONB,
  last_enriched_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 3. BEHAVIORAL DATA TRACKING
-- ============================================
CREATE TABLE IF NOT EXISTS lead_behavioral_data (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_data JSONB NOT NULL,
  event_source TEXT,
  engagement_score_delta INTEGER DEFAULT 0,
  occurred_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 4. PROPERTY SEARCH HISTORY (from OSINT/scraping)
-- ============================================
CREATE TABLE IF NOT EXISTS lead_property_searches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  search_source TEXT NOT NULL,
  search_query TEXT,
  search_location TEXT,
  properties_viewed JSONB,
  search_criteria JSONB,
  detected_via TEXT,
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 5. OSINT DATA COLLECTION
-- ============================================
CREATE TABLE IF NOT EXISTS lead_osint_data (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  data_type TEXT NOT NULL,
  data_source TEXT NOT NULL,
  data_content JSONB NOT NULL,
  confidence_score DECIMAL(3,2),
  collected_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 6. PROPERTY OWNERSHIP DATA (from BatchData)
-- ============================================
CREATE TABLE IF NOT EXISTS lead_property_ownership (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  property_address TEXT NOT NULL,
  property_details JSONB,
  estimated_value INTEGER,
  equity_estimate INTEGER,
  mortgage_data JSONB,
  purchase_date DATE,
  ownership_length_months INTEGER,
  property_tax DECIMAL(10,2),
  is_primary_residence BOOLEAN,
  motivation_indicators JSONB,
  data_source TEXT,
  last_updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 7. MOTIVATED SELLER SIGNALS
-- ============================================
CREATE TABLE IF NOT EXISTS lead_motivated_seller_signals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  signal_type TEXT NOT NULL,
  signal_details JSONB NOT NULL,
  signal_strength TEXT,
  detected_via TEXT,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 8. PEOPLE DATA ENRICHMENT
-- ============================================
CREATE TABLE IF NOT EXISTS lead_people_data (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  demographic_data JSONB,
  employment_data JSONB,
  financial_indicators JSONB,
  life_events JSONB,
  social_presence JSONB,
  contact_enrichment JSONB,
  data_source TEXT,
  enriched_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 9. ENGAGEMENT SCORING
-- ============================================
CREATE TABLE IF NOT EXISTS lead_engagement_scores (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE UNIQUE,
  overall_score INTEGER DEFAULT 0,
  email_engagement_score INTEGER DEFAULT 0,
  property_view_score INTEGER DEFAULT 0,
  communication_score INTEGER DEFAULT 0,
  search_activity_score INTEGER DEFAULT 0,
  recency_score INTEGER DEFAULT 0,
  frequency_score INTEGER DEFAULT 0,
  last_calculated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 10. IDX BROKER PROPERTY INTERACTIONS
-- ============================================
CREATE TABLE IF NOT EXISTS lead_idx_property_interactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  property_mls_id TEXT NOT NULL,
  property_address TEXT,
  property_details JSONB,
  interaction_type TEXT NOT NULL,
  time_spent_seconds INTEGER,
  referrer_url TEXT,
  interaction_metadata JSONB,
  interacted_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 11. NEXTDOOR ACTIVITY (via ZenRows)
-- ============================================
CREATE TABLE IF NOT EXISTS lead_nextdoor_activity (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  activity_type TEXT,
  content_snippet TEXT,
  neighborhood TEXT,
  detected_keywords TEXT[],
  activity_url TEXT,
  relevance_score INTEGER,
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 12. GOOGLE SEARCH ACTIVITY (via ZenRows)
-- ============================================
CREATE TABLE IF NOT EXISTS lead_google_search_activity (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  search_location TEXT NOT NULL,
  search_terms TEXT[],
  detected_intent TEXT,
  search_patterns JSONB,
  scraped_via TEXT DEFAULT 'zenrows',
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 13. SOCIAL INTELLIGENCE (Facebook, Reddit, Craigslist)
-- ============================================
CREATE TABLE IF NOT EXISTS lead_social_intelligence (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  post_content TEXT,
  post_url TEXT,
  author_name TEXT,
  author_profile_url TEXT,
  posted_date TIMESTAMPTZ,
  detected_location TEXT,
  intent_keywords_matched TEXT[],
  ai_intent_score INTEGER,
  intent_summary TEXT,
  urgency_level TEXT,
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- 14. EXTERNAL BEHAVIOR (Zillow, Realtor, Redfin via ZenRows)
-- ============================================
CREATE TABLE IF NOT EXISTS lead_external_behavior (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  activity_type TEXT,
  property_addresses_viewed TEXT[],
  search_criteria_json JSONB,
  detected_via_zenrows BOOLEAN DEFAULT true,
  confidence_score INTEGER,
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INDEXES FOR PERFORMANCE
-- ============================================
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(lead_status);
CREATE INDEX IF NOT EXISTS idx_leads_source ON leads(lead_source);
CREATE INDEX IF NOT EXISTS idx_leads_assigned ON leads(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_leads_temperature ON leads(temperature);
CREATE INDEX IF NOT EXISTS idx_leads_motivation ON leads(motivation_score DESC);
CREATE INDEX IF NOT EXISTS idx_lead_intelligence_lead ON lead_intelligence(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_behavioral_data_lead ON lead_behavioral_data(lead_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_lead_property_searches_lead ON lead_property_searches(lead_id, scraped_at);
CREATE INDEX IF NOT EXISTS idx_lead_engagement_scores_lead ON lead_engagement_scores(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_idx_interactions_lead ON lead_idx_property_interactions(lead_id, interacted_at);
CREATE INDEX IF NOT EXISTS idx_lead_social_intelligence_lead ON lead_social_intelligence(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_external_behavior_lead ON lead_external_behavior(lead_id);
CREATE INDEX IF NOT EXISTS idx_lead_motivated_seller_lead ON lead_motivated_seller_signals(lead_id);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_intelligence ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_behavioral_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_property_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_osint_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_property_ownership ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_motivated_seller_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_people_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_engagement_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_idx_property_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_nextdoor_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_google_search_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_social_intelligence ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_external_behavior ENABLE ROW LEVEL SECURITY;

-- RLS Policies for leads table
CREATE POLICY "leads_admin_broker_all" ON leads FOR ALL 
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role IN ('admin', 'broker')));

CREATE POLICY "leads_agents_assigned" ON leads FOR SELECT 
  USING (assigned_agent_id = auth.uid());

CREATE POLICY "leads_service_role" ON leads FOR ALL 
  USING (auth.jwt() ->> 'role' = 'service_role');

-- RLS Policies for lead_intelligence
CREATE POLICY "lead_intelligence_admin_broker" ON lead_intelligence FOR ALL 
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role IN ('admin', 'broker')));
CREATE POLICY "lead_intelligence_service" ON lead_intelligence FOR ALL 
  USING (auth.jwt() ->> 'role' = 'service_role');

-- RLS Policies for lead_behavioral_data
CREATE POLICY "lead_behavioral_data_admin_broker" ON lead_behavioral_data FOR ALL 
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role IN ('admin', 'broker')));
CREATE POLICY "lead_behavioral_data_service" ON lead_behavioral_data FOR ALL 
  USING (auth.jwt() ->> 'role' = 'service_role');

-- RLS Policies for lead_property_searches
CREATE POLICY "lead_property_searches_admin_broker" ON lead_property_searches FOR ALL 
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role IN ('admin', 'broker')));
CREATE POLICY "lead_property_searches_service" ON lead_property_searches FOR ALL 
  USING (auth.jwt() ->> 'role' = 'service_role');

-- RLS Policies for lead_osint_data
CREATE POLICY "lead_osint_data_admin_broker" ON lead_osint_data FOR ALL 
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role IN ('admin', 'broker')));
CREATE POLICY "lead_osint_data_service" ON lead_osint_data FOR ALL 
  USING (auth.jwt() ->> 'role' = 'service_role');

-- RLS Policies for lead_property_ownership
CREATE POLICY "lead_property_ownership_admin_broker" ON lead_property_ownership FOR ALL 
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role IN ('admin', 'broker')));
CREATE POLICY "lead_property_ownership_service" ON lead_property_ownership FOR ALL 
  USING (auth.jwt() ->> 'role' = 'service_role');

-- RLS Policies for lead_motivated_seller_signals
CREATE POLICY "lead_motivated_seller_signals_admin_broker" ON lead_motivated_seller_signals FOR ALL 
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role IN ('admin', 'broker')));
CREATE POLICY "lead_motivated_seller_signals_service" ON lead_motivated_seller_signals FOR ALL 
  USING (auth.jwt() ->> 'role' = 'service_role');

-- RLS Policies for lead_people_data
CREATE POLICY "lead_people_data_admin_broker" ON lead_people_data FOR ALL 
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role IN ('admin', 'broker')));
CREATE POLICY "lead_people_data_service" ON lead_people_data FOR ALL 
  USING (auth.jwt() ->> 'role' = 'service_role');

-- RLS Policies for lead_engagement_scores
CREATE POLICY "lead_engagement_scores_admin_broker" ON lead_engagement_scores FOR ALL 
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role IN ('admin', 'broker')));
CREATE POLICY "lead_engagement_scores_service" ON lead_engagement_scores FOR ALL 
  USING (auth.jwt() ->> 'role' = 'service_role');

-- RLS Policies for lead_idx_property_interactions
CREATE POLICY "lead_idx_interactions_admin_broker" ON lead_idx_property_interactions FOR ALL 
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role IN ('admin', 'broker')));
CREATE POLICY "lead_idx_interactions_service" ON lead_idx_property_interactions FOR ALL 
  USING (auth.jwt() ->> 'role' = 'service_role');

-- RLS Policies for lead_nextdoor_activity
CREATE POLICY "lead_nextdoor_activity_admin_broker" ON lead_nextdoor_activity FOR ALL 
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role IN ('admin', 'broker')));
CREATE POLICY "lead_nextdoor_activity_service" ON lead_nextdoor_activity FOR ALL 
  USING (auth.jwt() ->> 'role' = 'service_role');

-- RLS Policies for lead_google_search_activity
CREATE POLICY "lead_google_search_activity_admin_broker" ON lead_google_search_activity FOR ALL 
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role IN ('admin', 'broker')));
CREATE POLICY "lead_google_search_activity_service" ON lead_google_search_activity FOR ALL 
  USING (auth.jwt() ->> 'role' = 'service_role');

-- RLS Policies for lead_social_intelligence
CREATE POLICY "lead_social_intelligence_admin_broker" ON lead_social_intelligence FOR ALL 
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role IN ('admin', 'broker')));
CREATE POLICY "lead_social_intelligence_service" ON lead_social_intelligence FOR ALL 
  USING (auth.jwt() ->> 'role' = 'service_role');

-- RLS Policies for lead_external_behavior
CREATE POLICY "lead_external_behavior_admin_broker" ON lead_external_behavior FOR ALL 
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.role IN ('admin', 'broker')));
CREATE POLICY "lead_external_behavior_service" ON lead_external_behavior FOR ALL 
  USING (auth.jwt() ->> 'role' = 'service_role');
