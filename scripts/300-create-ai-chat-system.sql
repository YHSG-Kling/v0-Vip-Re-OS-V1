-- AI Chat System Database Schema
-- Comprehensive chat interface with Them-First analysis, compliance checking, and lead intelligence

-- Chat Sessions Table
CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID REFERENCES users(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  session_type TEXT NOT NULL CHECK (session_type IN ('lead_qualification', 'client_support', 'transaction_help', 'market_insights')),
  session_status TEXT DEFAULT 'active' CHECK (session_status IN ('active', 'completed', 'archived')),
  context_data JSONB DEFAULT '{}',
  them_first_score INTEGER DEFAULT 0 CHECK (them_first_score BETWEEN 0 AND 100),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ DEFAULT NOW(),
  lead_temperature TEXT DEFAULT 'cold' CHECK (lead_temperature IN ('hot', 'warm', 'cold')), -- Add lead_temperature column to track chat engagement temperature
  temperature_analysis JSONB DEFAULT '{}', -- Store detailed sentiment analysis from last client message
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chat Messages Table
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE NOT NULL,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('agent', 'client', 'ai_assistant', 'system')), -- Added 'client' sender type
  sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
  message_content TEXT NOT NULL,
  message_type TEXT DEFAULT 'text' CHECK (message_type IN ('text', 'suggestion', 'data_insight', 'compliance_warning')),
  metadata JSONB DEFAULT '{}',
  them_first_analysis JSONB,
  compliance_flagged BOOLEAN DEFAULT false,
  compliance_issues JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI Suggestions Table
CREATE TABLE IF NOT EXISTS ai_suggestions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE NOT NULL,
  suggestion_type TEXT NOT NULL CHECK (suggestion_type IN ('response_template', 'next_action', 'lead_insight', 'market_data')),
  suggestion_content JSONB NOT NULL,
  confidence_score DECIMAL(3,2) CHECK (confidence_score BETWEEN 0 AND 1),
  was_accepted BOOLEAN DEFAULT false,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent Chat Preferences Table
CREATE TABLE IF NOT EXISTS agent_chat_preferences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE NOT NULL,
  auto_suggest_responses BOOLEAN DEFAULT true,
  them_first_coaching BOOLEAN DEFAULT true,
  compliance_alerts BOOLEAN DEFAULT true,
  lead_insights_enabled BOOLEAN DEFAULT true,
  preferred_tone TEXT DEFAULT 'professional' CHECK (preferred_tone IN ('professional', 'friendly', 'consultative')),
  custom_prompts JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chat Templates Table (Them-First Approved)
CREATE TABLE IF NOT EXISTS chat_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_name TEXT NOT NULL,
  template_category TEXT NOT NULL CHECK (template_category IN ('greeting', 'follow_up', 'objection_handling', 'value_prop', 'scheduling', 'closing')),
  template_content TEXT NOT NULL,
  target_scenario TEXT,
  them_first_score INTEGER DEFAULT 0 CHECK (them_first_score BETWEEN 0 AND 100),
  compliance_approved BOOLEAN DEFAULT false,
  approval_id UUID,
  allowed_lead_types TEXT[] DEFAULT ARRAY['cold', 'warm', 'hot', 'active', 'past'],
  usage_count INTEGER DEFAULT 0,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Lead Conversation History Table (for context aggregation)
CREATE TABLE IF NOT EXISTS lead_conversation_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES contacts(id) ON DELETE CASCADE NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('chat', 'email', 'sms', 'call', 'social')),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  message_content TEXT,
  sentiment_score DECIMAL(3,2) CHECK (sentiment_score BETWEEN -1 AND 1),
  intent_detected TEXT[] DEFAULT ARRAY[]::TEXT[],
  ai_summary TEXT,
  occurred_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Message Access Control Table (extends RBAC to conversations)
CREATE TABLE IF NOT EXISTS message_access_control (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE NOT NULL,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  user_type TEXT NOT NULL CHECK (user_type IN ('agent', 'client', 'admin', 'broker')),
  can_read BOOLEAN DEFAULT true,
  can_write BOOLEAN DEFAULT true,
  granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  UNIQUE(conversation_id, user_id)
);

