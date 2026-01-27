-- =====================================================
-- OPEN HOUSE AUTOMATION SYSTEM V2
-- AI-powered event management with predictive optimization
-- =====================================================

-- Drop existing tables if they exist
DROP TABLE IF EXISTS open_house_feedback_responses CASCADE;
DROP TABLE IF EXISTS open_house_rsvp_tracking CASCADE;
DROP TABLE IF EXISTS open_house_analytics CASCADE;
DROP TABLE IF EXISTS open_house_attendees CASCADE;
DROP TABLE IF EXISTS open_house_invitations CASCADE;
DROP TABLE IF EXISTS open_house_events CASCADE;

-- =====================================================
-- 1. OPEN HOUSE EVENTS
-- =====================================================
CREATE TABLE open_house_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  
  -- Property & Transaction
  property_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  
  -- Scheduling
  event_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  
  -- Hosting
  hosting_agent_id UUID REFERENCES users(id) ON DELETE CASCADE,
  co_host_agent_id UUID REFERENCES users(id) ON DELETE SET NULL,
  
  -- Status
  status VARCHAR(50) DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'invitations_sent', 'in_progress', 'completed', 'cancelled')),
  
  -- AI Predictions & Optimization
  predicted_attendance INTEGER,
  actual_attendance INTEGER DEFAULT 0,
  serious_buyer_count INTEGER DEFAULT 0,
  ai_optimization_score DECIMAL(5,2) CHECK (ai_optimization_score >= 0 AND ai_optimization_score <= 100),
  
  -- Marketing
  marketing_reach INTEGER DEFAULT 0,
  
  -- Digital Sign-In
  qr_code_url TEXT,
  qr_code_data TEXT,
  
  -- Event Details
  special_features JSONB, -- {refreshments: true, activities: [], giveaways: []}
  weather_forecast JSONB, -- {temp, conditions, precipitation_chance, fetched_at}
  competing_events JSONB, -- [{address, distance_miles, same_time: boolean}]
  parking_instructions TEXT,
  agent_notes TEXT,
  public_description TEXT,
  event_photos_url TEXT[],
  
  -- Conversion Metrics
  offers_received_during INTEGER DEFAULT 0
);

-- Indexes for open_house_events
CREATE INDEX idx_oh_events_date ON open_house_events(event_date);
CREATE INDEX idx_oh_events_status ON open_house_events(status);
CREATE INDEX idx_oh_events_property ON open_house_events(property_id);
CREATE INDEX idx_oh_events_agent ON open_house_events(hosting_agent_id);

-- =====================================================
-- 2. OPEN HOUSE ATTENDEES
-- =====================================================
CREATE TABLE open_house_attendees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES open_house_events(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  
  -- Check-in/out
  check_in_time TIMESTAMPTZ,
  check_out_time TIMESTAMPTZ,
  
  -- Contact Info
  contact_name TEXT NOT NULL,
  contact_email TEXT,
  contact_phone TEXT,
  
  -- Lead Connection
  is_existing_lead BOOLEAN DEFAULT false,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  
  -- Sign-in Method
  signed_in_method VARCHAR(50) CHECK (signed_in_method IN ('qr_code', 'manual_tablet', 'manual_paper', 'agent_entered')),
  
  -- Agent Identification
  is_agent BOOLEAN DEFAULT false,
  agent_brokerage TEXT,
  representing_client BOOLEAN DEFAULT false,
  
  -- Interest & Feedback
  interest_level VARCHAR(50) CHECK (interest_level IN ('just_looking', 'somewhat_interested', 'very_interested', 'ready_to_offer', 'not_interested')),
  property_fit_score INTEGER CHECK (property_fit_score >= 1 AND property_fit_score <= 10),
  feedback_rating INTEGER CHECK (feedback_rating >= 1 AND feedback_rating <= 5),
  feedback_comments TEXT,
  feedback_collected_at TIMESTAMPTZ,
  
  -- Engagement Details
  specific_questions TEXT[],
  rooms_most_interested_in TEXT[],
  concerns_mentioned TEXT[],
  
  -- Follow-up
  followed_up BOOLEAN DEFAULT false,
  follow_up_scheduled_at TIMESTAMPTZ,
  
  -- AI Scoring
  ai_lead_score DECIMAL(5,2) CHECK (ai_lead_score >= 0 AND ai_lead_score <= 100),
  
  -- Conversion Tracking
  conversion_outcome VARCHAR(50) CHECK (conversion_outcome IN ('no_action', 'showing_scheduled', 'offer_made', 'bought_different', 'lost')),
  
  -- Time Tracking
  time_spent_minutes INTEGER,
  
  -- Device Info
  device_info JSONB -- {browser, device_type, ip_address}
);

