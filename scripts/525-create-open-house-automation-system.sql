-- =====================================================
-- OPEN HOUSE AUTOMATION SYSTEM
-- Complete event management with AI optimization
-- =====================================================

-- Drop existing tables if they exist
DROP TABLE IF EXISTS open_house_invitation_tracking CASCADE;
DROP TABLE IF EXISTS open_house_analytics CASCADE;
DROP TABLE IF EXISTS open_house_attendees CASCADE;
DROP TABLE IF EXISTS open_house_invitations CASCADE;
DROP TABLE IF EXISTS open_house_timing_recommendations CASCADE;
DROP TABLE IF EXISTS open_house_followup_rules CASCADE;
DROP TABLE IF NOT EXISTS open_house_signin_forms CASCADE;
DROP TABLE IF EXISTS open_houses CASCADE;

-- Open Houses
CREATE TABLE open_houses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  property_id UUID REFERENCES listings(id) ON DELETE SET NULL,
  
  -- Event Details
  title VARCHAR(255) NOT NULL,
  description TEXT,
  property_address TEXT NOT NULL,
  
  -- Scheduling
  event_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  timezone VARCHAR(50) DEFAULT 'America/New_York',
  
  -- AI Optimization
  ai_recommended_time BOOLEAN DEFAULT false,
  optimal_timing_score DECIMAL(3,2), -- 0-1 confidence score
  attendance_prediction INTEGER,
  weather_forecast JSONB, -- {temp, conditions, precipitation_chance}
  
  -- Event Configuration
  max_attendees INTEGER DEFAULT 50,
  require_rsvp BOOLEAN DEFAULT false,
  allow_walkins BOOLEAN DEFAULT true,
  
  -- QR Code & Check-in
  qr_code_url TEXT,
  qr_code_data TEXT, -- unique identifier
  check_in_url TEXT,
  
  -- Status
  status VARCHAR(50) DEFAULT 'draft', -- draft, scheduled, active, completed, cancelled
  is_published BOOLEAN DEFAULT false,
  published_at TIMESTAMPTZ,
  
  -- Performance
  total_invitations_sent INTEGER DEFAULT 0,
  total_rsvps INTEGER DEFAULT 0,
  total_check_ins INTEGER DEFAULT 0,
  total_leads_generated INTEGER DEFAULT 0,
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT
);

