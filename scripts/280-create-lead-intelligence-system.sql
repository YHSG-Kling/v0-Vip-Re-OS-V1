-- Lead Intelligence System Database Schema
-- Behavioral tracking, property intelligence, social signals, and unified lead profiles

-- 1. BEHAVIORAL INTENT TRACKING
CREATE TABLE IF NOT EXISTS behavioral_signals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id UUID NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  session_id TEXT,
  first_seen_date TIMESTAMPTZ DEFAULT NOW(),
  last_seen_date TIMESTAMPTZ DEFAULT NOW(),
  total_sessions INTEGER DEFAULT 1,
  identified BOOLEAN DEFAULT FALSE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  intent_type TEXT CHECK (intent_type IN ('buyer', 'seller', 'both', 'investor', 'unknown')) DEFAULT 'unknown',
  intent_confidence_score INTEGER CHECK (intent_confidence_score >= 0 AND intent_confidence_score <= 100) DEFAULT 0,
  city TEXT,
  state TEXT,
  zip TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_behavioral_signals_visitor ON behavioral_signals(visitor_id);
CREATE INDEX IF NOT EXISTS idx_behavioral_signals_contact ON behavioral_signals(contact_id);
CREATE INDEX IF NOT EXISTS idx_behavioral_signals_intent ON behavioral_signals(intent_type, intent_confidence_score);

-- Site activity tracking
CREATE TABLE IF NOT EXISTS site_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  behavioral_signal_id UUID REFERENCES behavioral_signals(id) ON DELETE CASCADE,
  page_visited TEXT NOT NULL,
  time_on_page_seconds INTEGER DEFAULT 0,
  action_taken TEXT,
  search_terms TEXT[],
  price_range_viewed JSONB,
  neighborhoods_viewed TEXT[],
  property_types_viewed TEXT[],
  timestamp TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_site_activity_signal ON site_activity(behavioral_signal_id);
CREATE INDEX IF NOT EXISTS idx_site_activity_timestamp ON site_activity(timestamp DESC);

-- External behavior (Zillow, Realtor.com, etc.)
CREATE TABLE IF NOT EXISTS external_behavior (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  behavioral_signal_id UUID REFERENCES behavioral_signals(id) ON DELETE CASCADE,
  source TEXT CHECK (source IN ('zillow', 'realtor', 'redfin', 'trulia', 'nextdoor', 'other')),
  activity_type TEXT,
  detected_via_zenrows BOOLEAN DEFAULT FALSE,
  property_addresses_viewed TEXT[],
  search_criteria_json JSONB,
  scraped_at TIMESTAMPTZ DEFAULT NOW(),
  confidence_score INTEGER CHECK (confidence_score >= 0 AND confidence_score <= 100) DEFAULT 50
);

CREATE INDEX IF NOT EXISTS idx_external_behavior_signal ON external_behavior(behavioral_signal_id);
CREATE INDEX IF NOT EXISTS idx_external_behavior_source ON external_behavior(source);

-- 2. PROPERTY INTELLIGENCE
CREATE TABLE IF NOT EXISTS property_intelligence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_address TEXT NOT NULL,
  owner_name TEXT,
  owner_mailing_address TEXT,
  owner_phone TEXT,
  owner_email TEXT,
  years_owned INTEGER,
  purchase_price DECIMAL(12,2),
  current_value_estimate DECIMAL(12,2),
  equity_amount DECIMAL(12,2),
  mortgage_balance DECIMAL(12,2),
  mortgage_rate DECIMAL(5,3),
  property_type TEXT,
  beds INTEGER,
  baths DECIMAL(3,1),
  sqft INTEGER,
  lot_size DECIMAL(10,2),
  last_sale_date DATE,
  tax_amount DECIMAL(12,2),
  tax_delinquent BOOLEAN DEFAULT FALSE,
  liens BOOLEAN DEFAULT FALSE,
  foreclosure_status TEXT,
  hoa BOOLEAN DEFAULT FALSE,
  building_age INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_property_intelligence_address ON property_intelligence(property_address);