-- Indexes for open_house_attendees
CREATE INDEX idx_oh_attendees_event ON open_house_attendees(event_id);
CREATE INDEX idx_oh_attendees_lead ON open_house_attendees(lead_id);
CREATE INDEX idx_oh_attendees_interest ON open_house_attendees(interest_level);
CREATE INDEX idx_oh_attendees_score ON open_house_attendees(ai_lead_score DESC);

-- =====================================================
-- 3. OPEN HOUSE INVITATIONS
-- =====================================================
CREATE TABLE open_house_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES open_house_events(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now(),
  
  -- Delivery
  sent_at TIMESTAMPTZ,
  channel VARCHAR(50) CHECK (channel IN ('email', 'sms', 'both', 'none')),
  email_message_id TEXT,
  sms_message_id TEXT,
  
  -- Content
  personalized_message TEXT,
  match_score DECIMAL(5,2) CHECK (match_score >= 0 AND match_score <= 100),
  match_reasoning TEXT,
  
  -- Engagement Tracking
  opened_email BOOLEAN DEFAULT false,
  opened_at TIMESTAMPTZ,
  clicked BOOLEAN DEFAULT false,
  clicked_at TIMESTAMPTZ,
  
  -- RSVP
  rsvp_status VARCHAR(50) DEFAULT 'pending' CHECK (rsvp_status IN ('pending', 'yes', 'maybe', 'no', 'no_response')),
  rsvp_at TIMESTAMPTZ,
  attended BOOLEAN DEFAULT false,
  
  -- Reminders
  reminder_sent BOOLEAN DEFAULT false,
  reminder_sent_at TIMESTAMPTZ
);

-- Indexes for open_house_invitations
CREATE INDEX idx_oh_invites_event ON open_house_invitations(event_id);
CREATE INDEX idx_oh_invites_lead ON open_house_invitations(lead_id);
CREATE INDEX idx_oh_invites_rsvp ON open_house_invitations(rsvp_status);
CREATE INDEX idx_oh_invites_match ON open_house_invitations(match_score DESC);

-- =====================================================
-- 4. OPEN HOUSE ANALYTICS
-- =====================================================
CREATE TABLE open_house_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL UNIQUE REFERENCES open_house_events(id) ON DELETE CASCADE,
  analyzed_at TIMESTAMPTZ DEFAULT now(),
  
  -- Invitation Metrics
  total_invites_sent INTEGER,
  email_open_rate DECIMAL(5,2),
  email_click_rate DECIMAL(5,2),
  sms_response_rate DECIMAL(5,2),
  
  -- RSVP Metrics
  rsvp_yes_count INTEGER,
  rsvp_maybe_count INTEGER,
  rsvp_no_count INTEGER,
  
  -- Attendance Metrics
  total_attendance INTEGER,
  attendance_vs_predicted_diff INTEGER,
  prediction_accuracy_percentage DECIMAL(5,2),
  new_leads_generated INTEGER,
  existing_leads_attended INTEGER,
  serious_buyers_count INTEGER,
  
  -- Engagement Metrics
  avg_time_spent_minutes DECIMAL(5,2),
  shortest_visit_minutes INTEGER,
  longest_visit_minutes INTEGER,
  feedback_avg_rating DECIMAL(3,2),
  
  -- Conversion Metrics
  conversion_to_showing INTEGER,
  offers_generated INTEGER,
  
  -- Advanced Metrics
  weather_impact_score DECIMAL(5,2),
  roi_estimate DECIMAL(10,2),
  cost_per_attendee DECIMAL(10,2),
  hot_lead_percentage DECIMAL(5,2)
);

-- Index for analytics
CREATE INDEX idx_oh_analytics_event ON open_house_analytics(event_id);

