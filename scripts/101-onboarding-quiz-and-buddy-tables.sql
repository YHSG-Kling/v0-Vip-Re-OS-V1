-- Onboarding Quiz and AI Buddy System
-- Add quiz and AI chat tables for the 7-day onboarding curriculum

-- Onboarding Quizzes
CREATE TABLE IF NOT EXISTS onboarding_quizzes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  step_id UUID REFERENCES agent_onboarding_steps(id) ON DELETE CASCADE,
  quiz_name TEXT NOT NULL,
  questions JSONB NOT NULL,
  passing_score INTEGER DEFAULT 80,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Agent Quiz Attempts
CREATE TABLE IF NOT EXISTS agent_quiz_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  quiz_id UUID REFERENCES onboarding_quizzes(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  answers JSONB NOT NULL,
  passed BOOLEAN DEFAULT false,
  attempt_number INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Onboarding AI Buddy Chats
CREATE TABLE IF NOT EXISTS onboarding_ai_chats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  ai_response TEXT NOT NULL,
  helpful BOOLEAN,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add certification columns to onboarding_sessions
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_onboarding_sessions' AND column_name = 'certification_achieved') THEN
    ALTER TABLE agent_onboarding_sessions ADD COLUMN certification_achieved BOOLEAN DEFAULT false;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_onboarding_sessions' AND column_name = 'certified_at') THEN
    ALTER TABLE agent_onboarding_sessions ADD COLUMN certified_at TIMESTAMPTZ;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_onboarding_steps' AND column_name = 'day_number') THEN
    ALTER TABLE agent_onboarding_steps ADD COLUMN day_number INTEGER DEFAULT 1;
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_quizzes_step ON onboarding_quizzes(step_id);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_agent ON agent_quiz_attempts(agent_id);
CREATE INDEX IF NOT EXISTS idx_quiz_attempts_quiz ON agent_quiz_attempts(quiz_id);
CREATE INDEX IF NOT EXISTS idx_ai_chats_agent ON onboarding_ai_chats(agent_id);
CREATE INDEX IF NOT EXISTS idx_onboarding_steps_day ON agent_onboarding_steps(day_number);

-- RLS Policies
ALTER TABLE onboarding_quizzes ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_quiz_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_ai_chats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS quizzes_policy ON onboarding_quizzes;
CREATE POLICY quizzes_policy ON onboarding_quizzes FOR ALL USING (true);

DROP POLICY IF EXISTS quiz_attempts_policy ON agent_quiz_attempts;
CREATE POLICY quiz_attempts_policy ON agent_quiz_attempts FOR ALL USING (
  agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid())
);

DROP POLICY IF EXISTS ai_chats_policy ON onboarding_ai_chats;
CREATE POLICY ai_chats_policy ON onboarding_ai_chats FOR ALL USING (
  agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid())
);

COMMIT;