CREATE INDEX IF NOT EXISTS idx_property_intelligence_owner ON property_intelligence(owner_name);

-- Motivated seller scores
CREATE TABLE IF NOT EXISTS motivated_seller_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID REFERENCES property_intelligence(id) ON DELETE CASCADE,
  batchdata_motivation_score INTEGER CHECK (batchdata_motivation_score >= 0 AND batchdata_motivation_score <= 100),
  motivation_factors TEXT[],
  readiness_to_sell_score INTEGER CHECK (readiness_to_sell_score >= 0 AND readiness_to_sell_score <= 100),
  predicted_timeframe TEXT CHECK (predicted_timeframe IN ('immediate', '3months', '6months', '12months', 'unknown')),
  life_event_signals TEXT[],
  property_condition_signals TEXT[],
  financial_pressure_indicators TEXT[],
  market_timing_factors TEXT[],
  score_updated_at TIMESTAMPTZ DEFAULT NOW(),
  data_source TEXT DEFAULT 'calculated'
);

CREATE INDEX IF NOT EXISTS idx_motivated_seller_property ON motivated_seller_scores(property_id);
CREATE INDEX IF NOT EXISTS idx_motivated_seller_score ON motivated_seller_scores(readiness_to_sell_score DESC);

-- Owner demographics
CREATE TABLE IF NOT EXISTS owner_demographics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID REFERENCES property_intelligence(id) ON DELETE CASCADE,
  owner_age INTEGER,
  estimated_income_range TEXT,
  family_size INTEGER,
  occupation TEXT,
  length_of_residence INTEGER,
  mobility_indicators TEXT[],
  credit_score_range TEXT,
  homeowner_type TEXT CHECK (homeowner_type IN ('primary', 'investor', 'second_home')),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. SOCIAL & OSINT SIGNALS
CREATE TABLE IF NOT EXISTS social_intelligence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  source TEXT CHECK (source IN ('facebook', 'reddit', 'nextdoor', 'craigslist', 'google', 'other')),
  post_content TEXT,
  post_url TEXT,
  author_name TEXT,
  author_profile_url TEXT,
  posted_date TIMESTAMPTZ,
  detected_location TEXT,
  intent_keywords_matched TEXT[],
  ai_intent_score INTEGER CHECK (ai_intent_score >= 0 AND ai_intent_score <= 100),
  intent_summary TEXT,
  urgency_level TEXT CHECK (urgency_level IN ('low', 'medium', 'high', 'urgent')) DEFAULT 'medium',
  scraped_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_social_intelligence_contact ON social_intelligence(contact_id);
CREATE INDEX IF NOT EXISTS idx_social_intelligence_source ON social_intelligence(source);
CREATE INDEX IF NOT EXISTS idx_social_intelligence_score ON social_intelligence(ai_intent_score DESC);

-- 4. UNIFIED LEAD PROFILES
CREATE TABLE IF NOT EXISTS unified_lead_profile (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  lead_source TEXT,
  confidence_score INTEGER CHECK (confidence_score >= 0 AND confidence_score <= 100) DEFAULT 0,
  intent_type TEXT CHECK (intent_type IN ('buyer', 'seller', 'investor', 'both')) DEFAULT 'buyer',
  intent_strength TEXT CHECK (intent_strength IN ('browsing', 'researching', 'active', 'urgent')) DEFAULT 'browsing',
  primary_location TEXT,
  property_address_of_interest TEXT,
  estimated_timeline TEXT,
  motivation_summary TEXT,
  total_intelligence_signals INTEGER DEFAULT 0,
  first_detected_date TIMESTAMPTZ DEFAULT NOW(),
  last_signal_date TIMESTAMPTZ DEFAULT NOW(),
  ready_for_outreach BOOLEAN DEFAULT FALSE,
  outreach_status TEXT DEFAULT 'not_contacted',
  temperature TEXT CHECK (temperature IN ('cold', 'warm', 'hot')) DEFAULT 'cold',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_unified_lead_contact ON unified_lead_profile(contact_id);
CREATE INDEX IF NOT EXISTS idx_unified_lead_confidence ON unified_lead_profile(confidence_score DESC);
CREATE INDEX IF NOT EXISTS idx_unified_lead_temperature ON unified_lead_profile(temperature);

-- Intelligence signals log
CREATE TABLE IF NOT EXISTS intelligence_signals_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_profile_id UUID REFERENCES unified_lead_profile(id) ON DELETE CASCADE,
  signal_type TEXT,
  signal_data_json JSONB,
  signal_strength INTEGER CHECK (signal_strength >= 1 AND signal_strength <= 10) DEFAULT 5,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  source_url TEXT
);

