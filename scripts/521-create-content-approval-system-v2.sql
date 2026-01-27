-- Content Approval and Marketing Compliance System v2
-- Ensures all marketing materials comply with Fair Housing, RESPA, TILA, UDAAP

-- Compliance Rules & Templates
CREATE TABLE IF NOT EXISTS compliance_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_category TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  rule_content JSONB NOT NULL,
  severity TEXT NOT NULL,
  applicable_states TEXT[],
  applicable_channels TEXT[],
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Content Approval Queue
CREATE TABLE IF NOT EXISTS content_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  user_id UUID,
  content_type TEXT NOT NULL,
  content_title TEXT NOT NULL,
  content_body TEXT,
  content_metadata JSONB,
  target_audience TEXT NOT NULL,
  distribution_channels TEXT[],
  compliance_status TEXT DEFAULT 'pending',
  compliance_issues JSONB DEFAULT '[]'::JSONB,
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  auto_scan_results JSONB,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  usage_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add compliance_status column if table exists without it
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'content_approvals' AND column_name = 'compliance_status'
  ) THEN
    ALTER TABLE content_approvals ADD COLUMN compliance_status TEXT DEFAULT 'pending';
  END IF;
END $$;

-- Approved Content Library
CREATE TABLE IF NOT EXISTS approved_content_library (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id UUID,
  content_category TEXT NOT NULL,
  content_template TEXT NOT NULL,
  allowed_channels TEXT[],
  allowed_lead_types TEXT[],
  personalization_fields JSONB,
  usage_guidelines TEXT,
  compliance_notes TEXT,
  is_active BOOLEAN DEFAULT true,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Communication Audit Log
CREATE TABLE IF NOT EXISTS communication_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  user_id UUID,
  contact_id UUID,
  lead_id UUID,
  communication_type TEXT NOT NULL,
  content_id UUID,
  lead_temperature TEXT NOT NULL,
  was_approved_content BOOLEAN DEFAULT false,
  content_snapshot TEXT,
  compliance_check_passed BOOLEAN,
  compliance_warnings JSONB DEFAULT '[]'::JSONB,
  sent_via TEXT,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  delivery_status TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Compliance Violations Tracking
CREATE TABLE IF NOT EXISTS compliance_violations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  user_id UUID,
  violation_type TEXT NOT NULL,
  violation_details JSONB,
  communication_log_id UUID,
  severity TEXT NOT NULL,
  detected_by TEXT,
  resolution_status TEXT DEFAULT 'open',
  resolution_notes TEXT,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

-- Prohibited Phrases Dictionary
CREATE TABLE IF NOT EXISTS prohibited_phrases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phrase TEXT NOT NULL,
  phrase_pattern TEXT,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  suggested_alternative TEXT,
  applicable_contexts TEXT[],
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Required Disclosures
CREATE TABLE IF NOT EXISTS required_disclosures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  disclosure_type TEXT NOT NULL,
  disclosure_text TEXT NOT NULL,
  required_for_channels TEXT[],
  required_for_states TEXT[],
  placement_requirement TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed prohibited phrases (only if empty)
INSERT INTO prohibited_phrases (phrase, phrase_pattern, category, severity, suggested_alternative, applicable_contexts)
SELECT * FROM (VALUES
  ('perfect for families', 'perfect\s+(for|area\s+for)\s+famil', 'fair_housing', 'blocking', 'Great neighborhood amenities', ARRAY['listing', 'email', 'social']),
  ('great for retirees', '(great|perfect|ideal)\s+(for|area\s+for)\s+retire', 'fair_housing', 'blocking', 'Close to healthcare and shopping', ARRAY['listing', 'email', 'social']),
  ('young professional area', 'young\s+professional', 'fair_housing', 'blocking', 'Urban location with dining options', ARRAY['listing', 'email', 'social']),
  ('quiet neighborhood', 'quiet\s+neighborhood', 'fair_housing', 'warning', 'Peaceful surroundings', ARRAY['listing', 'email', 'social']),
  ('safe area', 'safe\s+(area|neighborhood)', 'fair_housing', 'warning', 'Well-maintained area', ARRAY['listing', 'email', 'social']),
  ('limited time offer', 'limited\s+time', 'pushy', 'warning', 'Currently available', ARRAY['email', 'social', 'print']),
  ('act fast', 'act\s+(fast|now|quickly)', 'pushy', 'warning', 'I am here when you are ready', ARRAY['email', 'social', 'print']),
  ('guaranteed to appreciate', 'guarantee[d]?\s+(to\s+)?appreciate', 'misleading_claim', 'blocking', 'Historically strong market', ARRAY['email', 'social', 'print', 'listing'])
) AS v(phrase, phrase_pattern, category, severity, suggested_alternative, applicable_contexts)
WHERE NOT EXISTS (SELECT 1 FROM prohibited_phrases LIMIT 1);

-- Seed required disclosures (only if empty)
INSERT INTO required_disclosures (disclosure_type, disclosure_text, required_for_channels, required_for_states, placement_requirement)
SELECT * FROM (VALUES
  ('equal_housing', 'Equal Housing Opportunity', ARRAY['email', 'print', 'social'], NULL::TEXT[], 'footer'),
  ('licensed_agent', 'Licensed Real Estate Professional', ARRAY['email', 'print'], NULL::TEXT[], 'footer'),
  ('brokerage_info', '[Brokerage Name and Address]', ARRAY['print'], NULL::TEXT[], 'footer')
) AS v(disclosure_type, disclosure_text, required_for_channels, required_for_states, placement_requirement)
WHERE NOT EXISTS (SELECT 1 FROM required_disclosures LIMIT 1);
