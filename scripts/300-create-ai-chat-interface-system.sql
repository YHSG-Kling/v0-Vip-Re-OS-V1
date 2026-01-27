-- AI Chat Interface System with Them-First Philosophy
-- Creates tables for intelligent chat sessions, compliance monitoring, and lead communication

-- Chat Sessions
CREATE TABLE IF NOT EXISTS chat_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID REFERENCES users(id) ON DELETE CASCADE,
  lead_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  session_type TEXT NOT NULL CHECK (session_type IN ('lead_qualification', 'client_support', 'transaction_help', 'market_insights')),
  session_status TEXT DEFAULT 'active' CHECK (session_status IN ('active', 'completed', 'archived')),
  context_data JSONB DEFAULT '{}',
  them_first_score INTEGER DEFAULT 0 CHECK (them_first_score >= 0 AND them_first_score <= 100),
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  last_activity_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chat Messages
CREATE TABLE IF NOT EXISTS chat_messages (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE,
  sender_type TEXT NOT NULL CHECK (sender_type IN ('agent', 'ai_assistant', 'system', 'lead')),
  sender_id UUID,
  message_content TEXT NOT NULL,
  message_type TEXT DEFAULT 'text' CHECK (message_type IN ('text', 'suggestion', 'data_insight', 'compliance_warning')),
  metadata JSONB DEFAULT '{}',
  them_first_analysis JSONB,
  compliance_flagged BOOLEAN DEFAULT false,
  compliance_issues JSONB[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI Suggestions
CREATE TABLE IF NOT EXISTS ai_suggestions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id UUID REFERENCES chat_sessions(id) ON DELETE CASCADE,
  suggestion_type TEXT NOT NULL CHECK (suggestion_type IN ('response_template', 'next_action', 'lead_insight', 'market_data')),
  suggestion_content JSONB NOT NULL,
  confidence_score DECIMAL(3,2) CHECK (confidence_score >= 0 AND confidence_score <= 1),
  was_accepted BOOLEAN DEFAULT false,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent Chat Preferences
CREATE TABLE IF NOT EXISTS agent_chat_preferences (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id UUID REFERENCES users(id) ON DELETE CASCADE UNIQUE,
  auto_suggest_responses BOOLEAN DEFAULT true,
  them_first_coaching BOOLEAN DEFAULT true,
  compliance_alerts BOOLEAN DEFAULT true,
  lead_insights_enabled BOOLEAN DEFAULT true,
  preferred_tone TEXT DEFAULT 'professional' CHECK (preferred_tone IN ('professional', 'friendly', 'consultative')),
  custom_prompts JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Chat Templates (Them-First Approved)
CREATE TABLE IF NOT EXISTS chat_templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  template_name TEXT NOT NULL,
  template_category TEXT NOT NULL CHECK (template_category IN ('greeting', 'follow_up', 'objection_handling', 'value_prop', 'market_update', 'listing_promo')),
  template_content TEXT NOT NULL,
  target_scenario TEXT,
  them_first_score INTEGER DEFAULT 0 CHECK (them_first_score >= 0 AND them_first_score <= 100),
  compliance_approved BOOLEAN DEFAULT false,
  allowed_lead_types TEXT[] DEFAULT '{}',
  usage_count INTEGER DEFAULT 0,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Lead Conversation History (for context)
CREATE TABLE IF NOT EXISTS lead_conversation_history (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  lead_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('chat', 'email', 'sms', 'call', 'social')),
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  message_content TEXT,
  sentiment_score DECIMAL(3,2) CHECK (sentiment_score >= -1 AND sentiment_score <= 1),
  intent_detected TEXT[] DEFAULT '{}',
  ai_summary TEXT,
  occurred_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_chat_sessions_agent ON chat_sessions(agent_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_sessions_lead ON chat_sessions(lead_id, session_status);
CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_messages_compliance ON chat_messages(compliance_flagged) WHERE compliance_flagged = true;
CREATE INDEX IF NOT EXISTS idx_ai_suggestions_session ON ai_suggestions(session_id, was_accepted);
CREATE INDEX IF NOT EXISTS idx_lead_conversation_history ON lead_conversation_history(lead_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_templates_category ON chat_templates(template_category, compliance_approved);

-- RLS Policies
ALTER TABLE chat_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_chat_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE lead_conversation_history ENABLE ROW LEVEL SECURITY;

-- Sessions: Agents see their own + admins see all
CREATE POLICY chat_sessions_select ON chat_sessions FOR SELECT USING (
  auth.uid() = agent_id OR 
  EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND user_type IN ('admin', 'broker', 'compliance_manager'))
);

CREATE POLICY chat_sessions_insert ON chat_sessions FOR INSERT WITH CHECK (
  auth.uid() = agent_id
);

CREATE POLICY chat_sessions_update ON chat_sessions FOR UPDATE USING (
  auth.uid() = agent_id
);

-- Messages: See messages from sessions you have access to
CREATE POLICY chat_messages_select ON chat_messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM chat_sessions 
    WHERE chat_sessions.id = chat_messages.session_id 
    AND (
      chat_sessions.agent_id = auth.uid() OR 
      EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND user_type IN ('admin', 'broker', 'compliance_manager'))
    )
  )
);

CREATE POLICY chat_messages_insert ON chat_messages FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM chat_sessions 
    WHERE chat_sessions.id = chat_messages.session_id 
    AND chat_sessions.agent_id = auth.uid()
  )
);

-- AI Suggestions: Same as messages
CREATE POLICY ai_suggestions_select ON ai_suggestions FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM chat_sessions 
    WHERE chat_sessions.id = ai_suggestions.session_id 
    AND (
      chat_sessions.agent_id = auth.uid() OR 
      EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND user_type IN ('admin', 'broker'))
    )
  )
);

CREATE POLICY ai_suggestions_update ON ai_suggestions FOR UPDATE USING (
  EXISTS (
    SELECT 1 FROM chat_sessions 
    WHERE chat_sessions.id = ai_suggestions.session_id 
    AND chat_sessions.agent_id = auth.uid()
  )
);

-- Preferences: Agents see/edit their own
CREATE POLICY agent_chat_preferences_all ON agent_chat_preferences FOR ALL USING (
  agent_id = auth.uid()
);

-- Templates: Everyone can read, admins can write
CREATE POLICY chat_templates_select ON chat_templates FOR SELECT USING (true);

CREATE POLICY chat_templates_insert ON chat_templates FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND user_type IN ('admin', 'broker'))
);

CREATE POLICY chat_templates_update ON chat_templates FOR UPDATE USING (
  EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND user_type IN ('admin', 'broker')) OR
  created_by = auth.uid()
);

-- Conversation History: Agents see leads they have access to
CREATE POLICY lead_conversation_history_select ON lead_conversation_history FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM contacts 
    WHERE contacts.id = lead_conversation_history.lead_id 
    AND (
      contacts.agent_id = auth.uid() OR
      EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND user_type IN ('admin', 'broker', 'compliance_manager'))
    )
  )
);

CREATE POLICY lead_conversation_history_insert ON lead_conversation_history FOR INSERT WITH CHECK (
  EXISTS (
    SELECT 1 FROM contacts 
    WHERE contacts.id = lead_conversation_history.lead_id 
    AND contacts.agent_id = auth.uid()
  )
);

COMMIT;