CREATE INDEX IF NOT EXISTS idx_intelligence_log_profile ON intelligence_signals_log(lead_profile_id);
CREATE INDEX IF NOT EXISTS idx_intelligence_log_date ON intelligence_signals_log(detected_at DESC);

-- 5. TARGET LOCATIONS
CREATE TABLE IF NOT EXISTS target_locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_type TEXT CHECK (location_type IN ('zip', 'city', 'neighborhood', 'county')),
  location_name TEXT NOT NULL,
  state TEXT NOT NULL,
  priority INTEGER CHECK (priority >= 1 AND priority <= 5) DEFAULT 3,
  agent_coverage TEXT[],
  active_campaigns TEXT[],
  target_buyer_profiles JSONB,
  target_seller_profiles JSONB,
  market_conditions_json JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_target_locations_priority ON target_locations(priority DESC);

-- Location search terms
CREATE TABLE IF NOT EXISTS location_search_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target_location_id UUID REFERENCES target_locations(id) ON DELETE CASCADE,
  term_category TEXT CHECK (term_category IN ('buyer_intent', 'seller_intent', 'market_research')),
  search_term TEXT NOT NULL,
  search_volume INTEGER,
  competition TEXT,
  intent_score INTEGER CHECK (intent_score >= 0 AND intent_score <= 100),
  last_updated TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on all tables
ALTER TABLE behavioral_signals ENABLE ROW LEVEL SECURITY;
ALTER TABLE site_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE external_behavior ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_intelligence ENABLE ROW LEVEL SECURITY;
ALTER TABLE motivated_seller_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE owner_demographics ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_intelligence ENABLE ROW LEVEL SECURITY;
ALTER TABLE unified_lead_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE intelligence_signals_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE target_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE location_search_terms ENABLE ROW LEVEL SECURITY;

-- RLS Policies (Allow service role full access)
CREATE POLICY "Service role can manage behavioral_signals" ON behavioral_signals FOR ALL USING (true);
CREATE POLICY "Service role can manage site_activity" ON site_activity FOR ALL USING (true);
CREATE POLICY "Service role can manage external_behavior" ON external_behavior FOR ALL USING (true);
CREATE POLICY "Service role can manage property_intelligence" ON property_intelligence FOR ALL USING (true);
CREATE POLICY "Service role can manage motivated_seller_scores" ON motivated_seller_scores FOR ALL USING (true);
CREATE POLICY "Service role can manage owner_demographics" ON owner_demographics FOR ALL USING (true);
CREATE POLICY "Service role can manage social_intelligence" ON social_intelligence FOR ALL USING (true);
CREATE POLICY "Service role can manage unified_lead_profile" ON unified_lead_profile FOR ALL USING (true);
CREATE POLICY "Service role can manage intelligence_signals_log" ON intelligence_signals_log FOR ALL USING (true);
CREATE POLICY "Service role can manage target_locations" ON target_locations FOR ALL USING (true);
CREATE POLICY "Service role can manage location_search_terms" ON location_search_terms FOR ALL USING (true);
