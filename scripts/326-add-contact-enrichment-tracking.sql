-- Add enrichment tracking columns to contacts table
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enrichment_source TEXT; -- 'manual', 'auto', 'ghl_sync', 'import'
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_life_change_check TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS peopledata_id TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_verification_date TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_verification_date TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_type TEXT; -- 'mobile', 'landline', 'voip'

-- Create contact enrichment data table
CREATE TABLE IF NOT EXISTS contact_enrichment_data (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  
  -- PeopleData fields
  age_range TEXT,
  gender TEXT,
  marital_status TEXT,
  household_income TEXT,
  home_owner_status TEXT,
  home_value_estimate DECIMAL(12,2),
  length_of_residence TEXT,
  occupation TEXT,
  education_level TEXT,
  
  -- Social profiles
  linkedin_url TEXT,
  facebook_url TEXT,
  twitter_url TEXT,
  instagram_url TEXT,
  
  -- Life events detected
  life_events JSONB DEFAULT '[]',
  last_life_event_detected TIMESTAMPTZ,
  
  -- OSINT data
  public_records JSONB DEFAULT '[]',
  court_records JSONB DEFAULT '[]',
  property_records JSONB DEFAULT '[]',
  
  -- Metadata
  data_source TEXT,
  confidence_score INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_enrichment_contact_id ON contact_enrichment_data(contact_id);

-- Create contact life changes table
CREATE TABLE IF NOT EXISTS contact_life_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  change_type TEXT NOT NULL, -- 'divorce', 'marriage', 'job_change', 'relocation', 'new_baby', 'death_in_family', 'retirement', 'foreclosure', 'bankruptcy'
  change_details JSONB,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  detected_via TEXT, -- 'osint', 'peopledata', 'social_scan', 'manual'
  confidence_score INTEGER DEFAULT 0,
  notified_agent BOOLEAN DEFAULT FALSE,
  notified_at TIMESTAMPTZ,
  follow_up_action TEXT,
  follow_up_completed BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_contact_life_changes_contact_id ON contact_life_changes(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_life_changes_type ON contact_life_changes(change_type);

-- RLS Policies
ALTER TABLE contact_enrichment_data ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_life_changes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Agents can view their contact enrichment data" ON contact_enrichment_data;
CREATE POLICY "Agents can view their contact enrichment data" ON contact_enrichment_data
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM contacts c WHERE c.id = contact_id AND c.agent_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Admins can manage all contact enrichment data" ON contact_enrichment_data;
CREATE POLICY "Admins can manage all contact enrichment data" ON contact_enrichment_data
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role IN ('admin', 'broker'))
  );

DROP POLICY IF EXISTS "Agents can view their contact life changes" ON contact_life_changes;
CREATE POLICY "Agents can view their contact life changes" ON contact_life_changes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM contacts c WHERE c.id = contact_id AND c.agent_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Admins can manage all contact life changes" ON contact_life_changes;
CREATE POLICY "Admins can manage all contact life changes" ON contact_life_changes
  FOR ALL USING (
    EXISTS (SELECT 1 FROM users u WHERE u.id = auth.uid() AND u.role IN ('admin', 'broker'))
  );
