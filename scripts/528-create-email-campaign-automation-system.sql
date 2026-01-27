-- =====================================================
-- EMAIL CAMPAIGN AUTOMATION SYSTEM
-- AI-powered behavioral triggers, drip sequences, persona-specific campaigns
-- =====================================================

-- Drop existing tables if they exist
DROP TABLE IF EXISTS email_engagement CASCADE;
DROP TABLE IF EXISTS email_sends CASCADE;
DROP TABLE IF EXISTS drip_sequence_emails CASCADE;
DROP TABLE IF EXISTS email_drip_sequences CASCADE;
DROP TABLE IF EXISTS ab_test_campaigns CASCADE;
DROP TABLE IF EXISTS send_time_optimization CASCADE;
DROP TABLE IF EXISTS email_list_segments CASCADE;
DROP TABLE IF EXISTS email_templates CASCADE;
DROP TABLE IF EXISTS email_campaigns CASCADE;

-- Email Campaigns
CREATE TABLE email_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Campaign Details
  campaign_name TEXT NOT NULL,
  campaign_type TEXT NOT NULL CHECK (campaign_type IN ('drip_sequence', 'one_time_blast', 'behavioral_trigger', 'nurture', 'reengagement')),
  target_persona TEXT[],
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'paused', 'completed')),
  
  -- Ownership
  created_by_agent_id UUID REFERENCES users(id) ON DELETE CASCADE,
  
  -- Scheduling
  start_date DATE,
  end_date DATE,
  
  -- Metrics
  total_recipients INTEGER DEFAULT 0,
  goal TEXT,
  
  -- AI Features
  ai_optimized BOOLEAN DEFAULT false,
  send_time_optimization BOOLEAN DEFAULT false
);

-- Email Templates
CREATE TABLE email_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Template Content
  template_name TEXT NOT NULL,
  subject_line TEXT NOT NULL,
  preview_text TEXT,
  html_body TEXT NOT NULL,
  plain_text_body TEXT NOT NULL,
  
  -- Configuration
  dynamic_variables JSONB DEFAULT '[]'::jsonb,
  template_category TEXT CHECK (template_category IN ('welcome', 'nurture', 'listing_alert', 'market_update', 'milestone', 'reengagement')),
  persona_optimized_for TEXT,
  
  -- Tracking
  ai_generated BOOLEAN DEFAULT false,
  performance_score NUMERIC DEFAULT 0,
  times_sent INTEGER DEFAULT 0,
  avg_open_rate NUMERIC,
  avg_click_rate NUMERIC
);

-- Drip Sequences
CREATE TABLE email_drip_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  campaign_id UUID REFERENCES email_campaigns(id) ON DELETE CASCADE,
  
  -- Sequence Configuration
  sequence_name TEXT NOT NULL,
  trigger_condition JSONB NOT NULL,
  total_emails INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true
);

-- Drip Sequence Steps
CREATE TABLE drip_sequence_emails (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID REFERENCES email_drip_sequences(id) ON DELETE CASCADE,
  
  -- Step Configuration
  step_number INTEGER NOT NULL,
  template_id UUID REFERENCES email_templates(id) ON DELETE SET NULL,
  
  -- Timing
  delay_days INTEGER DEFAULT 0,
  delay_hours INTEGER DEFAULT 0,
  send_time TIME,
  
  -- Conditions
  conditions JSONB,
  
  UNIQUE(sequence_id, step_number)
);

-- Email Sends (Individual Send Records)
CREATE TABLE email_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES email_campaigns(id) ON DELETE CASCADE,
  template_id UUID REFERENCES email_templates(id) ON DELETE SET NULL,
  lead_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  
  -- Timing
  sent_at TIMESTAMPTZ,
  scheduled_for TIMESTAMPTZ,
  
  -- Status
  status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sent', 'delivered', 'bounced', 'failed')),
  
  -- Integration
  ghl_message_id TEXT,
  personalization_data JSONB,
  
  -- Error tracking
  error_message TEXT,
  retry_count INTEGER DEFAULT 0
);