-- Indexes for Performance
CREATE INDEX IF NOT EXISTS idx_chat_sessions_agent_activity ON chat_sessions(agent_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_lead ON chat_sessions(lead_id);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_status ON chat_sessions(session_status, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created ON chat_messages(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_sender ON chat_messages(sender_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_suggestions_session ON ai_suggestions(session_id, was_accepted, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_templates_category ON chat_templates(template_category, compliance_approved);
CREATE INDEX IF NOT EXISTS idx_chat_templates_usage ON chat_templates(usage_count DESC);
CREATE INDEX IF NOT EXISTS idx_lead_conversation_history_lead_time ON lead_conversation_history(lead_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_lead_conversation_history_channel ON lead_conversation_history(channel, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_message_access_control_conversation ON message_access_control(conversation_id, user_id);

-- Row Level Security (RLS) Policies
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_chat_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_conversation_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_access_control ENABLE ROW LEVEL SECURITY;

-- Chat Sessions RLS: Agents see their own sessions, admins/brokers see all
CREATE POLICY chat_sessions_select_policy ON chat_sessions
  FOR SELECT USING (
    agent_id = auth.uid() OR
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.user_type IN ('admin', 'broker', 'compliance')
    )
  );

CREATE POLICY chat_sessions_insert_policy ON chat_sessions
  FOR INSERT WITH CHECK (agent_id = auth.uid());

CREATE POLICY chat_sessions_update_policy ON chat_sessions
  FOR UPDATE USING (
    agent_id = auth.uid() OR
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.user_type IN ('admin', 'broker')
    )
  );

-- Chat Messages RLS: Access based on session ownership or message_access_control
CREATE POLICY chat_messages_select_policy ON chat_messages
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM chat_sessions
      WHERE chat_sessions.id = chat_messages.session_id
      AND (
        chat_sessions.agent_id = auth.uid() OR
        EXISTS (
          SELECT 1 FROM message_access_control
          WHERE message_access_control.conversation_id = chat_sessions.id
          AND message_access_control.user_id = auth.uid()
          AND message_access_control.can_read = true
          AND (message_access_control.expires_at IS NULL OR message_access_control.expires_at > NOW())
        )
      )
    )
  );

CREATE POLICY chat_messages_insert_policy ON chat_messages
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM chat_sessions
      WHERE chat_sessions.id = chat_messages.session_id
      AND (
        chat_sessions.agent_id = auth.uid() OR
        EXISTS (
          SELECT 1 FROM message_access_control
          WHERE message_access_control.conversation_id = chat_sessions.id
          AND message_access_control.user_id = auth.uid()
          AND message_access_control.can_write = true
          AND (message_access_control.expires_at IS NULL OR message_access_control.expires_at > NOW())
        )
      )
    )
  );

-- AI Suggestions RLS: Same as chat messages
CREATE POLICY ai_suggestions_select_policy ON ai_suggestions
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM chat_sessions
      WHERE chat_sessions.id = ai_suggestions.session_id
      AND chat_sessions.agent_id = auth.uid()
    )
  );

CREATE POLICY ai_suggestions_update_policy ON ai_suggestions
  FOR UPDATE USING (
    EXISTS (
      SELECT 1 FROM chat_sessions
      WHERE chat_sessions.id = ai_suggestions.session_id
      AND chat_sessions.agent_id = auth.uid()
    )
  );

-- Agent Preferences RLS: Agents can only see/edit their own
CREATE POLICY agent_chat_preferences_all_policy ON agent_chat_preferences
  FOR ALL USING (agent_id = auth.uid());

-- Chat Templates RLS: Everyone can read approved templates, creators can edit their own
CREATE POLICY chat_templates_select_policy ON chat_templates
  FOR SELECT USING (compliance_approved = true OR created_by = auth.uid());

CREATE POLICY chat_templates_insert_policy ON chat_templates
  FOR INSERT WITH CHECK (created_by = auth.uid());

CREATE POLICY chat_templates_update_policy ON chat_templates
  FOR UPDATE USING (
    created_by = auth.uid() OR
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.user_type IN ('admin', 'compliance')
    )
  );

