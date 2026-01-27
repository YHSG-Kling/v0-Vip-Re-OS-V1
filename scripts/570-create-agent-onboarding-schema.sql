-- Agent Onboarding System Schema
-- Comprehensive onboarding workflow for new agents

-- Recruits Table (MUST be created first - referenced by other tables)
CREATE TABLE IF NOT EXISTS recruits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  status TEXT DEFAULT 'Lead' CHECK (status IN ('Lead', 'Applied', 'Interviewing', 'Offered', 'Joined', 'Declined')),
  source_agent_id UUID REFERENCES agents(id),
  source_agent_name TEXT,
  experience_years INTEGER,
  last_production_volume NUMERIC,
  current_brokerage TEXT,
  license_number TEXT,
  license_state TEXT,
  notes TEXT,
  joined_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent Onboarding Sessions
CREATE TABLE IF NOT EXISTS agent_onboarding_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  recruit_id UUID REFERENCES recruits(id),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'on_hold')),
  start_date TIMESTAMPTZ DEFAULT NOW(),
  target_completion_date TIMESTAMPTZ,
  actual_completion_date TIMESTAMPTZ,
  current_step TEXT,
  progress_percentage INTEGER DEFAULT 0,
  checklist JSONB DEFAULT '{}',
  assigned_mentor_id UUID REFERENCES agents(id),
  assigned_tc_id UUID,
  mentor_match_score NUMERIC,
  mentor_match_reason TEXT,
  ai_recommendations JSONB,
  ai_success_prediction NUMERIC,
  ai_risk_factors JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent Onboarding Steps
CREATE TABLE IF NOT EXISTS agent_onboarding_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES agent_onboarding_sessions(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT CHECK (category IN ('documents', 'training', 'setup', 'compliance', 'mentorship')),
  required BOOLEAN DEFAULT true,
  "order" INTEGER NOT NULL,
  estimated_minutes INTEGER DEFAULT 30,
  ai_assisted BOOLEAN DEFAULT false,
  completed_at TIMESTAMPTZ,
  completed_by UUID,
  notes TEXT,
  attachments JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent Mentor Relationships
CREATE TABLE IF NOT EXISTS agent_mentor_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mentee_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  mentor_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'paused')),
  suggested_topics JSONB,
  meeting_frequency TEXT DEFAULT 'weekly',
  next_meeting_date TIMESTAMPTZ,
  total_meetings INTEGER DEFAULT 0,
  feedback_score NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ
);

-- Add onboarding columns to agents table if not exist
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'onboarding_status') THEN
    ALTER TABLE agents ADD COLUMN onboarding_status TEXT DEFAULT 'not_started';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'onboarding_completed_at') THEN
    ALTER TABLE agents ADD COLUMN onboarding_completed_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'license_verified') THEN
    ALTER TABLE agents ADD COLUMN license_verified BOOLEAN DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'license_verified_at') THEN
    ALTER TABLE agents ADD COLUMN license_verified_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'specialties') THEN
    ALTER TABLE agents ADD COLUMN specialties JSONB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agents' AND column_name = 'service_areas') THEN
    ALTER TABLE agents ADD COLUMN service_areas JSONB;
  END IF;
END $$;

-- Onboarding Document Templates
CREATE TABLE IF NOT EXISTS onboarding_document_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID,
  name TEXT NOT NULL,
  document_type TEXT CHECK (document_type IN ('ica', 'w9', 'direct_deposit', 'policy_manual', 'compliance_acknowledgment')),
  template_url TEXT,
  requires_signature BOOLEAN DEFAULT true,
  is_required BOOLEAN DEFAULT true,
  "order" INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Onboarding Document Completions
CREATE TABLE IF NOT EXISTS onboarding_document_completions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES agent_onboarding_sessions(id) ON DELETE CASCADE,
  template_id UUID REFERENCES onboarding_document_templates(id),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'viewed', 'signed', 'rejected')),
  signed_url TEXT,
  signed_at TIMESTAMPTZ,
  dotloop_document_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Training Modules for Onboarding
CREATE TABLE IF NOT EXISTS onboarding_training_modules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID,
  name TEXT NOT NULL,
  description TEXT,
  category TEXT CHECK (category IN ('crm', 'compliance', 'transactions', 'marketing', 'lead_gen', 'technology')),
  content_type TEXT CHECK (content_type IN ('video', 'quiz', 'document', 'interactive')),
  content_url TEXT,
  duration_minutes INTEGER,
  passing_score INTEGER DEFAULT 80,
  is_required BOOLEAN DEFAULT true,
  "order" INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Training Completions
CREATE TABLE IF NOT EXISTS onboarding_training_completions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID REFERENCES agent_onboarding_sessions(id) ON DELETE CASCADE,
  module_id UUID REFERENCES onboarding_training_modules(id),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  status TEXT DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'completed', 'failed')),
  score INTEGER,
  attempts INTEGER DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_agent ON agent_onboarding_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_status ON agent_onboarding_sessions(status);
CREATE INDEX IF NOT EXISTS idx_onboarding_steps_session ON agent_onboarding_steps(session_id);
CREATE INDEX IF NOT EXISTS idx_recruits_status ON recruits(status);
CREATE INDEX IF NOT EXISTS idx_recruits_source ON recruits(source_agent_id);
CREATE INDEX IF NOT EXISTS idx_mentor_relationships_mentee ON agent_mentor_relationships(mentee_id);
CREATE INDEX IF NOT EXISTS idx_mentor_relationships_mentor ON agent_mentor_relationships(mentor_id);

-- RLS Policies
ALTER TABLE agent_onboarding_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_onboarding_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE recruits ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_mentor_relationships ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS onboarding_sessions_policy ON agent_onboarding_sessions;
CREATE POLICY onboarding_sessions_policy ON agent_onboarding_sessions FOR ALL USING (
  agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid())
  OR EXISTS (SELECT 1 FROM agents WHERE user_id = auth.uid() AND (brokerage_id IS NOT NULL))
);

DROP POLICY IF EXISTS onboarding_steps_policy ON agent_onboarding_steps;
CREATE POLICY onboarding_steps_policy ON agent_onboarding_steps FOR ALL USING (
  session_id IN (SELECT id FROM agent_onboarding_sessions WHERE agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid()))
);

DROP POLICY IF EXISTS recruits_policy ON recruits;
CREATE POLICY recruits_policy ON recruits FOR ALL USING (
  source_agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid())
  OR EXISTS (SELECT 1 FROM agents WHERE user_id = auth.uid() AND (brokerage_id IS NOT NULL))
);

DROP POLICY IF EXISTS mentor_relationships_policy ON agent_mentor_relationships;
CREATE POLICY mentor_relationships_policy ON agent_mentor_relationships FOR ALL USING (
  mentee_id IN (SELECT id FROM agents WHERE user_id = auth.uid())
  OR mentor_id IN (SELECT id FROM agents WHERE user_id = auth.uid())
);
