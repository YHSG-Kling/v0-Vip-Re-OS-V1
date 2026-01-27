-- =====================================================
-- DATA HEALTH MONITORING SYSTEM
-- Tracks data quality, validation issues, and health metrics
-- =====================================================

-- Data Health Scans Table
-- Tracks when data quality scans are run
CREATE TABLE IF NOT EXISTS data_health_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_type VARCHAR(50) NOT NULL, -- 'full', 'incremental', 'contacts', 'transactions', 'listings'
  status VARCHAR(50) DEFAULT 'running', -- 'running', 'completed', 'failed'
  total_records_scanned INTEGER DEFAULT 0,
  issues_found INTEGER DEFAULT 0,
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  scan_config JSONB, -- Configuration parameters for the scan
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Data Health Logs Table
-- Stores individual data quality issues found
CREATE TABLE IF NOT EXISTS data_health_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id UUID REFERENCES data_health_scans(id) ON DELETE CASCADE,
  entity_type VARCHAR(50) NOT NULL, -- 'contact', 'transaction', 'listing', 'agent'
  entity_id UUID NOT NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  validation_status VARCHAR(50) NOT NULL, -- 'Valid', 'Invalid', 'Risky', 'Warning'
  validation_reason TEXT,
  field_name VARCHAR(100), -- Which field has the issue
  current_value TEXT, -- Current problematic value
  suggested_fix TEXT, -- AI-suggested fix
  severity VARCHAR(20) DEFAULT 'medium', -- 'low', 'medium', 'high', 'critical'
  auto_fixable BOOLEAN DEFAULT false,
  fixed BOOLEAN DEFAULT false,
  fixed_at TIMESTAMPTZ,
  fixed_by UUID REFERENCES auth.users(id),
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Data Quality Rules Table
-- Defines validation rules for different entity types
CREATE TABLE IF NOT EXISTS data_quality_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_name VARCHAR(100) NOT NULL,
  entity_type VARCHAR(50) NOT NULL, -- 'contact', 'transaction', 'listing'
  field_name VARCHAR(100) NOT NULL,
  rule_type VARCHAR(50) NOT NULL, -- 'required', 'format', 'range', 'custom'
  rule_config JSONB NOT NULL, -- Rule parameters (regex, min/max, etc.)
  severity VARCHAR(20) DEFAULT 'medium',
  active BOOLEAN DEFAULT true,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_data_health_scans_status ON data_health_scans(status);
CREATE INDEX IF NOT EXISTS idx_data_health_scans_created_at ON data_health_scans(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_health_logs_scan_id ON data_health_logs(scan_id);
CREATE INDEX IF NOT EXISTS idx_data_health_logs_entity ON data_health_logs(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_data_health_logs_contact_id ON data_health_logs(contact_id);
CREATE INDEX IF NOT EXISTS idx_data_health_logs_status ON data_health_logs(validation_status);
CREATE INDEX IF NOT EXISTS idx_data_health_logs_detected_at ON data_health_logs(detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_quality_rules_entity ON data_quality_rules(entity_type, active);

-- RLS Policies
ALTER TABLE data_health_scans ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_health_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE data_quality_rules ENABLE ROW LEVEL SECURITY;

-- Scans: All authenticated users can view, only admins can create
CREATE POLICY "Users can view data health scans"
  ON data_health_scans FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins can create data health scans"
  ON data_health_scans FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'broker')
    )
  );

CREATE POLICY "Admins can update data health scans"
  ON data_health_scans FOR UPDATE
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'broker')
    )
  );

-- Logs: All authenticated users can view their relevant logs
CREATE POLICY "Users can view data health logs"
  ON data_health_logs FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admins can manage data health logs"
  ON data_health_logs FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'broker')
    )
  );

-- Rules: All can view, only admins can manage
CREATE POLICY "Users can view data quality rules"
  ON data_quality_rules FOR SELECT
  TO authenticated
  USING (active = true);

CREATE POLICY "Admins can manage data quality rules"
  ON data_quality_rules FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role IN ('admin', 'broker')
    )
  );

-- Insert default validation rules
INSERT INTO data_quality_rules (rule_name, entity_type, field_name, rule_type, rule_config, severity, error_message) VALUES
  -- Contact Rules
  ('Contact Email Required', 'contact', 'email', 'required', '{"required": true}'::jsonb, 'high', 'Contact must have an email address'),
  ('Contact Email Format', 'contact', 'email', 'format', '{"pattern": "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$"}'::jsonb, 'high', 'Email address format is invalid'),
  ('Contact Phone Required', 'contact', 'phone', 'required', '{"required": true}'::jsonb, 'medium', 'Contact should have a phone number'),
  ('Contact Phone Format', 'contact', 'phone', 'format', '{"pattern": "^[0-9]{10,}$", "strip_non_digits": true}'::jsonb, 'medium', 'Phone number should be at least 10 digits'),
  ('Contact Name Required', 'contact', 'first_name', 'required', '{"required": true}'::jsonb, 'medium', 'Contact should have a first or last name'),
  
  -- Transaction Rules
  ('Transaction Address Required', 'transaction', 'property_address', 'required', '{"required": true}'::jsonb, 'critical', 'Transaction must have a property address'),
  ('Transaction Price Valid', 'transaction', 'sale_price', 'range', '{"min": 1000, "max": 100000000}'::jsonb, 'high', 'Transaction price must be between $1,000 and $100,000,000'),
  ('Transaction Status Valid', 'transaction', 'status', 'format', '{"enum": ["Active", "Pending", "Closed", "Cancelled"]}'::jsonb, 'medium', 'Transaction status must be valid'),
  ('Transaction Close Date', 'transaction', 'close_date', 'required', '{"required_if": {"field": "status", "value": "Closed"}}'::jsonb, 'high', 'Closed transactions must have a close date'),
  
  -- Listing Rules
  ('Listing Address Required', 'listing', 'address', 'required', '{"required": true}'::jsonb, 'critical', 'Listing must have an address'),
  ('Listing Price Valid', 'listing', 'price', 'range', '{"min": 1000, "max": 100000000}'::jsonb, 'high', 'Listing price must be between $1,000 and $100,000,000'),
  ('Listing MLS Number', 'listing', 'mls_number', 'required', '{"required": true}'::jsonb, 'medium', 'Listing should have an MLS number'),
  ('Listing Status Valid', 'listing', 'status', 'format', '{"enum": ["Active", "Pending", "Sold", "Withdrawn", "Expired"]}'::jsonb, 'medium', 'Listing status must be valid')
ON CONFLICT DO NOTHING;

-- Function to automatically update updated_at timestamp
CREATE OR REPLACE FUNCTION update_data_health_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
CREATE TRIGGER update_data_health_scans_updated_at
  BEFORE UPDATE ON data_health_scans
  FOR EACH ROW
  EXECUTE FUNCTION update_data_health_updated_at();

CREATE TRIGGER update_data_quality_rules_updated_at
  BEFORE UPDATE ON data_quality_rules
  FOR EACH ROW
  EXECUTE FUNCTION update_data_health_updated_at();

-- Success message
DO $$
BEGIN
  RAISE NOTICE '✓ Data Health Monitoring System tables created successfully';
  RAISE NOTICE '  - data_health_scans: Track data quality scan runs';
  RAISE NOTICE '  - data_health_logs: Store validation issues';
  RAISE NOTICE '  - data_quality_rules: Define validation rules';
  RAISE NOTICE '  - 13 default validation rules inserted';
END $$;