-- Lead Conversation History RLS: Based on lead access
CREATE POLICY lead_conversation_history_select_policy ON lead_conversation_history
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM contacts
      WHERE contacts.id = lead_conversation_history.lead_id
      AND (
        contacts.agent_id = auth.uid() OR
        EXISTS (
          SELECT 1 FROM users
          WHERE users.id = auth.uid()
          AND users.user_type IN ('admin', 'broker', 'compliance')
        )
      )
    )
  );

CREATE POLICY lead_conversation_history_insert_policy ON lead_conversation_history
  FOR INSERT WITH CHECK (
    EXISTS (
      SELECT 1 FROM contacts
      WHERE contacts.id = lead_conversation_history.lead_id
      AND contacts.agent_id = auth.uid()
    )
  );

-- Message Access Control RLS: Admins and granted users can manage
CREATE POLICY message_access_control_select_policy ON message_access_control
  FOR SELECT USING (
    user_id = auth.uid() OR
    granted_by = auth.uid() OR
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.user_type IN ('admin', 'broker')
    )
  );

CREATE POLICY message_access_control_insert_policy ON message_access_control
  FOR INSERT WITH CHECK (
    granted_by = auth.uid() OR
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.user_type IN ('admin', 'broker')
    )
  );

-- Seed Initial Chat Templates
INSERT INTO chat_templates (template_name, template_category, template_content, target_scenario, them_first_score, compliance_approved, allowed_lead_types)
VALUES
  ('Warm Introduction', 'greeting', 'Hi {first_name}, I noticed you''re interested in {city} real estate. What matters most to you in finding your ideal home?', 'First contact with warm lead', 85, true, ARRAY['warm', 'hot']),
  ('Cold Email Introduction', 'greeting', 'Hi {first_name}, you deserve a stress-free home buying experience in {city}. I''d love to learn about your goals and timeline when you''re ready to chat.', 'First email to cold lead', 90, true, ARRAY['cold']),
  ('Follow-Up Value', 'follow_up', 'Hi {first_name}, I wanted to share some insights about the {city} market that might interest you. Your timeline and priorities matter - let me know when you''d like to discuss.', 'Following up after initial contact', 88, true, ARRAY['warm', 'hot', 'cold']),
  ('Objection - Price', 'objection_handling', 'I understand price is important to you. Let''s explore options that fit your budget while meeting your needs. Your financial comfort matters most.', 'When lead expresses price concerns', 92, true, ARRAY['warm', 'hot']),
  ('Value Proposition', 'value_prop', 'You deserve expert guidance through every step of your real estate journey. Your goals, your timeline, your success - that''s what drives everything we do.', 'Explaining value without being salesy', 95, true, ARRAY['warm', 'hot', 'active']),
  ('Scheduling Meeting', 'scheduling', 'What days and times work best for your schedule? I want to make sure we connect when it''s most convenient for you.', 'Setting up a call or meeting', 87, true, ARRAY['warm', 'hot', 'active'])
ON CONFLICT DO NOTHING;

-- Add function to automatically calculate lead temperature based on last activity
CREATE OR REPLACE FUNCTION calculate_lead_temperature()
RETURNS TRIGGER AS $$
BEGIN
  -- Calculate temperature based on time since last activity
  -- Hot: activity within last hour
  -- Warm: activity within last 24 hours
  -- Cold: activity more than 24 hours ago
  
  IF (NOW() - NEW.last_activity_at) < INTERVAL '1 hour' THEN
    NEW.lead_temperature := 'hot';
  ELSIF (NOW() - NEW.last_activity_at) < INTERVAL '24 hours' THEN
    NEW.lead_temperature := 'warm';
  ELSE
    NEW.lead_temperature := 'cold';
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Add trigger to automatically update lead temperature on activity
CREATE TRIGGER update_lead_temperature_on_activity
  BEFORE INSERT OR UPDATE OF last_activity_at ON chat_sessions
  FOR EACH ROW
  EXECUTE FUNCTION calculate_lead_temperature();

COMMIT;
