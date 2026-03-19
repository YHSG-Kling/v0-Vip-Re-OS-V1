-- L11-S06 Training Progress Tracker + Certification Engine
-- VIP Real Estate AI OS — Layer 11

-- ─── Training Courses ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS training_courses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  course_name TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL CHECK (category IN ('platform_tour', 'compliance', 'lead_management', 'brand', 'tech_stack', 'advanced')),
  is_required BOOLEAN DEFAULT false,
  passing_score INTEGER DEFAULT 80,
  order_index INTEGER DEFAULT 0,
  is_platform_default BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_training_courses_brokerage ON training_courses(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_training_courses_category ON training_courses(category);

-- ─── Training Course Steps ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS training_course_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  training_course_id UUID NOT NULL REFERENCES training_courses(id) ON DELETE CASCADE,
  step_type TEXT NOT NULL CHECK (step_type IN ('video', 'quiz', 'practice', 'document_review')),
  step_title TEXT NOT NULL,
  content JSONB DEFAULT '{}',
  order_index INTEGER DEFAULT 0,
  is_required BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_training_course_steps_course ON training_course_steps(training_course_id);

-- ─── Agent Courses ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_courses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  training_course_id UUID NOT NULL REFERENCES training_courses(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started', 'in_progress', 'passed', 'failed')),
  score NUMERIC,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id, training_course_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_courses_agent ON agent_courses(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_courses_brokerage ON agent_courses(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_agent_courses_status ON agent_courses(status);

-- ─── Agent Learning Paths ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_learning_paths (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  path_name TEXT NOT NULL,
  course_ids UUID[] DEFAULT '{}',
  assigned_at TIMESTAMPTZ DEFAULT NOW(),
  target_completion_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_learning_paths_agent ON agent_learning_paths(agent_id);

-- ─── Agent Certifications ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_certifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  certification_name TEXT NOT NULL,
  cert_type TEXT NOT NULL CHECK (cert_type IN ('onboarding', 'compliance', 'specialty', 'advanced')),
  issued_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  issued_by UUID REFERENCES users(id),
  certificate_url TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id, certification_name)
);

CREATE INDEX IF NOT EXISTS idx_agent_certifications_agent ON agent_certifications(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_certifications_brokerage ON agent_certifications(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_agent_certifications_type ON agent_certifications(cert_type);

-- ─── Agent Performance Reports ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_performance_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL,
  period_start DATE,
  period_end DATE,
  metrics JSONB DEFAULT '{}',
  ai_summary TEXT,
  recommendations TEXT[] DEFAULT '{}',
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_performance_reports_agent ON agent_performance_reports(agent_id);

-- ─── Practice Evaluations ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS practice_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  training_course_step_id UUID NOT NULL REFERENCES training_course_steps(id) ON DELETE CASCADE,
  submission_text TEXT,
  ai_score NUMERIC,
  ai_feedback TEXT,
  passed BOOLEAN DEFAULT false,
  evaluated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_practice_evaluations_agent ON practice_evaluations(agent_id);

-- ─── RLS Policies ────────────────────────────────────────────────────────────
ALTER TABLE training_courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_course_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_learning_paths ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_certifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_performance_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE practice_evaluations ENABLE ROW LEVEL SECURITY;

-- Training courses: visible to all authenticated users (platform defaults + brokerage-specific)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'training_courses_select' AND tablename = 'training_courses') THEN
    CREATE POLICY training_courses_select ON training_courses FOR SELECT TO authenticated
    USING (brokerage_id IS NULL OR brokerage_id IN (SELECT brokerage_id FROM users WHERE id = auth.uid()));
  END IF;
END $$;

-- Training course steps: visible if course is visible
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'training_course_steps_select' AND tablename = 'training_course_steps') THEN
    CREATE POLICY training_course_steps_select ON training_course_steps FOR SELECT TO authenticated
    USING (training_course_id IN (SELECT id FROM training_courses WHERE brokerage_id IS NULL OR brokerage_id IN (SELECT brokerage_id FROM users WHERE id = auth.uid())));
  END IF;
END $$;

-- Agent courses: agents see their own, admins see all in brokerage
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'agent_courses_all' AND tablename = 'agent_courses') THEN
    CREATE POLICY agent_courses_all ON agent_courses FOR ALL TO authenticated
    USING (agent_id = auth.uid() OR brokerage_id IN (SELECT brokerage_id FROM users WHERE id = auth.uid() AND user_type IN ('admin', 'broker')));
  END IF;
END $$;

-- Agent learning paths: agents see their own
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'agent_learning_paths_all' AND tablename = 'agent_learning_paths') THEN
    CREATE POLICY agent_learning_paths_all ON agent_learning_paths FOR ALL TO authenticated
    USING (agent_id = auth.uid() OR brokerage_id IN (SELECT brokerage_id FROM users WHERE id = auth.uid() AND user_type IN ('admin', 'broker')));
  END IF;
END $$;

-- Agent certifications: agents see their own, admins see all in brokerage
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'agent_certifications_all' AND tablename = 'agent_certifications') THEN
    CREATE POLICY agent_certifications_all ON agent_certifications FOR ALL TO authenticated
    USING (agent_id = auth.uid() OR brokerage_id IN (SELECT brokerage_id FROM users WHERE id = auth.uid() AND user_type IN ('admin', 'broker')));
  END IF;
