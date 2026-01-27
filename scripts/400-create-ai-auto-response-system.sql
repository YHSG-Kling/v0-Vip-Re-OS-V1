-- AI Auto-Response System Tables
-- This migration creates tables for automated messaging with AI-powered responses

-- Enable UUID extension if not already enabled
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Conversations table to track unified message threads
CREATE TABLE IF NOT EXISTS conversations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  channel VARCHAR(50) NOT NULL CHECK (channel IN ('sms', 'email', 'whatsapp', 'facebook', 'instagram', 'twitter')),
  status VARCHAR(50) DEFAULT 'active' CHECK (status IN ('active', 'archived', 'closed')),
  last_message_at TIMESTAMPTZ DEFAULT NOW(),
  unread_count INTEGER DEFAULT 0,
  assigned_agent_id UUID REFERENCES users(id) ON DELETE SET NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Messages table to store all conversation messages
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  sender_type VARCHAR(50) NOT NULL CHECK (sender_type IN ('contact', 'agent', 'ai', 'system')),
  sender_id UUID REFERENCES users(id) ON DELETE SET NULL,
  ai_generated BOOLEAN DEFAULT FALSE,
  ai_model VARCHAR(100),
  ai_confidence DECIMAL(5,2),
  response_time_ms INTEGER,
  read_at TIMESTAMPTZ,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Auto-response settings per agent
CREATE TABLE IF NOT EXISTS auto_response_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  enabled BOOLEAN DEFAULT FALSE,
  tone VARCHAR(50) DEFAULT 'professional' CHECK (tone IN ('professional', 'friendly', 'casual', 'formal')),
  response_delay_seconds INTEGER DEFAULT 5 CHECK (response_delay_seconds >= 0 AND response_delay_seconds <= 300),
  auto_respond_hours_start TIME DEFAULT '09:00:00',
  auto_respond_hours_end TIME DEFAULT '18:00:00',
  auto_respond_days VARCHAR[] DEFAULT ARRAY['monday', 'tuesday', 'wednesday', 'thursday', 'friday'],
  response_rules JSONB DEFAULT '{}',
  fallback_message TEXT DEFAULT 'Thank you for your message. I''ll get back to you shortly!',
  max_auto_responses_per_conversation INTEGER DEFAULT 3,
  require_approval BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Behavioral events for lead scoring
CREATE TABLE IF NOT EXISTS behavioral_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  event_type VARCHAR(100) NOT NULL,
  event_category VARCHAR(50) CHECK (event_category IN ('email', 'sms', 'property', 'website', 'document', 'meeting')),
  event_value INTEGER DEFAULT 1,
  metadata JSONB DEFAULT '{}',
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Lead scores table
CREATE TABLE IF NOT EXISTS lead_scores (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE UNIQUE,
  score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 100),
  last_calculated_at TIMESTAMPTZ DEFAULT NOW(),
  factors_json JSONB DEFAULT '{}',
  engagement_level VARCHAR(50) CHECK (engagement_level IN ('cold', 'warm', 'hot')),
  priority_rank INTEGER,
  next_action_recommended VARCHAR(255),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Score thresholds for notifications
