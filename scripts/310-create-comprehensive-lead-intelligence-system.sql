-- Comprehensive Lead Intelligence System
-- Adds 11 tables for OSINT, behavioral tracking, property intelligence, and engagement scoring

-- 1. Lead Intelligence Profiles (main table)
CREATE TABLE IF NOT EXISTS lead_intelligence (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES contacts(id) ON DELETE CASCADE UNIQUE,
  buyer_seller_type TEXT CHECK (buyer_seller_type IN ('buyer', 'seller', 'both', 'investor')),
  identified_interests JSONB DEFAULT '[]'::jsonb,
  property_preferences JSONB DEFAULT '{}'::jsonb,
  price_range TEXT,
  property_type TEXT[] DEFAULT ARRAY[]::TEXT[],
  location_preferences TEXT[] DEFAULT ARRAY[]::TEXT[],
  timeline TEXT CHECK (timeline IN ('immediate', '1-3_months', '3-6_months', '6-12_months', 'researching')),
  motivation_score INTEGER DEFAULT 0 CHECK (motivation_score >= 0 AND motivation_score <= 100),
  qualification_score INTEGER DEFAULT 0 CHECK (qualification_score >= 0 AND qualification_score <= 100),
  data_sources JSONB DEFAULT '[]'::jsonb,
  last_enriched_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Behavioral Data Tracking
CREATE TABLE IF NOT EXISTS lead_behavioral_data (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL CHECK (event_type IN ('property_view', 'search', 'email_open', 'link_click', 'form_fill', 'call', 'sms', 'chat_message', 'property_save', 'showing_request', 'offer_submitted')),
  event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  event_source TEXT CHECK (event_source IN ('website', 'email', 'idx_broker', 'ghl', 'manual', 'chat')),
  engagement_score_delta INTEGER DEFAULT 0,
  occurred_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Property Search History (from OSINT/scraping)
CREATE TABLE IF NOT EXISTS lead_property_searches (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  search_source TEXT NOT NULL CHECK (search_source IN ('zillow', 'realtor_com', 'redfin', 'nextdoor', 'google', 'idx_broker')),
  search_query TEXT,
  search_location TEXT,
  properties_viewed JSONB[] DEFAULT ARRAY[]::JSONB[],
  search_criteria JSONB DEFAULT '{}'::jsonb,
  detected_via TEXT CHECK (detected_via IN ('zenrows_scrape', 'osint', 'behavioral_tracking', 'idx_broker')),
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 4. OSINT Data Collection
CREATE TABLE IF NOT EXISTS lead_osint_data (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  data_type TEXT NOT NULL CHECK (data_type IN ('social_profile', 'public_record', 'online_activity', 'property_ownership', 'business_listing', 'news_mention')),
  data_source TEXT NOT NULL,
  data_content JSONB NOT NULL DEFAULT '{}'::jsonb,
  confidence_score DECIMAL(3,2) CHECK (confidence_score >= 0.00 AND confidence_score <= 1.00),
  collected_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Property Ownership Data (from BatchData/public records)
CREATE TABLE IF NOT EXISTS lead_property_ownership (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  property_address TEXT NOT NULL,
  property_details JSONB DEFAULT '{}'::jsonb,
  estimated_value INTEGER,
  equity_estimate INTEGER,
  mortgage_data JSONB DEFAULT '{}'::jsonb,
  purchase_date DATE,
  ownership_length_months INTEGER,
  property_tax DECIMAL(10,2),
  is_primary_residence BOOLEAN DEFAULT true,
  motivation_indicators JSONB DEFAULT '{}'::jsonb,
  data_source TEXT CHECK (data_source IN ('batchdata', 'public_records', 'atomdata', 'manual')),
  last_updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 6. Motivated Seller Signals
CREATE TABLE IF NOT EXISTS motivated_seller_signals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  signal_type TEXT NOT NULL CHECK (signal_type IN ('financial_distress', 'life_event', 'property_condition', 'market_timing', 'vacancy', 'high_equity')),
  signal_details JSONB NOT NULL DEFAULT '{}'::jsonb,
  signal_strength TEXT CHECK (signal_strength IN ('weak', 'moderate', 'strong', 'urgent')),
  detected_via TEXT CHECK (detected_via IN ('batchdata', 'public_records', 'osint', 'behavioral', 'peopledata')),
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 7. People Data Enrichment (from PeopleData/BatchData)
CREATE TABLE IF NOT EXISTS lead_people_data (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  demographic_data JSONB DEFAULT '{}'::jsonb,
  employment_data JSONB DEFAULT '{}'::jsonb,
  financial_indicators JSONB DEFAULT '{}'::jsonb,
  life_events JSONB DEFAULT '[]'::jsonb,
  social_presence JSONB DEFAULT '{}'::jsonb,
  contact_enrichment JSONB DEFAULT '{}'::jsonb,
  data_source TEXT CHECK (data_source IN ('peopledata', 'batchdata', 'atomdata', 'clearbit')),
  enriched_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 8. Engagement Scoring
CREATE TABLE IF NOT EXISTS lead_engagement_scores (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES contacts(id) ON DELETE CASCADE UNIQUE,
  overall_score INTEGER DEFAULT 0 CHECK (overall_score >= 0 AND overall_score <= 100),
  email_engagement_score INTEGER DEFAULT 0 CHECK (email_engagement_score >= 0 AND email_engagement_score <= 100),
  property_view_score INTEGER DEFAULT 0 CHECK (property_view_score >= 0 AND property_view_score <= 100),
  communication_score INTEGER DEFAULT 0 CHECK (communication_score >= 0 AND communication_score <= 100),
  search_activity_score INTEGER DEFAULT 0 CHECK (search_activity_score >= 0 AND search_activity_score <= 100),
  recency_score INTEGER DEFAULT 0 CHECK (recency_score >= 0 AND recency_score <= 100),
  frequency_score INTEGER DEFAULT 0 CHECK (frequency_score >= 0 AND frequency_score <= 100),
  last_calculated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 9. IDX Broker Property Interactions
CREATE TABLE IF NOT EXISTS idx_property_interactions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  property_mls_id TEXT NOT NULL,
  property_address TEXT,
  property_details JSONB DEFAULT '{}'::jsonb,
  interaction_type TEXT NOT NULL CHECK (interaction_type IN ('viewed', 'saved', 'shared', 'requested_showing', 'clicked', 'favorited')),
  time_spent_seconds INTEGER DEFAULT 0,
  referrer_url TEXT,
  interaction_metadata JSONB DEFAULT '{}'::jsonb,
  interacted_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 10. Scraped Nextdoor Activity
CREATE TABLE IF NOT EXISTS nextdoor_activity (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  activity_type TEXT CHECK (activity_type IN ('post', 'comment', 'recommendation', 'question')),
  content_snippet TEXT,
  neighborhood TEXT,
  detected_keywords TEXT[] DEFAULT ARRAY[]::TEXT[],
  activity_url TEXT,
  relevance_score INTEGER DEFAULT 0 CHECK (relevance_score >= 0 AND relevance_score <= 100),
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 11. Google Search Activity (via Zenrows)
CREATE TABLE IF NOT EXISTS google_search_activity (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  search_location TEXT NOT NULL,
  search_terms TEXT[] DEFAULT ARRAY[]::TEXT[],
  detected_intent TEXT CHECK (detected_intent IN ('buying', 'selling', 'valuation', 'agent_search', 'market_research', 'refinance')),
  search_patterns JSONB DEFAULT '{}'::jsonb,
  scraped_via TEXT DEFAULT 'zenrows',
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance Indexes
CREATE INDEX IF NOT EXISTS idx_lead_intelligence_lead ON lead_intelligence(lead_id);
CREATE INDEX IF NOT EXISTS idx_behavioral_data_lead_occurred ON lead_behavioral_data(lead_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_property_searches_lead_scraped ON lead_property_searches(lead_id, scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_osint_data_lead ON lead_osint_data(lead_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_property_ownership_lead ON lead_property_ownership(lead_id);
CREATE INDEX IF NOT EXISTS idx_motivated_signals_lead ON motivated_seller_signals(lead_id, signal_strength);
CREATE INDEX IF NOT EXISTS idx_people_data_lead ON lead_people_data(lead_id);
CREATE INDEX IF NOT EXISTS idx_engagement_scores_lead ON lead_engagement_scores(lead_id);
CREATE INDEX IF NOT EXISTS idx_idx_interactions_lead_time ON idx_property_interactions(lead_id, interacted_at DESC);
CREATE INDEX IF NOT EXISTS idx_nextdoor_activity_lead ON nextdoor_activity(lead_id, scraped_at DESC);
CREATE INDEX IF NOT EXISTS idx_google_search_lead ON google_search_activity(lead_id, scraped_at DESC);

-- Row Level Security Policies
ALTER TABLE lead_intelligence ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_behavioral_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_property_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_osint_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_property_ownership ENABLE ROW LEVEL SECURITY;
ALTER TABLE motivated_seller_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_people_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_engagement_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE idx_property_interactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE nextdoor_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE google_search_activity ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Agents see their own leads, Admins see all
CREATE POLICY "Users can view intelligence for their contacts"
  ON lead_intelligence FOR SELECT
  USING (
    lead_id IN (
      SELECT id FROM contacts 
      WHERE agent_id = auth.uid() OR EXISTS (
        SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin', 'broker')
      )
    )
  );

CREATE POLICY "Users can view behavioral data for their contacts"
  ON lead_behavioral_data FOR SELECT
  USING (
    lead_id IN (
      SELECT id FROM contacts 
      WHERE agent_id = auth.uid() OR EXISTS (
        SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin', 'broker')
      )
    )
  );

-- Apply similar policies to all other intelligence tables
CREATE POLICY "intelligence_policy" ON lead_property_searches FOR ALL USING (
  lead_id IN (SELECT id FROM contacts WHERE agent_id = auth.uid() OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin', 'broker')))
);

CREATE POLICY "intelligence_policy" ON lead_osint_data FOR ALL USING (
  lead_id IN (SELECT id FROM contacts WHERE agent_id = auth.uid() OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin', 'broker')))
);

CREATE POLICY "intelligence_policy" ON lead_property_ownership FOR ALL USING (
  lead_id IN (SELECT id FROM contacts WHERE agent_id = auth.uid() OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin', 'broker')))
);

CREATE POLICY "intelligence_policy" ON motivated_seller_signals FOR ALL USING (
  lead_id IN (SELECT id FROM contacts WHERE agent_id = auth.uid() OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin', 'broker')))
);

CREATE POLICY "intelligence_policy" ON lead_people_data FOR ALL USING (
  lead_id IN (SELECT id FROM contacts WHERE agent_id = auth.uid() OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin', 'broker')))
);

CREATE POLICY "intelligence_policy" ON lead_engagement_scores FOR ALL USING (
  lead_id IN (SELECT id FROM contacts WHERE agent_id = auth.uid() OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin', 'broker')))
);

CREATE POLICY "intelligence_policy" ON idx_property_interactions FOR ALL USING (
  lead_id IN (SELECT id FROM contacts WHERE agent_id = auth.uid() OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin', 'broker')))
);

CREATE POLICY "intelligence_policy" ON nextdoor_activity FOR ALL USING (
  lead_id IN (SELECT id FROM contacts WHERE agent_id = auth.uid() OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin', 'broker')))
);

CREATE POLICY "intelligence_policy" ON google_search_activity FOR ALL USING (
  lead_id IN (SELECT id FROM contacts WHERE agent_id = auth.uid() OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND role IN ('admin', 'broker')))
);

COMMIT;
