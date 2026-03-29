-- Migration: add source_family to contacts, leads, raw_scraped_leads, transactions
-- source_family values: 'raw' | 'lead' | 'contact_direct'
-- This powers the Source Analytics & Attribution capability

-- contacts table: source_family indicates how the contact was acquired
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS source_family TEXT DEFAULT 'contact_direct' CHECK (source_family IN ('raw', 'lead', 'contact_direct')),
  ADD COLUMN IF NOT EXISTS source_channel TEXT,
  ADD COLUMN IF NOT EXISTS source_subtype TEXT,
  ADD COLUMN IF NOT EXISTS campaign_attribution_id UUID REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS source_agent_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cost_per_record NUMERIC DEFAULT 0;

-- leads table: source_family for pre-contact records
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS source_family TEXT DEFAULT 'lead' CHECK (source_family IN ('raw', 'lead', 'contact_direct')),
  ADD COLUMN IF NOT EXISTS source_channel TEXT,
  ADD COLUMN IF NOT EXISTS source_subtype TEXT,
  ADD COLUMN IF NOT EXISTS campaign_attribution_id UUID REFERENCES marketing_campaigns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cost_per_record NUMERIC DEFAULT 0;

-- raw_scraped_leads table: always 'raw' family
ALTER TABLE raw_scraped_leads
  ADD COLUMN IF NOT EXISTS source_family TEXT DEFAULT 'raw' CHECK (source_family IN ('raw', 'lead', 'contact_direct')),
  ADD COLUMN IF NOT EXISTS source_channel TEXT,
  ADD COLUMN IF NOT EXISTS source_subtype TEXT,
  ADD COLUMN IF NOT EXISTS cost_per_record NUMERIC DEFAULT 0;

-- transactions: source attribution for ROI calculation
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS source TEXT,
  ADD COLUMN IF NOT EXISTS source_family TEXT CHECK (source_family IN ('raw', 'lead', 'contact_direct')),
  ADD COLUMN IF NOT EXISTS commission_amount NUMERIC DEFAULT 0;

-- Back-fill source_family on contacts based on source value:
-- Known direct-contact sources (consented, customer-facing)
UPDATE contacts SET source_family = 'contact_direct'
WHERE source IN (
  'website', 'website_form', 'landing_page', 'landing_page_form',
  'qr_code', 'qr_form', 'chat_widget', 'open_house', 'open_house_signin',
  'referral', 'referral_form', 'intake_form', 'client_portal'
)
AND source_family IS NULL;

-- Known raw/scraped sources
UPDATE contacts SET source_family = 'raw'
WHERE source IN (
  'scraped', 'web_scrape', 'imported', 'import', 'purchased_list',
  'purchased', 'batchdata', 'cold_acquisition', 'enrichment', 'dedup'
)
AND source_family IS NULL;

-- Everything else defaults to lead (manual entry, vendor feeds, paid)
UPDATE contacts SET source_family = 'lead'
WHERE source_family IS NULL;

-- Back-fill leads table
UPDATE leads SET source_family = 'lead'
WHERE source_family IS NULL;

-- Back-fill transactions source_family from their contact
UPDATE transactions t
SET source_family = c.source_family,
    source = c.source
FROM contacts c
WHERE t.contact_id = c.id
  AND t.source_family IS NULL
  AND c.source_family IS NOT NULL;

-- Indexes for analytics queries
CREATE INDEX IF NOT EXISTS idx_contacts_source_family ON contacts(brokerage_id, source_family, source);
CREATE INDEX IF NOT EXISTS idx_contacts_source ON contacts(brokerage_id, source);
CREATE INDEX IF NOT EXISTS idx_leads_source_family ON leads(brokerage_id, source_family, source);
CREATE INDEX IF NOT EXISTS idx_transactions_source ON transactions(brokerage_id, source, source_family);
CREATE INDEX IF NOT EXISTS idx_raw_scraped_source ON raw_scraped_leads(brokerage_id, source, source_family);