-- =====================================================
-- 5. OPEN HOUSE FEEDBACK RESPONSES
-- =====================================================
CREATE TABLE open_house_feedback_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  attendee_id UUID NOT NULL REFERENCES open_house_attendees(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES open_house_events(id) ON DELETE CASCADE,
  submitted_at TIMESTAMPTZ DEFAULT now(),
  
  -- Ratings & Feedback
  overall_rating INTEGER CHECK (overall_rating >= 1 AND overall_rating <= 5),
  what_liked_most TEXT,
  concerns_about_property TEXT,
  compared_to_other_homes TEXT,
  
  -- Decision Indicators
  pricing_feedback VARCHAR(50) CHECK (pricing_feedback IN ('overpriced', 'fair', 'underpriced', 'unsure')),
  would_make_offer VARCHAR(50) CHECK (would_make_offer IN ('yes', 'maybe', 'no', 'need_more_time')),
  interested_in_similar BOOLEAN,
  
  -- Follow-up Preferences
  preferred_follow_up VARCHAR(50) CHECK (preferred_follow_up IN ('call', 'text', 'email', 'none')),
  best_time_to_contact TEXT,
  additional_comments TEXT
);

-- Indexes for feedback
CREATE INDEX idx_oh_feedback_attendee ON open_house_feedback_responses(attendee_id);
CREATE INDEX idx_oh_feedback_event ON open_house_feedback_responses(event_id);

-- =====================================================
-- 6. OPEN HOUSE RSVP TRACKING
-- =====================================================
CREATE TABLE open_house_rsvp_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES open_house_events(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
  
  -- RSVP Link Tracking
  rsvp_token TEXT UNIQUE NOT NULL,
  accessed_at TIMESTAMPTZ,
  
  -- RSVP Details
  rsvp_status VARCHAR(50) CHECK (rsvp_status IN ('yes', 'maybe', 'no')),
  guests_count INTEGER DEFAULT 1,
  special_requests TEXT,
  contact_info_confirmed BOOLEAN DEFAULT false
);

-- Indexes for RSVP tracking
CREATE INDEX idx_oh_rsvp_event ON open_house_rsvp_tracking(event_id);
CREATE INDEX idx_oh_rsvp_lead ON open_house_rsvp_tracking(lead_id);
CREATE INDEX idx_oh_rsvp_token ON open_house_rsvp_tracking(rsvp_token);

-- =====================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- =====================================================

-- Enable RLS
ALTER TABLE open_house_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_house_attendees ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_house_invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_house_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_house_feedback_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_house_rsvp_tracking ENABLE ROW LEVEL SECURITY;

-- Events policies
CREATE POLICY "Agents manage own events" ON open_house_events
  FOR ALL USING (hosting_agent_id = auth.uid()::uuid OR co_host_agent_id = auth.uid()::uuid);

-- Attendees policies
CREATE POLICY "Agents view event attendees" ON open_house_attendees
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM open_house_events 
      WHERE id = event_id 
      AND (hosting_agent_id = auth.uid()::uuid OR co_host_agent_id = auth.uid()::uuid)
    )
  );

CREATE POLICY "Anyone can sign in to events" ON open_house_attendees
  FOR INSERT WITH CHECK (true);

-- Invitations policies
CREATE POLICY "Agents manage event invitations" ON open_house_invitations
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM open_house_events 
      WHERE id = event_id 
      AND (hosting_agent_id = auth.uid()::uuid OR co_host_agent_id = auth.uid()::uuid)
    )
  );

-- Analytics policies
CREATE POLICY "Agents view event analytics" ON open_house_analytics
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM open_house_events 
      WHERE id = event_id 
      AND (hosting_agent_id = auth.uid()::uuid OR co_host_agent_id = auth.uid()::uuid)
    )
  );

-- Feedback policies
CREATE POLICY "Anyone can submit feedback" ON open_house_feedback_responses
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Agents view event feedback" ON open_house_feedback_responses
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM open_house_events 
      WHERE id = event_id 
      AND (hosting_agent_id = auth.uid()::uuid OR co_host_agent_id = auth.uid()::uuid)
    )
  );

-- RSVP policies
CREATE POLICY "Anyone with token can RSVP" ON open_house_rsvp_tracking
  FOR ALL USING (true);
