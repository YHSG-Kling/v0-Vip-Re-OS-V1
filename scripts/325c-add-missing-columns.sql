-- Add missing columns to lead_scraping_markets if they don't exist
DO $$
BEGIN
    -- Add brokerage_id if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'lead_scraping_markets' AND column_name = 'brokerage_id') THEN
        ALTER TABLE lead_scraping_markets ADD COLUMN brokerage_id UUID;
    END IF;
    
    -- Add name if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'lead_scraping_markets' AND column_name = 'name') THEN
        ALTER TABLE lead_scraping_markets ADD COLUMN name TEXT;
    END IF;
    
    -- Add city if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'lead_scraping_markets' AND column_name = 'city') THEN
        ALTER TABLE lead_scraping_markets ADD COLUMN city TEXT;
    END IF;
    
    -- Add state if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'lead_scraping_markets' AND column_name = 'state') THEN
        ALTER TABLE lead_scraping_markets ADD COLUMN state TEXT;
    END IF;
    
    -- Add zip_codes if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'lead_scraping_markets' AND column_name = 'zip_codes') THEN
        ALTER TABLE lead_scraping_markets ADD COLUMN zip_codes TEXT[];
    END IF;
    
    -- Add radius_miles if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'lead_scraping_markets' AND column_name = 'radius_miles') THEN
        ALTER TABLE lead_scraping_markets ADD COLUMN radius_miles INTEGER DEFAULT 25;
    END IF;
    
    -- Add is_active if it doesn't exist
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns 
                   WHERE table_name = 'lead_scraping_markets' AND column_name = 'is_active') THEN
        ALTER TABLE lead_scraping_markets ADD COLUMN is_active BOOLEAN DEFAULT true;
    END IF;
END $$;

-- Create lead_scraping_keywords table if it doesn't exist
CREATE TABLE IF NOT EXISTS lead_scraping_keywords (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brokerage_id UUID,
    keyword TEXT NOT NULL,
    category TEXT NOT NULL CHECK (category IN ('buyer_intent', 'seller_intent', 'life_event', 'distress')),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create lead_scraping_property_params table if it doesn't exist
CREATE TABLE IF NOT EXISTS lead_scraping_property_params (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brokerage_id UUID,
    market_id UUID REFERENCES lead_scraping_markets(id) ON DELETE CASCADE,
    min_price INTEGER,
    max_price INTEGER,
    min_beds INTEGER,
    max_beds INTEGER,
    min_baths INTEGER,
    max_baths INTEGER,
    property_types TEXT[] DEFAULT ARRAY['single_family', 'condo', 'townhouse'],
    min_sqft INTEGER,
    max_sqft INTEGER,
    max_days_on_market INTEGER DEFAULT 90,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create lead_scraping_motivated_params table if it doesn't exist
CREATE TABLE IF NOT EXISTS lead_scraping_motivated_params (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brokerage_id UUID,
    market_id UUID REFERENCES lead_scraping_markets(id) ON DELETE CASCADE,
    include_preforeclosure BOOLEAN DEFAULT true,
    include_divorce BOOLEAN DEFAULT true,
    include_probate BOOLEAN DEFAULT true,
    include_tax_lien BOOLEAN DEFAULT true,
    include_code_violation BOOLEAN DEFAULT true,
    include_vacant BOOLEAN DEFAULT true,
    include_absentee_owner BOOLEAN DEFAULT true,
    include_high_equity BOOLEAN DEFAULT true,
    include_tired_landlord BOOLEAN DEFAULT true,
    min_equity_percent INTEGER DEFAULT 30,
    min_years_owned INTEGER DEFAULT 5,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create lead_scraping_jobs table if it doesn't exist
CREATE TABLE IF NOT EXISTS lead_scraping_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    brokerage_id UUID,
    market_id UUID REFERENCES lead_scraping_markets(id) ON DELETE SET NULL,
    job_type TEXT NOT NULL CHECK (job_type IN ('zillow', 'realtor', 'nextdoor', 'facebook', 'craigslist', 'batchdata', 'full')),
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    started_at TIMESTAMPTZ,
    completed_at TIMESTAMPTZ,
    leads_found INTEGER DEFAULT 0,
    leads_enriched INTEGER DEFAULT 0,
    error_message TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS on new tables (only if not already enabled)
ALTER TABLE lead_scraping_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_scraping_property_params ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_scraping_motivated_params ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_scraping_jobs ENABLE ROW LEVEL SECURITY;

-- Seed default keywords if table is empty
INSERT INTO lead_scraping_keywords (keyword, category)
SELECT * FROM (VALUES
    ('looking to buy', 'buyer_intent'),
    ('house hunting', 'buyer_intent'),
    ('searching for a home', 'buyer_intent'),
    ('first time buyer', 'buyer_intent'),
    ('pre-approved mortgage', 'buyer_intent'),
    ('relocating to', 'buyer_intent'),
    ('moving to the area', 'buyer_intent'),
    ('thinking of selling', 'seller_intent'),
    ('selling my home', 'seller_intent'),
    ('need to sell quickly', 'seller_intent'),
    ('downsizing', 'seller_intent'),
    ('getting divorced', 'life_event'),
    ('recently divorced', 'life_event'),
    ('inherited property', 'life_event'),
    ('estate sale', 'life_event'),
    ('job relocation', 'life_event'),
    ('retiring soon', 'life_event'),
    ('behind on mortgage', 'distress'),
    ('foreclosure help', 'distress'),
    ('cant afford payments', 'distress'),
    ('need to sell fast', 'distress')
) AS v(keyword, category)
WHERE NOT EXISTS (SELECT 1 FROM lead_scraping_keywords LIMIT 1);
