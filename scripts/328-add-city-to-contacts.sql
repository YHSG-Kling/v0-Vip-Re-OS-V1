-- Add city and state columns to contacts table for proper address tracking

-- Add city column
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS city TEXT;

-- Add state column (if not exists)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS state TEXT;

-- Add zip_code for complete address
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS zip_code TEXT;

-- Add index for city searches (performance optimization)
CREATE INDEX IF NOT EXISTS idx_contacts_city ON contacts(city) WHERE city IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_state ON contacts(state) WHERE state IS NOT NULL;

-- Add comment for documentation
COMMENT ON COLUMN contacts.city IS 'City where the contact is located';
COMMENT ON COLUMN contacts.state IS 'State where the contact is located';
COMMENT ON COLUMN contacts.zip_code IS 'ZIP/Postal code for the contact location';
