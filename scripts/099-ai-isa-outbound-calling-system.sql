-- AI Inside Sales Agent (ISA) System
-- Autonomous outbound calling with Vapi.ai voice bot for lead qualification and appointment booking

-- AI ISA campaigns
CREATE TABLE IF NOT EXISTS ai_isa_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  login_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  campaign_name TEXT NOT NULL,
  campaign_type TEXT NOT NULL, -- new_lead_follow_up, dormant_reactivation, showing_feedback, review_request
  vapi_assistant_id TEXT NOT NULL,
  target_contact_segment JSONB, -- filter criteria
  call_schedule TEXT DEFAULT '9am-5pm', -- immediate, 9am-5pm, evening
  max_attempts INTEGER DEFAULT 3,
  status TEXT DEFAULT 'active', -- active, paused, completed
  contacts_targeted INTEGER DEFAULT 0,
  calls_completed INTEGER DEFAULT 0,
  appointments_booked INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI ISA call logs
CREATE TABLE IF NOT EXISTS ai_isa_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES ai_isa_campaigns(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  login_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  vapi_call_id TEXT,
  call_status TEXT, -- initiated, completed, busy, no_answer, voicemail, failed
  call_duration_seconds INTEGER,
  conversation_transcript TEXT,
  qualification_result JSONB, -- {qualified: true, budget: 400000, timeline: "3_months"}
  outcome TEXT, -- appointment_booked, callback_requested, not_interested, transferred_to_agent, qualified_for_followup
  appointment_scheduled_id UUID REFERENCES appointments(id),
  attempt_number INTEGER DEFAULT 1,
  recording_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI ISA conversation scripts
CREATE TABLE IF NOT EXISTS ai_isa_scripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  login_id UUID REFERENCES profiles(id) ON DELETE CASCADE,
  script_name TEXT NOT NULL,
  call_purpose TEXT NOT NULL, -- qualification, appointment_booking, feedback_collection
  opening_line TEXT NOT NULL,
  qualification_questions JSONB,
  objection_handling JSONB,
  closing_cta TEXT,
  them_first_score NUMERIC,
  conversion_rate NUMERIC,
  avg_call_duration INTEGER,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_ai_isa_campaigns_login ON ai_isa_campaigns(login_id);
CREATE INDEX IF NOT EXISTS idx_ai_isa_calls_campaign ON ai_isa_calls(campaign_id);
CREATE INDEX IF NOT EXISTS idx_ai_isa_calls_contact ON ai_isa_calls(contact_id);
CREATE INDEX IF NOT EXISTS idx_ai_isa_calls_status ON ai_isa_calls(call_status);
CREATE INDEX IF NOT EXISTS idx_ai_isa_scripts_login ON ai_isa_scripts(login_id);

-- Row Level Security
ALTER TABLE ai_isa_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_isa_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_isa_scripts ENABLE ROW LEVEL SECURITY;

-- Policies
DROP POLICY IF EXISTS "Agents manage their ISA campaigns" ON ai_isa_campaigns;
CREATE POLICY "Agents manage their ISA campaigns" ON ai_isa_campaigns
  FOR ALL USING (auth.uid() = login_id);

DROP POLICY IF EXISTS "Agents view their ISA calls" ON ai_isa_calls;
CREATE POLICY "Agents view their ISA calls" ON ai_isa_calls
  FOR ALL USING (auth.uid() = login_id);

DROP POLICY IF EXISTS "Agents manage their ISA scripts" ON ai_isa_scripts;
CREATE POLICY "Agents manage their ISA scripts" ON ai_isa_scripts
  FOR ALL USING (auth.uid() = login_id);

COMMIT;
