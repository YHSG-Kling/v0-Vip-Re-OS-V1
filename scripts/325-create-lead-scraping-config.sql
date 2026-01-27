-- Lead Scraping Configuration Tables
-- Stores markets, keywords, and property search parameters for automated scraping

-- Scraping configuration for markets/locations
CREATE TABLE IF NOT EXISTS lead_scraping_markets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip_codes TEXT[], -- Array of zip codes to target
  counties TEXT[], -- Array of counties
  radius_miles INTEGER DEFAULT 25,
  is_active BOOLEAN DEFAULT true,
  priority INTEGER DEFAULT 1, -- Higher = more frequent scraping
  last_scraped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Keywords configuration for social/forum scraping
CREATE TABLE IF NOT EXISTS lead_scraping_keywords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword TEXT NOT NULL,
  category TEXT NOT NULL, -- 'buying_intent', 'selling_intent', 'life_event', 'distress'
  weight INTEGER DEFAULT 1, -- Higher weight = stronger signal
  is_active BOOLEAN DEFAULT true,
  sources TEXT[] DEFAULT ARRAY['nextdoor', 'facebook', 'reddit', 'craigslist'],
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Property search parameters for ZenRows buyer detection
CREATE TABLE IF NOT EXISTS lead_scraping_property_params (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id UUID REFERENCES lead_scraping_markets(id) ON DELETE CASCADE,
  min_price INTEGER,
  max_price INTEGER,
  min_beds INTEGER,
  max_beds INTEGER,
  min_baths INTEGER,
  max_baths INTEGER,
  property_types TEXT[] DEFAULT ARRAY['single_family', 'condo', 'townhouse'],
  target_sites TEXT[] DEFAULT ARRAY['zillow', 'realtor', 'redfin', 'trulia'],
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- BatchData motivated seller parameters
CREATE TABLE IF NOT EXISTS lead_scraping_motivated_params (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market_id UUID REFERENCES lead_scraping_markets(id) ON DELETE CASCADE,
  motivation_types TEXT[] DEFAULT ARRAY['pre_foreclosure', 'divorce', 'probate', 'tax_lien', 'vacant', 'absentee_owner', 'high_equity', 'tired_landlord'],
  min_equity_percent INTEGER DEFAULT 30,
  max_days_on_market INTEGER,
  include_expired_listings BOOLEAN DEFAULT true,
  include_fsbo BOOLEAN DEFAULT true,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Scraping job history/logs
CREATE TABLE IF NOT EXISTS lead_scraping_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_type TEXT NOT NULL, -- 'property_search', 'social_scrape', 'motivated_sellers'
  market_id UUID REFERENCES lead_scraping_markets(id),
  source TEXT NOT NULL, -- 'zillow', 'nextdoor', 'batchdata', etc.
  status TEXT DEFAULT 'pending', -- 'pending', 'running', 'completed', 'failed'
  leads_found INTEGER DEFAULT 0,
  leads_created INTEGER DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed default keywords
INSERT INTO lead_scraping_keywords (keyword, category, weight, sources) VALUES
  -- Buying intent
  ('looking to buy', 'buying_intent', 3, ARRAY['nextdoor', 'facebook', 'reddit']),
  ('house hunting', 'buying_intent', 3, ARRAY['nextdoor', 'facebook', 'reddit']),
  ('searching for a home', 'buying_intent', 3, ARRAY['nextdoor', 'facebook', 'reddit']),
  ('realtor recommendations', 'buying_intent', 2, ARRAY['nextdoor', 'facebook']),
  ('first time buyer', 'buying_intent', 3, ARRAY['nextdoor', 'facebook', 'reddit']),
  ('pre-approved mortgage', 'buying_intent', 4, ARRAY['nextdoor', 'facebook']),
  ('relocating to', 'buying_intent', 3, ARRAY['nextdoor', 'facebook', 'reddit']),
  
  -- Selling intent
  ('thinking of selling', 'selling_intent', 4, ARRAY['nextdoor', 'facebook']),
  ('selling my home', 'selling_intent', 4, ARRAY['nextdoor', 'facebook', 'craigslist']),
  ('how much is my house worth', 'selling_intent', 3, ARRAY['nextdoor', 'facebook']),
  ('need to sell quickly', 'selling_intent', 5, ARRAY['nextdoor', 'facebook', 'craigslist']),
  ('downsizing', 'selling_intent', 3, ARRAY['nextdoor', 'facebook']),
  ('listing agent', 'selling_intent', 2, ARRAY['nextdoor', 'facebook']),
  
  -- Life events (motivated sellers)
  ('getting divorced', 'life_event', 5, ARRAY['nextdoor', 'facebook', 'reddit']),
  ('inherited property', 'life_event', 5, ARRAY['nextdoor', 'facebook', 'reddit']),
  ('job relocation', 'life_event', 4, ARRAY['nextdoor', 'facebook', 'reddit']),
  ('retiring and moving', 'life_event', 4, ARRAY['nextdoor', 'facebook']),
  ('empty nesters', 'life_event', 3, ARRAY['nextdoor', 'facebook']),
  ('growing family', 'life_event', 3, ARRAY['nextdoor', 'facebook']),
  
  -- Distress signals
  ('behind on mortgage', 'distress', 5, ARRAY['reddit', 'facebook']),
  ('foreclosure help', 'distress', 5, ARRAY['reddit', 'facebook']),
  ('can''t afford payments', 'distress', 5, ARRAY['reddit']),
  ('need to sell fast', 'distress', 4, ARRAY['nextdoor', 'facebook', 'craigslist']),
  ('tax lien', 'distress', 5, ARRAY['reddit'])
ON CONFLICT DO NOTHING;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_scraping_markets_active ON lead_scraping_markets(is_active);
CREATE INDEX IF NOT EXISTS idx_scraping_keywords_category ON lead_scraping_keywords(category);
CREATE INDEX IF NOT EXISTS idx_scraping_jobs_status ON lead_scraping_jobs(status);
CREATE INDEX IF NOT EXISTS idx_scraping_jobs_market ON lead_scraping_jobs(market_id);

-- RLS Policies (Admin only)
ALTER TABLE lead_scraping_markets ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_scraping_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_scraping_property_params ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_scraping_motivated_params ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_scraping_jobs ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role manages scraping config" ON lead_scraping_markets FOR ALL TO service_role USING (true);
CREATE POLICY "Service role manages keywords" ON lead_scraping_keywords FOR ALL TO service_role USING (true);
CREATE POLICY "Service role manages property params" ON lead_scraping_property_params FOR ALL TO service_role USING (true);
CREATE POLICY "Service role manages motivated params" ON lead_scraping_motivated_params FOR ALL TO service_role USING (true);
CREATE POLICY "Service role manages scraping jobs" ON lead_scraping_jobs FOR ALL TO service_role USING (true);
