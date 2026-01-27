-- ============================================================================
-- OFFERS MANAGEMENT SYSTEM
-- Complete offers table with contact_id for portal scoping
-- ============================================================================

-- Create offers table
CREATE TABLE IF NOT EXISTS offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID,
  listing_id UUID,
  buyer_id UUID REFERENCES contacts(id),
  contact_id UUID REFERENCES contacts(id), -- For portal scoping (can be buyer or related contact)
  seller_id UUID REFERENCES contacts(id),
  agent_id UUID,
  
  -- Offer details
  offer_amount INTEGER NOT NULL,
  earnest_money INTEGER DEFAULT 0,
  down_payment_percent DECIMAL(5,2),
  financing_type TEXT DEFAULT 'conventional', -- conventional, fha, va, cash, other
  loan_amount INTEGER,
  pre_approval_amount INTEGER,
  pre_approval_lender TEXT,
  
  -- Property info
  property_address TEXT,
  property_city TEXT,
  property_state TEXT,
  property_zip TEXT,
  property_image_url TEXT,
  
  -- Terms
  contingencies JSONB DEFAULT '[]'::jsonb, -- inspection, appraisal, financing, sale of home
  close_date DATE,
  possession_date DATE,
  additional_terms TEXT,
  
  -- Status tracking
  status TEXT DEFAULT 'draft', -- draft, pending, submitted, under_review, countered, accepted, rejected, expired, withdrawn
  submitted_at TIMESTAMPTZ,
  reviewed_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  
  -- Seller response
  seller_response TEXT, -- accepted, rejected, countered
  seller_response_notes TEXT,
  counter_amount INTEGER,
  counter_terms JSONB,
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Create offer counters table for back-and-forth negotiations
CREATE TABLE IF NOT EXISTS offer_counters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id UUID REFERENCES offers(id) ON DELETE CASCADE,
  counter_number INTEGER NOT NULL DEFAULT 1,
  countered_by TEXT NOT NULL, -- buyer, seller
  counter_amount INTEGER NOT NULL,
  counter_terms JSONB,
  counter_notes TEXT,
  status TEXT DEFAULT 'pending', -- pending, accepted, rejected, expired
  submitted_at TIMESTAMPTZ DEFAULT now(),
  responded_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Create offer documents table
