-- Add enrichment data fields directly to the contacts table
-- This stores all enrichment data on the contact record itself for easier access

-- First, add base enrichment tracking columns
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enriched_at TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS enrichment_source TEXT; -- 'manual', 'auto', 'ghl_sync', 'import'
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_life_change_check TIMESTAMPTZ;

-- Add email and phone verification columns
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS email_verification_date TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_verified BOOLEAN DEFAULT FALSE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_verification_date TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS phone_type TEXT; -- 'mobile', 'landline', 'voip'

-- Demographic fields from PeopleData
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS age_range TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS gender TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS marital_status TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS household_income TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS home_owner_status TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS home_value_estimate DECIMAL(12,2);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS length_of_residence TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS occupation TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS education_level TEXT;

-- Social profiles
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS linkedin_url TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS facebook_url TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS twitter_url TEXT;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS instagram_url TEXT;

-- Life events and OSINT data (stored as JSONB)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS life_events JSONB DEFAULT '[]';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_life_event_detected TIMESTAMPTZ;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS public_records JSONB DEFAULT '[]';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS court_records JSONB DEFAULT '[]';
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS property_records JSONB DEFAULT '[]';

-- Enrichment metadata
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS data_source TEXT; -- 'peopledata', 'osint', etc.
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS confidence_score INTEGER DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS peopledata_id TEXT;

-- Create index on enriched_at for performance
CREATE INDEX IF NOT EXISTS idx_contacts_enriched_at ON contacts(enriched_at) WHERE enriched_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_last_life_change_check ON contacts(last_life_change_check) WHERE last_life_change_check IS NOT NULL;
