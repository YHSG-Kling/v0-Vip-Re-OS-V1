-- Fix script for lead scraping config - only creates missing tables/policies
-- Skip policies that already exist

-- Create tables if they don't exist (the CREATE TABLE IF NOT EXISTS should be fine)
CREATE TABLE IF NOT EXISTS lead_scraping_markets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip_codes TEXT[],
  counties TEXT[],
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lead_scraping_keywords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  keyword TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('buying_intent', 'selling_intent', 'life_event', 'distress', 'custom')),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lead_scraping_property_params (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  market_id UUID REFERENCES lead_scraping_markets(id) ON DELETE CASCADE,
  min_price INTEGER,
  max_price INTEGER,
  min_bedrooms INTEGER,
  max_bedrooms INTEGER,
  min_bathrooms NUMERIC(3,1),
  max_bathrooms NUMERIC(3,1),
  property_types TEXT[],
  min_sqft INTEGER,
  max_sqft INTEGER,
  year_built_min INTEGER,
  year_built_max INTEGER,
  lot_size_min NUMERIC(10,2),
  lot_size_max NUMERIC(10,2),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lead_scraping_motivated_params (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  market_id UUID REFERENCES lead_scraping_markets(id) ON DELETE CASCADE,
  include_preforeclosure BOOLEAN DEFAULT true,
  include_divorce BOOLEAN DEFAULT true,
  include_probate BOOLEAN DEFAULT true,
  include_tax_lien BOOLEAN DEFAULT true,
  include_vacant BOOLEAN DEFAULT true,
  include_absentee_owner BOOLEAN DEFAULT true,
  include_high_equity BOOLEAN DEFAULT true,
  include_tired_landlord BOOLEAN DEFAULT true,
  min_equity_percent INTEGER DEFAULT 30,
  min_ownership_years INTEGER DEFAULT 5,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lead_scraping_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  market_id UUID REFERENCES lead_scraping_markets(id) ON DELETE SET NULL,
  job_type TEXT NOT NULL CHECK (job_type IN ('zillow', 'realtor', 'redfin', 'nextdoor', 'facebook', 'craigslist', 'batchdata', 'full_scrape')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  leads_found INTEGER DEFAULT 0,
  leads_enriched INTEGER DEFAULT 0,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes if they don't exist
CREATE INDEX IF NOT EXISTS idx_scraping_markets_brokerage ON lead_scraping_markets(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_scraping_keywords_category ON lead_scraping_keywords(category);
CREATE INDEX IF NOT EXISTS idx_scraping_jobs_status ON lead_scraping_jobs(status);
CREATE INDEX IF NOT EXISTS idx_scraping_jobs_created ON lead_scraping_jobs(created_at DESC);

-- Seed default keywords if table is empty
INSERT INTO lead_scraping_keywords (keyword, category) 
SELECT * FROM (VALUES
  ('looking to buy', 'buying_intent'),
  ('house hunting', 'buying_intent'),
  ('searching for a home', 'buying_intent'),
  ('first time buyer', 'buying_intent'),
  ('pre-approved mortgage', 'buying_intent'),
  ('relocating to', 'buying_intent'),
  ('moving to the area', 'buying_intent'),
  ('need a realtor', 'buying_intent'),
  ('thinking of selling', 'selling_intent'),
  ('selling my home', 'selling_intent'),
  ('need to sell quickly', 'selling_intent'),
  ('downsizing', 'selling_intent'),
  ('listing my house', 'selling_intent'),
  ('getting divorced', 'life_event'),
  ('just inherited', 'life_event'),
  ('new job', 'life_event'),
  ('having a baby', 'life_event'),
  ('retiring', 'life_event'),
  ('empty nest', 'life_event'),
  ('behind on mortgage', 'distress'),
  ('foreclosure help', 'distress'),
  ('cant afford payments', 'distress'),
  ('need to sell fast', 'distress')
) AS v(keyword, category)
WHERE NOT EXISTS (SELECT 1 FROM lead_scraping_keywords LIMIT 1);