END $$;

-- Agent performance reports: agents see their own
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'agent_performance_reports_all' AND tablename = 'agent_performance_reports') THEN
    CREATE POLICY agent_performance_reports_all ON agent_performance_reports FOR ALL TO authenticated
    USING (agent_id = auth.uid() OR brokerage_id IN (SELECT brokerage_id FROM users WHERE id = auth.uid() AND user_type IN ('admin', 'broker')));
  END IF;
END $$;

-- Practice evaluations: agents see their own
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'practice_evaluations_all' AND tablename = 'practice_evaluations') THEN
    CREATE POLICY practice_evaluations_all ON practice_evaluations FOR ALL TO authenticated
    USING (agent_id = auth.uid() OR brokerage_id IN (SELECT brokerage_id FROM users WHERE id = auth.uid() AND user_type IN ('admin', 'broker')));
  END IF;
END $$;

-- ─── Feature Flag ────────────────────────────────────────────────────────────
INSERT INTO feature_flags (feature_key, display_name, description, category, enabled, solo_agent_access, team_access, brokerage_access)
VALUES ('training_progress', 'Training Progress Tracker', 'Track agent training progress and certifications', 'onboarding', true, true, true, true)
ON CONFLICT (feature_key) DO NOTHING;

-- ─── Seed Default Certifications (Platform-level) ────────────────────────────
-- These are the required onboarding certifications all agents must earn

-- Seed Platform Fundamentals course
INSERT INTO training_courses (brokerage_id, course_name, description, category, is_required, passing_score, order_index, is_platform_default)
SELECT NULL, 'Platform Fundamentals', 'Learn the basics of using the VIP Real Estate AI OS platform', 'platform_tour', true, 80, 1, true
WHERE NOT EXISTS (SELECT 1 FROM training_courses WHERE course_name = 'Platform Fundamentals' AND brokerage_id IS NULL);

-- Seed Compliance Basics course
INSERT INTO training_courses (brokerage_id, course_name, description, category, is_required, passing_score, order_index, is_platform_default)
SELECT NULL, 'Compliance Basics', 'Essential compliance training including Fair Housing and TCPA', 'compliance', true, 80, 2, true
WHERE NOT EXISTS (SELECT 1 FROM training_courses WHERE course_name = 'Compliance Basics' AND brokerage_id IS NULL);

-- Seed Lead Management Essentials course
INSERT INTO training_courses (brokerage_id, course_name, description, category, is_required, passing_score, order_index, is_platform_default)
SELECT NULL, 'Lead Management Essentials', 'Master the lead management system and conversion techniques', 'lead_management', true, 80, 3, true
WHERE NOT EXISTS (SELECT 1 FROM training_courses WHERE course_name = 'Lead Management Essentials' AND brokerage_id IS NULL);

-- Add additional_data column to agent_onboarding if it doesn't exist (for celebration dismissed flag)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_onboarding' AND column_name = 'additional_data') THEN
    ALTER TABLE agent_onboarding ADD COLUMN additional_data JSONB DEFAULT '{}';
  END IF;
END $$;
