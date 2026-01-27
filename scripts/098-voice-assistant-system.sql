-- Voice Assistant System for Agents
-- Hands-free AI assistant (like Alexa/Siri for real estate)

-- Voice assistant sessions (tracks usage)
CREATE TABLE IF NOT EXISTS voice_assistant_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL, -- if assistant was used in context of a contact
  session_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_end TIMESTAMPTZ,
  total_commands INTEGER DEFAULT 0,
  successful_commands INTEGER DEFAULT 0,
  context JSONB, -- current location, active transaction, etc.
  vapi_call_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Individual voice commands (audit trail)
CREATE TABLE IF NOT EXISTS voice_commands (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES voice_assistant_sessions(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL, -- if command relates to a contact
  command_text TEXT NOT NULL,
  intent_detected TEXT, -- lookup_contact, schedule_showing, add_note, get_calendar
  entities_extracted JSONB, -- {contact_name: "John Smith", action: "add_note"}
  action_taken TEXT,
  success BOOLEAN DEFAULT TRUE,
  response_text TEXT,
  confidence_score NUMERIC(3,2),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Voice assistant configuration per agent
CREATE TABLE IF NOT EXISTS voice_assistant_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES profiles(id) ON DELETE CASCADE UNIQUE,
  voice_enabled BOOLEAN DEFAULT TRUE,
  wake_word TEXT DEFAULT 'hey assistant',
  voice_type TEXT DEFAULT 'female', -- male, female
  voice_speed NUMERIC(2,1) DEFAULT 1.0,
  proactive_alerts BOOLEAN DEFAULT TRUE,
  alert_types JSONB DEFAULT '["hot_leads", "at_risk_deals", "upcoming_appointments"]'::jsonb,
  vapi_assistant_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_voice_sessions_agent ON voice_assistant_sessions(agent_id, session_start DESC);
CREATE INDEX IF NOT EXISTS idx_voice_commands_agent ON voice_commands(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_commands_session ON voice_commands(session_id);
CREATE INDEX IF NOT EXISTS idx_voice_commands_contact ON voice_commands(contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_voice_config_agent ON voice_assistant_config(agent_id);

-- RLS Policies
ALTER TABLE voice_assistant_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE voice_assistant_config ENABLE ROW LEVEL SECURITY;

-- Agents can only access their own voice data
CREATE POLICY voice_sessions_agent_policy ON voice_assistant_sessions
  FOR ALL USING (agent_id = auth.uid());

CREATE POLICY voice_commands_agent_policy ON voice_commands
  FOR ALL USING (agent_id = auth.uid());

CREATE POLICY voice_config_agent_policy ON voice_assistant_config
  FOR ALL USING (agent_id = auth.uid());

COMMIT;