CREATE TABLE IF NOT EXISTS score_thresholds (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  threshold_value INTEGER NOT NULL CHECK (threshold_value >= 0 AND threshold_value <= 100),
  alert_enabled BOOLEAN DEFAULT TRUE,
  notification_channels VARCHAR[] DEFAULT ARRAY['browser', 'email'],
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_conversations_contact ON conversations(contact_id);
CREATE INDEX IF NOT EXISTS idx_conversations_channel ON conversations(channel);
CREATE INDEX IF NOT EXISTS idx_conversations_agent ON conversations(assigned_agent_id);
CREATE INDEX IF NOT EXISTS idx_conversations_last_message ON conversations(last_message_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_messages_sender_type ON messages(sender_type);
CREATE INDEX IF NOT EXISTS idx_messages_ai_generated ON messages(ai_generated);
CREATE INDEX IF NOT EXISTS idx_messages_created ON messages(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_behavioral_events_contact ON behavioral_events(contact_id);
CREATE INDEX IF NOT EXISTS idx_behavioral_events_type ON behavioral_events(event_type);
CREATE INDEX IF NOT EXISTS idx_behavioral_events_created ON behavioral_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_lead_scores_contact ON lead_scores(contact_id);
CREATE INDEX IF NOT EXISTS idx_lead_scores_score ON lead_scores(score DESC);
CREATE INDEX IF NOT EXISTS idx_lead_scores_engagement ON lead_scores(engagement_level);

-- Row Level Security Policies

-- Conversations RLS
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents can view their assigned conversations"
  ON conversations FOR SELECT
  USING (
    auth.uid() IN (
      SELECT id FROM users WHERE user_type IN ('agent', 'broker', 'admin')
    )
    OR assigned_agent_id = auth.uid()
  );

CREATE POLICY "Agents can insert conversations"
  ON conversations FOR INSERT
  WITH CHECK (
    auth.uid() IN (
      SELECT id FROM users WHERE user_type IN ('agent', 'broker', 'admin')
    )
  );

CREATE POLICY "Agents can update their conversations"
  ON conversations FOR UPDATE
  USING (
    assigned_agent_id = auth.uid()
    OR auth.uid() IN (SELECT id FROM users WHERE user_type IN ('broker', 'admin'))
  );

-- Messages RLS
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents can view messages in their conversations"
  ON messages FOR SELECT
  USING (
    conversation_id IN (
      SELECT id FROM conversations 
      WHERE assigned_agent_id = auth.uid()
      OR auth.uid() IN (SELECT id FROM users WHERE user_type IN ('broker', 'admin'))
    )
  );

CREATE POLICY "Agents can insert messages"
  ON messages FOR INSERT
  WITH CHECK (
    auth.uid() IN (
      SELECT id FROM users WHERE user_type IN ('agent', 'broker', 'admin')
    )
  );

-- Auto-response settings RLS
ALTER TABLE auto_response_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents can manage their own auto-response settings"
  ON auto_response_settings FOR ALL
  USING (agent_id = auth.uid());

-- Behavioral events RLS
ALTER TABLE behavioral_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents can view events for their contacts"
  ON behavioral_events FOR SELECT
  USING (
    contact_id IN (
      SELECT id FROM contacts 
      WHERE agent_id = auth.uid()
      OR auth.uid() IN (SELECT id FROM users WHERE user_type IN ('broker', 'admin'))
    )
  );

CREATE POLICY "System can insert behavioral events"
  ON behavioral_events FOR INSERT
  WITH CHECK (true);

-- Lead scores RLS
ALTER TABLE lead_scores ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents can view scores for their contacts"
  ON lead_scores FOR SELECT
  USING (
    contact_id IN (
      SELECT id FROM contacts 
      WHERE agent_id = auth.uid()
      OR auth.uid() IN (SELECT id FROM users WHERE user_type IN ('broker', 'admin'))
    )
  );

CREATE POLICY "System can update lead scores"
  ON lead_scores FOR ALL
  USING (true);

-- Score thresholds RLS
ALTER TABLE score_thresholds ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents can manage their own thresholds"
  ON score_thresholds FOR ALL
  USING (agent_id = auth.uid());

-- Functions and Triggers

-- Update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_conversations_updated_at
  BEFORE UPDATE ON conversations
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_auto_response_settings_updated_at
  BEFORE UPDATE ON auto_response_settings
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_lead_scores_updated_at
  BEFORE UPDATE ON lead_scores
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- Trigger to update conversation last_message_at when new message
CREATE OR REPLACE FUNCTION update_conversation_last_message()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE conversations
  SET last_message_at = NEW.created_at,
      updated_at = NOW()
  WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_conversation_on_new_message
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION update_conversation_last_message();

-- Trigger to increment unread count for contact messages
CREATE OR REPLACE FUNCTION increment_unread_count()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.sender_type = 'contact' THEN
    UPDATE conversations
    SET unread_count = unread_count + 1
    WHERE id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER increment_unread_on_contact_message
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION increment_unread_count();

COMMENT ON TABLE conversations IS 'Unified conversation threads across all messaging channels';
COMMENT ON TABLE messages IS 'Individual messages within conversations with AI tracking';
COMMENT ON TABLE auto_response_settings IS 'Agent-specific settings for AI auto-responses';
COMMENT ON TABLE behavioral_events IS 'Event tracking for lead scoring and analytics';
COMMENT ON TABLE lead_scores IS 'Real-time calculated lead scores with factors';
COMMENT ON TABLE score_thresholds IS 'Alert thresholds for hot lead notifications';
