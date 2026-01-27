-- Content Approval and Marketing Compliance System
-- Ensures all marketing materials comply with Fair Housing, RESPA, TILA, UDAAP

-- Compliance Rules & Templates
CREATE TABLE IF NOT EXISTS compliance_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_category TEXT NOT NULL, -- 'fair_housing', 'respa', 'tila', 'udaap', 'state_specific'
  rule_type TEXT NOT NULL, -- 'prohibited_phrase', 'required_disclosure', 'channel_restriction'
  rule_content JSONB NOT NULL,
  severity TEXT NOT NULL, -- 'blocking', 'warning', 'info'
  applicable_states TEXT[], -- NULL means all states
  applicable_channels TEXT[], -- 'email', 'print', 'sms', 'social', 'video'
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compliance_rules_category ON compliance_rules(rule_category, is_active);
CREATE INDEX IF NOT EXISTS idx_compliance_rules_type ON compliance_rules(rule_type);

-- Content Approval Queue
CREATE TABLE IF NOT EXISTS content_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  user_id UUID REFERENCES auth.users(id), -- For non-agent users
  content_type TEXT NOT NULL, -- 'email_template', 'print_mailer', 'social_post', 'video_script', 'listing_description'
  content_title TEXT NOT NULL,
  content_body TEXT,
  content_metadata JSONB, -- images, videos, links, etc.
  target_audience TEXT NOT NULL, -- 'cold_lead', 'warm_lead', 'active_client', 'past_client'
  distribution_channels TEXT[], -- ['email', 'print'] for cold leads only
  compliance_status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'rejected', 'needs_revision'
  compliance_issues JSONB DEFAULT '[]'::JSONB, -- array of detected issues
  reviewed_by UUID REFERENCES auth.users(id),
  reviewed_at TIMESTAMPTZ,
  review_notes TEXT,
  auto_scan_results JSONB,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  approved_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ, -- approved content can expire
  usage_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_content_approvals_status ON content_approvals(compliance_status, submitted_at);
CREATE INDEX IF NOT EXISTS idx_content_approvals_agent ON content_approvals(agent_id);
CREATE INDEX IF NOT EXISTS idx_content_approvals_user ON content_approvals(user_id);