-- Event Attendees
CREATE TABLE IF NOT EXISTS open_house_attendees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  open_house_id UUID NOT NULL REFERENCES open_houses(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  
  -- Attendee Info (for walk-ins without contact record)
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  email VARCHAR(255),
  phone VARCHAR(20),
  
  -- RSVP & Attendance
  rsvp_status VARCHAR(50), -- invited, confirmed, declined, tentative, no_response
  rsvp_at TIMESTAMPTZ,
  
  checked_in BOOLEAN DEFAULT false,
  check_in_time TIMESTAMPTZ,
  check_in_method VARCHAR(50), -- qr_code, manual, tablet
  
  check_out_time TIMESTAMPTZ,
  duration_minutes INTEGER,
  
  -- Engagement
  property_interest_level INTEGER, -- 1-5 scale
  follow_up_priority VARCHAR(50), -- hot, warm, cold
  notes TEXT,
  feedback TEXT,
  
  -- Journey Stage (for persona matching)
  buyer_stage VARCHAR(100),
  persona_type VARCHAR(100),
  
  -- Follow-up
  follow_up_sent BOOLEAN DEFAULT false,
  follow_up_sent_at TIMESTAMPTZ,
  follow_up_opened BOOLEAN DEFAULT false,
  follow_up_clicked BOOLEAN DEFAULT false,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Invitation Templates
CREATE TABLE IF NOT EXISTS open_house_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  
  template_name VARCHAR(255) NOT NULL,
  template_type VARCHAR(50), -- email, sms, social_post
  
  -- Content
  subject_line VARCHAR(255),
  email_body_html TEXT,
  email_body_plain TEXT,
  sms_body TEXT,
  
  -- Personalization Variables
  personalization_fields JSONB, -- {contact_name, property_address, event_date, etc}
  
  -- AI Generated
  is_ai_generated BOOLEAN DEFAULT false,
  target_persona VARCHAR(100),
  
  is_default BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Invitation Tracking
CREATE TABLE IF NOT EXISTS open_house_invitation_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  open_house_id UUID NOT NULL REFERENCES open_houses(id) ON DELETE CASCADE,
  attendee_id UUID REFERENCES open_house_attendees(id) ON DELETE CASCADE,
  invitation_id UUID REFERENCES open_house_invitations(id) ON DELETE SET NULL,
  
  -- Delivery
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  delivery_method VARCHAR(50), -- email, sms, social
  delivery_status VARCHAR(50), -- sent, delivered, bounced, failed
  
  -- Engagement
  opened BOOLEAN DEFAULT false,
  opened_at TIMESTAMPTZ,
  open_count INTEGER DEFAULT 0,
  
  clicked BOOLEAN DEFAULT false,
  clicked_at TIMESTAMPTZ,
  click_count INTEGER DEFAULT 0,
  
  -- Response
  responded BOOLEAN DEFAULT false,
  response_type VARCHAR(50), -- rsvp_yes, rsvp_no, rsvp_maybe
  responded_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Open House Performance Analytics
CREATE TABLE IF NOT EXISTS open_house_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  open_house_id UUID NOT NULL REFERENCES open_houses(id) ON DELETE CASCADE,
  
  -- Invitation Metrics
  total_invited INTEGER DEFAULT 0,
  total_delivered INTEGER DEFAULT 0,
  delivery_rate DECIMAL(5,2),
  
  total_opened INTEGER DEFAULT 0,
  open_rate DECIMAL(5,2),
  
  total_clicked INTEGER DEFAULT 0,
  click_rate DECIMAL(5,2),
  
  -- RSVP Metrics
  total_rsvp_yes INTEGER DEFAULT 0,
  total_rsvp_no INTEGER DEFAULT 0,
  total_rsvp_maybe INTEGER DEFAULT 0,
  rsvp_rate DECIMAL(5,2),
  
  -- Attendance Metrics
  total_checked_in INTEGER DEFAULT 0,
  total_walkins INTEGER DEFAULT 0,
  attendance_rate DECIMAL(5,2), -- check-ins / RSVPs
  show_up_rate DECIMAL(5,2), -- check-ins / invited
  
  avg_duration_minutes DECIMAL(6,2),
  
  -- Lead Quality
  hot_leads INTEGER DEFAULT 0,
  warm_leads INTEGER DEFAULT 0,
  cold_leads INTEGER DEFAULT 0,
  
  -- Conversion
  follow_up_sent INTEGER DEFAULT 0,
  follow_up_opened INTEGER DEFAULT 0,
  offers_made INTEGER DEFAULT 0,
  
  -- Timing Analysis
  peak_attendance_time TIME,
  busiest_15min_slot TIME,
  
  -- Demographic Breakdown
  persona_breakdown JSONB, -- {first_time_buyer: 5, luxury: 2, etc}
  
  -- ROI
  total_leads_cost DECIMAL(10,2),
  cost_per_lead DECIMAL(10,2),
  
  calculated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(open_house_id)
);

-- AI Timing Recommendations
CREATE TABLE IF NOT EXISTS open_house_timing_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  property_id UUID REFERENCES listings(id) ON DELETE SET NULL,
  
  -- Recommended Timing
  recommended_date DATE NOT NULL,
  recommended_start_time TIME NOT NULL,
  recommended_end_time TIME NOT NULL,
  
  -- Confidence & Reasoning
  confidence_score DECIMAL(3,2), -- 0-1
  reasoning TEXT,
  factors_considered JSONB, -- {weather, competitor_events, historical_performance, etc}
  
  -- Predictions
  predicted_attendance INTEGER,
  predicted_lead_quality VARCHAR(50), -- high, medium, low
  
  -- Historical Context
  similar_events_avg_attendance INTEGER,
  market_activity_level VARCHAR(50), -- high, medium, low
  
  -- Weather
  weather_score DECIMAL(3,2), -- 0-1 (1 = perfect weather)
  temperature_forecast INTEGER,
  conditions VARCHAR(100),
  
  -- Competition
  competing_events_count INTEGER,
  competing_events JSONB,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ DEFAULT (NOW() + INTERVAL '7 days')
);

-- Follow-up Automation Rules
CREATE TABLE IF NOT EXISTS open_house_followup_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  
  rule_name VARCHAR(255) NOT NULL,
  
  -- Trigger Conditions
  trigger_condition VARCHAR(100), -- checked_in, high_interest, no_show, etc
  interest_level_min INTEGER, -- 1-5
  interest_level_max INTEGER,
  
  -- Timing
  delay_hours INTEGER DEFAULT 24, -- hours after event to send
  send_time TIME, -- preferred time of day (e.g., 10:00 AM)
  
  -- Content
  template_id UUID REFERENCES open_house_invitations(id),
  message_type VARCHAR(50), -- email, sms, both
  
  -- Personalization
  ai_personalize BOOLEAN DEFAULT true,
  include_property_details BOOLEAN DEFAULT true,
  include_similar_listings BOOLEAN DEFAULT false,
  
  is_active BOOLEAN DEFAULT true,
  priority INTEGER DEFAULT 5,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Sign-in Form Configurations
