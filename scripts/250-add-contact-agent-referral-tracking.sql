-- Add fields for agent assignment, vendor/lender tracking, and referral management

-- Assigned agent field (if not already exists from script 090)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS assigned_agent_id UUID REFERENCES users(id);
CREATE INDEX IF NOT EXISTS idx_contacts_assigned_agent_id ON contacts(assigned_agent_id);

-- Referral tracking fields
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS is_referral_source BOOLEAN DEFAULT FALSE;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS referred_by_contact_id UUID REFERENCES contacts(id);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS referral_count INTEGER DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS referral_notes TEXT;

-- Vendor/Lender specific fields
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS vendor_type VARCHAR(100); -- e.g., 'inspector', 'contractor', 'stager'
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lender_company VARCHAR(255);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS lender_nmls VARCHAR(50);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS service_area TEXT; -- For vendors/lenders service coverage

-- Professional relationship fields
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS rating SMALLINT CHECK (rating >= 1 AND rating <= 5);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS total_transactions INTEGER DEFAULT 0;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS last_transaction_date TIMESTAMP;

-- Add indexes for performance
CREATE INDEX IF NOT EXISTS idx_contacts_is_referral_source ON contacts(is_referral_source) WHERE is_referral_source = TRUE;
CREATE INDEX IF NOT EXISTS idx_contacts_referred_by ON contacts(referred_by_contact_id) WHERE referred_by_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_vendor_type ON contacts(vendor_type) WHERE vendor_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_contacts_lender_company ON contacts(lender_company) WHERE lender_company IS NOT NULL;

-- Update RLS policies to include assigned agent filtering
DROP POLICY IF EXISTS "Users can view assigned contacts" ON contacts;
CREATE POLICY "Users can view assigned contacts" ON contacts
  FOR SELECT
  USING (
    auth.uid() IN (
      SELECT id FROM users WHERE user_type IN ('admin', 'broker', 'compliance')
    )
    OR agent_id = auth.uid()::TEXT
    OR assigned_agent_id = auth.uid()
  );