-- Approved Content Library
CREATE TABLE IF NOT EXISTS approved_content_library (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id UUID REFERENCES content_approvals(id),
  content_category TEXT NOT NULL, -- 'them_first_nurture', 'market_update', 'listing_promo', 'buyer_guide'
  content_template TEXT NOT NULL,
  allowed_channels TEXT[],
  allowed_lead_types TEXT[], -- 'cold', 'warm', 'active', 'past'
  personalization_fields JSONB, -- available merge fields
  usage_guidelines TEXT,
  compliance_notes TEXT,
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approved_content_category ON approved_content_library(content_category, is_active);
CREATE INDEX IF NOT EXISTS idx_approved_content_channels ON approved_content_library USING GIN(allowed_channels);

-- Communication Audit Log (for tracking all outbound communications)
CREATE TABLE IF NOT EXISTS communication_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  user_id UUID REFERENCES auth.users(id),
  contact_id UUID REFERENCES contacts(id),
  lead_id UUID REFERENCES leads(id),
  communication_type TEXT NOT NULL, -- 'email', 'print', 'sms', 'call'
  content_id UUID REFERENCES approved_content_library(id),
  lead_temperature TEXT NOT NULL, -- 'cold', 'warm', 'active'
  was_approved_content BOOLEAN DEFAULT false,
  content_snapshot TEXT, -- store actual content sent
  compliance_check_passed BOOLEAN,
  compliance_warnings JSONB DEFAULT '[]'::JSONB,
  sent_via TEXT, -- 'ghl', 'print_service', 'manual'
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  delivery_status TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_agent_contact ON communication_audit_log(agent_id, contact_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_lead ON communication_audit_log(lead_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_audit_log_compliance ON communication_audit_log(compliance_check_passed);

-- Compliance Violations Tracking
CREATE TABLE IF NOT EXISTS compliance_violations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id),
  user_id UUID REFERENCES auth.users(id),
  violation_type TEXT NOT NULL,
  violation_details JSONB,
  communication_log_id UUID REFERENCES communication_audit_log(id),
  severity TEXT NOT NULL, -- 'critical', 'high', 'medium', 'low'
  detected_by TEXT, -- 'auto_scan', 'manual_review', 'complaint'
  resolution_status TEXT DEFAULT 'open', -- 'open', 'investigating', 'resolved', 'escalated'
  resolution_notes TEXT,
  detected_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_violations_agent ON compliance_violations(agent_id, detected_at);
CREATE INDEX IF NOT EXISTS idx_violations_user ON compliance_violations(user_id, detected_at);
CREATE INDEX IF NOT EXISTS idx_violations_status ON compliance_violations(resolution_status);

-- Prohibited Phrases Dictionary
CREATE TABLE IF NOT EXISTS prohibited_phrases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phrase TEXT NOT NULL,
  phrase_pattern TEXT, -- regex pattern for variations
  category TEXT NOT NULL, -- 'fair_housing', 'discriminatory', 'misleading_claim', 'pushy', 'fear_based'
  severity TEXT NOT NULL, -- 'blocking', 'warning', 'info'
  suggested_alternative TEXT,
  applicable_contexts TEXT[], -- where this applies
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_prohibited_phrases_category ON prohibited_phrases(category, is_active);

-- Required Disclosures
CREATE TABLE IF NOT EXISTS required_disclosures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  disclosure_type TEXT NOT NULL, -- 'equal_housing', 'licensed_agent', 'brokerage_info', 'advertising'
  disclosure_text TEXT NOT NULL,
  required_for_channels TEXT[],
  required_for_states TEXT[],
  placement_requirement TEXT, -- 'header', 'footer', 'inline'
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_required_disclosures_type ON required_disclosures(disclosure_type, is_active);

-- Seed prohibited phrases
INSERT INTO prohibited_phrases (phrase, phrase_pattern, category, severity, suggested_alternative, applicable_contexts) VALUES
-- Fair Housing Violations
('perfect for families', 'perfect\s+(for|area\s+for)\s+famil', 'fair_housing', 'blocking', 'Great neighborhood amenities', ARRAY['listing', 'email', 'social']),
('great for retirees', '(great|perfect|ideal)\s+(for|area\s+for)\s+retire', 'fair_housing', 'blocking', 'Close to healthcare and shopping', ARRAY['listing', 'email', 'social']),
('young professional area', 'young\s+professional', 'fair_housing', 'blocking', 'Urban location with dining options', ARRAY['listing', 'email', 'social']),
('adult community', 'adult\s+(only\s+)?community', 'fair_housing', 'blocking', 'Age-qualified community (if verified 55+)', ARRAY['listing', 'email', 'social']),
('quiet neighborhood', 'quiet\s+neighborhood', 'fair_housing', 'warning', 'Peaceful surroundings', ARRAY['listing', 'email', 'social']),
('safe area', 'safe\s+(area|neighborhood)', 'fair_housing', 'warning', 'Well-maintained area', ARRAY['listing', 'email', 'social']),
('walk to church', 'walk\s+to\s+(church|mosque|synagogue)', 'fair_housing', 'warning', 'Close to local amenities', ARRAY['listing', 'email', 'social']),
('changing neighborhood', 'changing\s+neighborhood', 'fair_housing', 'blocking', NULL, ARRAY['listing', 'email', 'social']),
-- Pushy/Sales Tactics
('limited time offer', 'limited\s+time', 'pushy', 'warning', 'Currently available', ARRAY['email', 'social', 'print']),
('act fast', 'act\s+(fast|now|quickly)', 'pushy', 'warning', 'I am here when you are ready', ARRAY['email', 'social', 'print']),
('don''t miss out', 'don''t\s+miss\s+out', 'fear_based', 'warning', 'Opportunity available', ARRAY['email', 'social', 'print']),
('you''d be crazy not to', 'crazy\s+not\s+to', 'pushy', 'blocking', NULL, ARRAY['email', 'social', 'print']),
('trust me', 'trust\s+me', 'pushy', 'warning', 'Based on my experience...', ARRAY['email', 'social', 'print']),
-- Investment Claims
('guaranteed to appreciate', 'guarantee[d]?\s+(to\s+)?appreciate', 'misleading_claim', 'blocking', 'Historically strong market', ARRAY['email', 'social', 'print', 'listing']),
('you''ll make money', 'you''ll\s+make\s+money', 'misleading_claim', 'blocking', 'Investment potential based on market data', ARRAY['email', 'social', 'print']),
('great investment', 'great\s+investment', 'misleading_claim', 'warning', 'This property has investment potential', ARRAY['email', 'social', 'print', 'listing'])
ON CONFLICT DO NOTHING;

-- Seed required disclosures
INSERT INTO required_disclosures (disclosure_type, disclosure_text, required_for_channels, required_for_states, placement_requirement) VALUES
('equal_housing', 'Equal Housing Opportunity', ARRAY['email', 'print', 'social'], NULL, 'footer'),
('licensed_agent', 'Licensed Real Estate Professional', ARRAY['email', 'print'], NULL, 'footer'),
('brokerage_info', '[Brokerage Name and Address]', ARRAY['print'], NULL, 'footer'),
('advertising', 'This is a paid advertisement', ARRAY['social', 'print'], NULL, 'header')
ON CONFLICT DO NOTHING;

-- RLS Policies
ALTER TABLE content_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE approved_content_library ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_violations ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist
DROP POLICY IF EXISTS "Users can view own content approvals" ON content_approvals;
DROP POLICY IF EXISTS "Users can insert own content approvals" ON content_approvals;
DROP POLICY IF EXISTS "Users can view approved content" ON approved_content_library;
DROP POLICY IF EXISTS "Users can view own audit logs" ON communication_audit_log;
DROP POLICY IF EXISTS "Users can insert own audit logs" ON communication_audit_log;

-- Agents can see their own content approvals
CREATE POLICY "Users can view own content approvals" ON content_approvals
  FOR SELECT USING (auth.uid() = user_id OR agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid()));

CREATE POLICY "Users can insert own content approvals" ON content_approvals
  FOR INSERT WITH CHECK (auth.uid() = user_id OR agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid()));

-- Agents can view approved content library
CREATE POLICY "Users can view approved content" ON approved_content_library
  FOR SELECT USING (is_active = true);

-- Agents can see their own audit logs
CREATE POLICY "Users can view own audit logs" ON communication_audit_log
  FOR SELECT USING (auth.uid() = user_id OR agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid()));

CREATE POLICY "Users can insert own audit logs" ON communication_audit_log
  FOR INSERT WITH CHECK (auth.uid() = user_id OR agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid()));