-- Email Engagement Tracking
CREATE TABLE email_engagement (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email_send_id UUID REFERENCES email_sends(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  
  -- Opens
  opened_at TIMESTAMPTZ,
  open_count INTEGER DEFAULT 0,
  last_opened_at TIMESTAMPTZ,
  
  -- Clicks
  clicked_at TIMESTAMPTZ,
  click_count INTEGER DEFAULT 0,
  clicked_links TEXT[],
  last_clicked_at TIMESTAMPTZ,
  
  -- Actions
  unsubscribed_at TIMESTAMPTZ,
  replied_at TIMESTAMPTZ,
  spam_reported_at TIMESTAMPTZ,
  
  -- Device/Location
  device_type TEXT,
  user_agent TEXT,
  ip_address TEXT
);

-- A/B Test Campaigns
CREATE TABLE ab_test_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES email_campaigns(id) ON DELETE CASCADE,
  
  -- Variants
  variant_a_template_id UUID REFERENCES email_templates(id),
  variant_b_template_id UUID REFERENCES email_templates(id),
  
  -- Configuration
  split_percentage INTEGER DEFAULT 50,
  test_duration_hours INTEGER DEFAULT 48,
  test_variable TEXT, -- subject_line, email_length, cta_placement, etc
  
  -- Results
  winner_template_id UUID REFERENCES email_templates(id),
  declared_winner_at TIMESTAMPTZ,
  
  -- Metrics
  variant_a_sent INTEGER DEFAULT 0,
  variant_a_opens INTEGER DEFAULT 0,
  variant_a_clicks INTEGER DEFAULT 0,
  variant_b_sent INTEGER DEFAULT 0,
  variant_b_opens INTEGER DEFAULT 0,
  variant_b_clicks INTEGER DEFAULT 0,
  
  results_summary JSONB
);

-- Send Time Optimization (Per Lead)
CREATE TABLE send_time_optimization (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES contacts(id) ON DELETE CASCADE UNIQUE,
  
  -- Optimal Timing
  optimal_send_day INTEGER, -- 0=Monday, 6=Sunday
  optimal_send_hour INTEGER, -- 0-23
  timezone TEXT DEFAULT 'America/New_York',
  
  -- Confidence
  confidence_score NUMERIC,
  based_on_data_points INTEGER DEFAULT 0,
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  
  -- Secondary Options
  alternative_times JSONB -- backup send times
);

-- Email List Segments
CREATE TABLE email_list_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Segment Details
  segment_name TEXT NOT NULL,
  agent_id UUID REFERENCES users(id) ON DELETE CASCADE,
  
  -- Criteria
  criteria JSONB NOT NULL,
  is_dynamic BOOLEAN DEFAULT true, -- auto-updates vs static list
  
  -- Stats
  member_count INTEGER DEFAULT 0,
  last_calculated_at TIMESTAMPTZ
);

-- Indexes for Performance
CREATE INDEX IF NOT EXISTS idx_email_campaigns_agent ON email_campaigns(created_by_agent_id) WHERE created_by_agent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_email_campaigns_status ON email_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_email_sends_lead ON email_sends(lead_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_campaign ON email_sends(campaign_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_scheduled ON email_sends(scheduled_for) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_email_engagement_lead ON email_engagement(lead_id);
CREATE INDEX IF NOT EXISTS idx_email_engagement_send ON email_engagement(email_send_id);
CREATE INDEX IF NOT EXISTS idx_drip_sequence_emails_sequence ON drip_sequence_emails(sequence_id);
CREATE INDEX IF NOT EXISTS idx_send_time_optimization_lead ON send_time_optimization(lead_id);

-- Row Level Security
ALTER TABLE email_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_drip_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE drip_sequence_emails ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_engagement ENABLE ROW LEVEL SECURITY;
ALTER TABLE ab_test_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE send_time_optimization ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_list_segments ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Agents manage own campaigns" ON email_campaigns
  FOR ALL USING (
    created_by_agent_id = auth.uid()::uuid OR
    created_by_agent_id IS NULL
  );

CREATE POLICY "Agents access own templates" ON email_templates
  FOR ALL USING (true); -- Templates can be shared

CREATE POLICY "Agents manage own sequences" ON email_drip_sequences
  FOR ALL USING (
    campaign_id IN (SELECT id FROM email_campaigns WHERE created_by_agent_id = auth.uid()::uuid)
  );

CREATE POLICY "Agents access own sends" ON email_sends
  FOR ALL USING (
    campaign_id IN (SELECT id FROM email_campaigns WHERE created_by_agent_id = auth.uid()::uuid)
  );

CREATE POLICY "Agents access engagement data" ON email_engagement
  FOR ALL USING (
    lead_id IN (SELECT id FROM contacts WHERE agent_id = auth.uid()::uuid)
  );

CREATE POLICY "Agents manage own segments" ON email_list_segments
  FOR ALL USING (agent_id = auth.uid()::uuid);