CREATE TABLE IF NOT EXISTS offer_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id UUID REFERENCES offers(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL, -- purchase_agreement, addendum, counter_offer, pre_approval, proof_of_funds
  document_name TEXT NOT NULL,
  file_url TEXT,
  file_size INTEGER,
  uploaded_by UUID,
  signed BOOLEAN DEFAULT false,
  signed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Create offer activity log
CREATE TABLE IF NOT EXISTS offer_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id UUID REFERENCES offers(id) ON DELETE CASCADE,
  activity_type TEXT NOT NULL, -- created, submitted, viewed, countered, accepted, rejected, expired, withdrawn, document_added
  performed_by TEXT, -- buyer, seller, buyer_agent, seller_agent, system
  description TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_offers_contact_id ON offers(contact_id);
CREATE INDEX IF NOT EXISTS idx_offers_buyer_id ON offers(buyer_id);
CREATE INDEX IF NOT EXISTS idx_offers_seller_id ON offers(seller_id);
CREATE INDEX IF NOT EXISTS idx_offers_listing_id ON offers(listing_id);
CREATE INDEX IF NOT EXISTS idx_offers_status ON offers(status);
CREATE INDEX IF NOT EXISTS idx_offers_created_at ON offers(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_offer_counters_offer_id ON offer_counters(offer_id);
CREATE INDEX IF NOT EXISTS idx_offer_documents_offer_id ON offer_documents(offer_id);
CREATE INDEX IF NOT EXISTS idx_offer_activity_offer_id ON offer_activity(offer_id);

-- Enable RLS
ALTER TABLE offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE offer_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE offer_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE offer_activity ENABLE ROW LEVEL SECURITY;

-- RLS Policies
DROP POLICY IF EXISTS "Users can view their own offers" ON offers;
CREATE POLICY "Users can view their own offers" ON offers
  FOR SELECT USING (true);

DROP POLICY IF EXISTS "Users can insert offers" ON offers;
CREATE POLICY "Users can insert offers" ON offers
  FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Users can update their own offers" ON offers;
CREATE POLICY "Users can update their own offers" ON offers
  FOR UPDATE USING (true);

DROP POLICY IF EXISTS "Users can view offer counters" ON offer_counters;
CREATE POLICY "Users can view offer counters" ON offer_counters
  FOR ALL USING (true);

DROP POLICY IF EXISTS "Users can view offer documents" ON offer_documents;
CREATE POLICY "Users can view offer documents" ON offer_documents
  FOR ALL USING (true);

DROP POLICY IF EXISTS "Users can view offer activity" ON offer_activity;
CREATE POLICY "Users can view offer activity" ON offer_activity
  FOR ALL USING (true);

-- Insert demo offers for first-time buyer persona
INSERT INTO offers (
  id,
  contact_id,
  buyer_id,
  property_address,
  property_city,
  property_state,
  property_zip,
  offer_amount,
  earnest_money,
  down_payment_percent,
  financing_type,
  pre_approval_amount,
  pre_approval_lender,
  contingencies,
  close_date,
  status,
  submitted_at,
  expires_at,
  created_at
) VALUES 
(
  'a0000000-0000-0000-0000-000000000001',
  '00000000-0000-0000-0000-000000000001', -- First-time buyer
  '00000000-0000-0000-0000-000000000001',
  '123 Oak Lane',
  'Austin',
  'TX',
  '78701',
  425000,
  10000,
  20.00,
  'conventional',
  450000,
  'First National Bank',
  '["inspection", "appraisal", "financing"]'::jsonb,
  CURRENT_DATE + INTERVAL '45 days',
  'under_review',
  now() - INTERVAL '2 days',
  now() + INTERVAL '46 hours',
  now() - INTERVAL '2 days'
),
(
  'a0000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001', -- First-time buyer
  '00000000-0000-0000-0000-000000000001',
  '456 Maple Street',
  'Austin',
  'TX',
  '78702',
  385000,
  8500,
  15.00,
  'fha',
  400000,
  'First National Bank',
  '["inspection", "appraisal", "financing"]'::jsonb,
  CURRENT_DATE + INTERVAL '30 days',
  'countered',
  now() - INTERVAL '5 days',
  now() + INTERVAL '24 hours',
  now() - INTERVAL '5 days'
)
ON CONFLICT (id) DO UPDATE SET
  status = EXCLUDED.status,
  updated_at = now();

-- Insert demo counter for the countered offer
INSERT INTO offer_counters (
  id,
  offer_id,
  counter_number,
  countered_by,
  counter_amount,
  counter_terms,
  counter_notes,
  status,
  submitted_at,
  expires_at
) VALUES (
  'b0000000-0000-0000-0000-000000000001',
  'a0000000-0000-0000-0000-000000000002',
  1,
  'seller',
  392000,
  '{"close_date": "30 days", "repairs": "as-is"}'::jsonb,
  'Seller willing to come down $3,000 but property sold as-is. Close date flexible.',
  'pending',
  now() - INTERVAL '1 day',
  now() + INTERVAL '24 hours'
)
ON CONFLICT (id) DO NOTHING;

-- Insert offer activity
INSERT INTO offer_activity (offer_id, activity_type, performed_by, description) VALUES
('a0000000-0000-0000-0000-000000000001', 'created', 'buyer', 'Offer created'),
('a0000000-0000-0000-0000-000000000001', 'submitted', 'buyer', 'Offer submitted to seller'),
('a0000000-0000-0000-0000-000000000001', 'viewed', 'seller_agent', 'Seller agent reviewed offer'),
('a0000000-0000-0000-0000-000000000002', 'created', 'buyer', 'Offer created'),
('a0000000-0000-0000-0000-000000000002', 'submitted', 'buyer', 'Offer submitted to seller'),
('a0000000-0000-0000-0000-000000000002', 'countered', 'seller', 'Seller submitted counter offer at $392,000');

-- Trigger to auto-set contact_id from buyer_id
CREATE OR REPLACE FUNCTION set_offer_contact_id()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.contact_id IS NULL AND NEW.buyer_id IS NOT NULL THEN
    NEW.contact_id := NEW.buyer_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_set_offer_contact_id ON offers;
CREATE TRIGGER trigger_set_offer_contact_id
  BEFORE INSERT ON offers
  FOR EACH ROW
  EXECUTE FUNCTION set_offer_contact_id();

-- Trigger to update updated_at
CREATE OR REPLACE FUNCTION update_offer_timestamp()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_update_offer_timestamp ON offers;
CREATE TRIGGER trigger_update_offer_timestamp
  BEFORE UPDATE ON offers
  FOR EACH ROW
  EXECUTE FUNCTION update_offer_timestamp();
