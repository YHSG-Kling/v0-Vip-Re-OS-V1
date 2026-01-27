-- Listing Packet System Schema
-- Documents and binders for property display after MLS listing goes live

-- Listing Packets (main record)
CREATE TABLE IF NOT EXISTS listing_packets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  status TEXT DEFAULT 'generating' CHECK (status IN ('generating', 'completed', 'error', 'archived')),
  config JSONB DEFAULT '{}',
  documents JSONB DEFAULT '[]',
  quality_check JSONB,
  quality_checked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Listing Packet Binders (physical binder tracking)
CREATE TABLE IF NOT EXISTS listing_packet_binders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  packet_id UUID REFERENCES listing_packets(id) ON DELETE CASCADE,
  listing_id UUID NOT NULL,
  copies_requested INTEGER DEFAULT 1,
  copies_printed INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending_print' CHECK (status IN ('pending_print', 'printing', 'printed', 'delivered', 'returned')),
  delivery_location TEXT DEFAULT 'property_display_table',
  delivered_at TIMESTAMPTZ,
  delivered_by UUID,
  delivery_photo_url TEXT,
  delivery_notes TEXT,
  returned_at TIMESTAMPTZ,
  return_condition TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Packet Document Templates
CREATE TABLE IF NOT EXISTS packet_document_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_type TEXT NOT NULL CHECK (template_type IN ('listing_flyer', 'seller_disclosure', 'utilities_form', 'gis_report', 'tax_record', 'appraiser_report', 'custom')),
  name TEXT NOT NULL,
  description TEXT,
  template_content JSONB,
  state TEXT,
  is_default BOOLEAN DEFAULT false,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- State Disclosure Requirements
CREATE TABLE IF NOT EXISTS state_disclosure_requirements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state TEXT NOT NULL,
  disclosure_name TEXT NOT NULL,
  description TEXT,
  required BOOLEAN DEFAULT true,
  form_number TEXT,
  form_url TEXT,
  effective_date DATE,
  expiration_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(state, disclosure_name)
);

-- Packet Generation History (for analytics)
CREATE TABLE IF NOT EXISTS packet_generation_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  packet_id UUID REFERENCES listing_packets(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  generation_status TEXT NOT NULL,
  generation_time_ms INTEGER,
  ai_model_used TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Performance indexes
CREATE INDEX IF NOT EXISTS idx_listing_packets_listing ON listing_packets(listing_id);
CREATE INDEX IF NOT EXISTS idx_listing_packets_agent ON listing_packets(agent_id);
CREATE INDEX IF NOT EXISTS idx_listing_packets_status ON listing_packets(status);
CREATE INDEX IF NOT EXISTS idx_packet_binders_packet ON listing_packet_binders(packet_id);
CREATE INDEX IF NOT EXISTS idx_packet_binders_status ON listing_packet_binders(status);
CREATE INDEX IF NOT EXISTS idx_state_disclosures_state ON state_disclosure_requirements(state);

-- RLS Policies
ALTER TABLE listing_packets ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_packet_binders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS listing_packets_agent_policy ON listing_packets;
CREATE POLICY listing_packets_agent_policy ON listing_packets FOR ALL USING (agent_id = auth.uid());

DROP POLICY IF EXISTS packet_binders_agent_policy ON listing_packet_binders;
CREATE POLICY packet_binders_agent_policy ON listing_packet_binders FOR ALL USING (
  packet_id IN (SELECT id FROM listing_packets WHERE agent_id = auth.uid())
);

-- Seed common state disclosure requirements
INSERT INTO state_disclosure_requirements (state, disclosure_name, required, description) VALUES
  ('CA', 'Transfer Disclosure Statement (TDS)', true, 'Required seller disclosure of known property conditions'),
  ('CA', 'Natural Hazard Disclosure (NHD)', true, 'Disclosure of natural hazard zones'),
  ('CA', 'Seller Property Questionnaire (SPQ)', true, 'Additional property condition questions'),
  ('CA', 'Lead-Based Paint Disclosure', true, 'Required for homes built before 1978'),
  ('CA', 'Smoke Detector Compliance', true, 'Certification of smoke detector installation'),
  ('CA', 'Water Heater Bracing', true, 'Certification of water heater strapping'),
  ('TX', 'Sellers Disclosure Notice', true, 'Texas required seller disclosure'),
  ('TX', 'Lead-Based Paint Disclosure', true, 'Required for homes built before 1978'),
  ('TX', 'MUD/PID Disclosure', false, 'Required if property is in MUD or PID'),
  ('FL', 'Sellers Property Disclosure', true, 'Florida required seller disclosure'),
  ('FL', 'Lead-Based Paint Disclosure', true, 'Required for homes built before 1978'),
  ('FL', 'Radon Gas Disclosure', true, 'Florida radon notification'),
  ('FL', 'Energy-Efficiency Rating Disclosure', true, 'Energy rating information'),
  ('NY', 'Property Condition Disclosure Statement', true, 'New York required disclosure'),
  ('NY', 'Lead-Based Paint Disclosure', true, 'Required for homes built before 1978'),
  ('NY', 'Smoke/CO Detector Compliance', true, 'Detector certification')
ON CONFLICT (state, disclosure_name) DO NOTHING;

-- Function to auto-trigger packet generation when listing goes live
CREATE OR REPLACE FUNCTION trigger_packet_generation()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.stage = 'live' AND (OLD.stage IS NULL OR OLD.stage != 'live') THEN
    -- Insert a pending packet generation request
    INSERT INTO listing_packets (listing_id, agent_id, status, config)
    VALUES (
      NEW.id, 
      NEW.agent_id, 
      'pending',
      jsonb_build_object(
        'autoGenerated', true,
        'includeFlyer', true,
        'includeSellerDisclosure', true,
        'includeUtilitiesForm', true,
        'includeGISReport', true,
        'includeTaxRecord', true,
        'includeAppraiserReport', true,
        'createPhysicalBinder', true
      )
    );
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger (drop first if exists)
DROP TRIGGER IF EXISTS listing_live_packet_trigger ON listings;
CREATE TRIGGER listing_live_packet_trigger
  AFTER UPDATE ON listings
  FOR EACH ROW
  EXECUTE FUNCTION trigger_packet_generation();

COMMENT ON TABLE listing_packets IS 'Stores generated listing packets with all documents for property display';
COMMENT ON TABLE listing_packet_binders IS 'Tracks physical binder printing and delivery to properties';
COMMENT ON TABLE state_disclosure_requirements IS 'State-specific disclosure requirements for compliance checking';