CREATE TABLE IF NOT EXISTS open_house_signin_forms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  
  form_name VARCHAR(255) NOT NULL,
  
  -- Fields Configuration
  collect_email BOOLEAN DEFAULT true,
  require_email BOOLEAN DEFAULT true,
  
  collect_phone BOOLEAN DEFAULT true,
  require_phone BOOLEAN DEFAULT false,
  
  collect_address BOOLEAN DEFAULT false,
  require_address BOOLEAN DEFAULT false,
  
  collect_prequalified BOOLEAN DEFAULT true,
  collect_working_with_agent BOOLEAN DEFAULT true,
  collect_property_interest BOOLEAN DEFAULT true,
  collect_timeline BOOLEAN DEFAULT true,
  collect_price_range BOOLEAN DEFAULT false,
  
  -- Custom Fields
  custom_fields JSONB, -- [{field_name, field_type, required, options}]
  
  -- Compliance
  require_data_consent BOOLEAN DEFAULT true,
  consent_text TEXT,
  
  -- UI Customization
  theme_color VARCHAR(7) DEFAULT '#3b82f6',
  logo_url TEXT,
  welcome_message TEXT,
  thank_you_message TEXT,
  
  is_default BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- INDEXES
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_open_houses_agent_id ON open_houses(agent_id);
CREATE INDEX IF NOT EXISTS idx_open_houses_property_id ON open_houses(property_id);
CREATE INDEX IF NOT EXISTS idx_open_houses_event_date ON open_houses(event_date);
CREATE INDEX IF NOT EXISTS idx_open_houses_status ON open_houses(status);

CREATE INDEX IF NOT EXISTS idx_attendees_open_house_id ON open_house_attendees(open_house_id);
CREATE INDEX IF NOT EXISTS idx_attendees_contact_id ON open_house_attendees(contact_id);
CREATE INDEX IF NOT EXISTS idx_attendees_email ON open_house_attendees(email);
CREATE INDEX IF NOT EXISTS idx_attendees_rsvp_status ON open_house_attendees(rsvp_status);

CREATE INDEX IF NOT EXISTS idx_invitation_tracking_open_house_id ON open_house_invitation_tracking(open_house_id);
CREATE INDEX IF NOT EXISTS idx_invitation_tracking_attendee_id ON open_house_invitation_tracking(attendee_id);

CREATE INDEX IF NOT EXISTS idx_timing_recommendations_agent_id ON open_house_timing_recommendations(agent_id);
CREATE INDEX IF NOT EXISTS idx_timing_recommendations_property_id ON open_house_timing_recommendations(property_id);

-- =====================================================
-- ROW LEVEL SECURITY
-- =====================================================

ALTER TABLE open_houses ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_house_attendees ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_house_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_house_invitation_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_house_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_house_timing_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_house_followup_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_house_signin_forms ENABLE ROW LEVEL SECURITY;

-- Agents see their own open houses
CREATE POLICY "Agents view own open houses" ON open_houses
  FOR SELECT USING (agent_id = auth.uid()::uuid);

CREATE POLICY "Agents insert own open houses" ON open_houses
  FOR INSERT WITH CHECK (agent_id = auth.uid()::uuid);

CREATE POLICY "Agents update own open houses" ON open_houses
  FOR UPDATE USING (agent_id = auth.uid()::uuid);

-- Attendees policies
CREATE POLICY "View attendees of own events" ON open_house_attendees
  FOR SELECT USING (
    open_house_id IN (SELECT id FROM open_houses WHERE agent_id = auth.uid()::uuid)
  );

CREATE POLICY "Insert attendees to own events" ON open_house_attendees
  FOR INSERT WITH CHECK (
    open_house_id IN (SELECT id FROM open_houses WHERE agent_id = auth.uid()::uuid)
  );

-- Invitations policies
CREATE POLICY "Agents view own invitations" ON open_house_invitations
  FOR SELECT USING (agent_id = auth.uid()::uuid);

CREATE POLICY "Agents manage own invitations" ON open_house_invitations
  FOR ALL USING (agent_id = auth.uid()::uuid);

-- Timing recommendations policies
CREATE POLICY "Agents view own timing recommendations" ON open_house_timing_recommendations
  FOR SELECT USING (agent_id = auth.uid()::uuid);

-- Analytics policies
CREATE POLICY "View analytics of own events" ON open_house_analytics
  FOR SELECT USING (
    open_house_id IN (SELECT id FROM open_houses WHERE agent_id = auth.uid()::uuid)
  );

-- Follow-up rules policies
CREATE POLICY "Agents manage own followup rules" ON open_house_followup_rules
  FOR ALL USING (agent_id = auth.uid()::uuid);

-- Sign-in forms policies
CREATE POLICY "Agents manage own signin forms" ON open_house_signin_forms
  FOR ALL USING (agent_id = auth.uid()::uuid);
