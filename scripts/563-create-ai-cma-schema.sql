-- AI CMA (Comparative Market Analysis) System Schema
-- Creates tables for CMA reports and price adjustment tracking

-- CMA Reports Table
CREATE TABLE IF NOT EXISTS cma_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES auth.users(id),
  contact_id UUID REFERENCES contacts(id),
  property_address TEXT NOT NULL,
  property_city TEXT NOT NULL,
  property_state TEXT NOT NULL,
  property_zip TEXT,
  property_type TEXT NOT NULL,
  bedrooms INTEGER,
  bathrooms NUMERIC,
  square_feet INTEGER,
  lot_size INTEGER,
  year_built INTEGER,
  features JSONB DEFAULT '[]',
  condition TEXT,
  listing_type TEXT NOT NULL, -- 'seller' or 'buyer'
  comparables JSONB DEFAULT '[]',
  market_trends JSONB DEFAULT '{}',
  ai_valuation JSONB DEFAULT '{}',
  pricing_strategy JSONB DEFAULT '{}',
  presentation_content JSONB DEFAULT '{}',
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- CMA Price Adjustments Table
CREATE TABLE IF NOT EXISTS cma_price_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cma_id UUID REFERENCES cma_reports(id) ON DELETE CASCADE,
  current_price NUMERIC NOT NULL,
  recommended_price NUMERIC,
  recommendation JSONB DEFAULT '{}',
  days_on_market INTEGER,
  showing_count INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Market Data Table (for trend analysis)
CREATE TABLE IF NOT EXISTS market_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip_code TEXT,
  property_type TEXT,
  median_sale_price NUMERIC,
  avg_days_on_market INTEGER,
  active_listings INTEGER,
  price_per_sqft NUMERIC,
  recorded_date DATE NOT NULL,
  data_source TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_cma_reports_agent ON cma_reports(agent_id);
CREATE INDEX IF NOT EXISTS idx_cma_reports_contact ON cma_reports(contact_id);
CREATE INDEX IF NOT EXISTS idx_cma_reports_status ON cma_reports(status);
CREATE INDEX IF NOT EXISTS idx_cma_price_adjustments_cma ON cma_price_adjustments(cma_id);
CREATE INDEX IF NOT EXISTS idx_market_data_location ON market_data(city, state);
CREATE INDEX IF NOT EXISTS idx_market_data_date ON market_data(recorded_date);

-- Enable RLS
ALTER TABLE cma_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE cma_price_adjustments ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DROP POLICY IF EXISTS cma_reports_agent_policy ON cma_reports;
CREATE POLICY cma_reports_agent_policy ON cma_reports FOR ALL USING (agent_id = auth.uid());

DROP POLICY IF EXISTS cma_price_adjustments_policy ON cma_price_adjustments;
CREATE POLICY cma_price_adjustments_policy ON cma_price_adjustments FOR ALL 
  USING (cma_id IN (SELECT id FROM cma_reports WHERE agent_id = auth.uid()));
