-- Create contacts table with all required fields
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  contact_type TEXT NOT NULL CHECK (contact_type IN ('buyer', 'seller', 'investor', 'lender', 'commercial', 'other', 'agent', 'vendor', 'TC')),
  contact_persona TEXT NOT NULL CHECK (contact_persona IN ('first_time_buyer', 'luxury_buyer', 'luxury_seller', 'investor', 'first_time_seller', 'motivated_seller', 'relocating', 'empty_nester', 'other', 'probate', 'remote_seller', 'divorce', 'upsizers', 'senior', 'expired', 'fsbo')),
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'qualified', 'appointment_booked', 'signed_agreement', 'pre_listing', 'active_listing', 'contingent', 'pending', 'sold', 'lifetime_customer')),
  timeline TEXT NOT NULL CHECK (timeline IN ('0-3_months', '3-6_months', '6-12_months', '12+_months')),
  source TEXT NOT NULL CHECK (source IN ('website', 'referral', 'cold_call', 'social', 'other', 'zillow', 'realtor.com')),
  notes TEXT,
  property_interest JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  last_contacted TIMESTAMPTZ,
  contact_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  has_login BOOLEAN DEFAULT FALSE,
  login_created_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_contacts_agent_id ON contacts(agent_id);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_contact_type ON contacts(contact_type);
CREATE INDEX IF NOT EXISTS idx_contacts_contact_persona ON contacts(contact_persona);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_timeline ON contacts(timeline);
CREATE INDEX IF NOT EXISTS idx_contacts_has_login ON contacts(has_login);
CREATE INDEX IF NOT EXISTS idx_contacts_deleted_at ON contacts(deleted_at);

-- Create updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_contacts_updated_at BEFORE UPDATE ON contacts
FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Enable Row Level Security
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Agents can only see their own contacts
CREATE POLICY "Agents can view own contacts"
  ON contacts FOR SELECT
  USING (agent_id = auth.uid());

CREATE POLICY "Agents can insert own contacts"
  ON contacts FOR INSERT
  WITH CHECK (agent_id = auth.uid());

CREATE POLICY "Agents can update own contacts"
  ON contacts FOR UPDATE
  USING (agent_id = auth.uid());

CREATE POLICY "Agents can delete own contacts"
  ON contacts FOR DELETE
  USING (agent_id = auth.uid());

-- Admin policy (admins can see all)
CREATE POLICY "Admins can view all contacts"
  ON contacts FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.user_type IN ('admin', 'broker')
    )
  );
