-- Call Whisper Bridge & Vapi Voice Bot Integration
-- Enables AI-powered call bridging with context whispers and autonomous voice outreach

-- Drop existing policies first
DROP POLICY IF EXISTS "Agents can view their whisper logs" ON call_whisper_logs;
DROP POLICY IF EXISTS "Agents can create whisper logs" ON call_whisper_logs;
DROP POLICY IF EXISTS "System can update whisper logs" ON call_whisper_logs;
DROP POLICY IF EXISTS "Agents can view vapi calls" ON vapi_voice_calls;
DROP POLICY IF EXISTS "System can create vapi calls" ON vapi_voice_calls;
DROP POLICY IF EXISTS "System can update vapi calls" ON vapi_voice_calls;

-- Call whisper logs table
CREATE TABLE IF NOT EXISTS call_whisper_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  whisper_text TEXT NOT NULL,
  call_connected BOOLEAN DEFAULT false,
  call_duration_seconds INTEGER,
  outcome TEXT, -- answered, no_answer, voicemail, declined
  twilio_call_sid TEXT,
  agent_phone TEXT,
  contact_phone TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Vapi AI voice call logs
CREATE TABLE IF NOT EXISTS vapi_voice_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  trigger_event TEXT NOT NULL, -- behavioral_spike, hot_lead_score, showing_reminder, price_reduction_alert
  vapi_call_id TEXT,
  call_status TEXT, -- initiated, in_progress, completed, busy, no_answer, voicemail, failed
  conversation_transcript TEXT,
  outcome TEXT, -- booked_showing, requested_callback, declined, interested, not_interested
  sentiment TEXT, -- positive, neutral, negative
  duration_seconds INTEGER,
  cost_cents INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_call_whisper_logs_contact ON call_whisper_logs(contact_id);
CREATE INDEX IF NOT EXISTS idx_call_whisper_logs_agent ON call_whisper_logs(agent_id);
CREATE INDEX IF NOT EXISTS idx_call_whisper_logs_created ON call_whisper_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vapi_voice_calls_contact ON vapi_voice_calls(contact_id);
CREATE INDEX IF NOT EXISTS idx_vapi_voice_calls_status ON vapi_voice_calls(call_status);
CREATE INDEX IF NOT EXISTS idx_vapi_voice_calls_created ON vapi_voice_calls(created_at DESC);

-- RLS Policies
ALTER TABLE call_whisper_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE vapi_voice_calls ENABLE ROW LEVEL SECURITY;

-- Allow agents to view their own whisper logs
CREATE POLICY "Agents can view their whisper logs"
  ON call_whisper_logs FOR SELECT
  USING (auth.uid() = agent_id);

-- Allow agents to insert whisper logs
CREATE POLICY "Agents can create whisper logs"
  ON call_whisper_logs FOR INSERT
  WITH CHECK (auth.uid() = agent_id);

-- Allow system to update whisper logs
CREATE POLICY "System can update whisper logs"
  ON call_whisper_logs FOR UPDATE
  USING (true);

-- Allow agents to view vapi calls for their contacts
CREATE POLICY "Agents can view vapi calls"
  ON vapi_voice_calls FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM contacts 
      WHERE contacts.id = vapi_voice_calls.contact_id 
      AND contacts.agent_id = auth.uid()
    )
  );

-- Allow system to insert vapi calls
CREATE POLICY "System can create vapi calls"
  ON vapi_voice_calls FOR INSERT
  WITH CHECK (true);

-- Allow system to update vapi calls
CREATE POLICY "System can update vapi calls"
  ON vapi_voice_calls FOR UPDATE
  USING (true);

COMMIT;
