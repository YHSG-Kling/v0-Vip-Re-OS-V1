-- =====================================================
-- A-Team & Culture System Migration
-- =====================================================

-- Create enum types
DO $$ BEGIN
  CREATE TYPE meeting_cadence AS ENUM ('daily', 'weekly', 'biweekly', 'monthly', 'quarterly', 'annual', 'ad_hoc');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE progression_status AS ENUM ('not_started', 'in_progress', 'completed', 'on_hold');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- =====================================================
-- 1. ORG STRUCTURE TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS org_structure (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Ownership
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  
  -- Role details
  role_name TEXT NOT NULL,
  description TEXT,
  
  -- Hierarchy
  reports_to_role_id UUID REFERENCES org_structure(id) ON DELETE SET NULL,
  level INTEGER DEFAULT 0,  -- Depth in hierarchy (0 = top level)
  
  -- Responsibilities
  responsibilities TEXT[] DEFAULT ARRAY[]::TEXT[],
  required_capabilities TEXT[] DEFAULT ARRAY[]::TEXT[],
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  
  CONSTRAINT unique_role_per_brokerage UNIQUE (brokerage_id, role_name)
);

CREATE INDEX idx_org_structure_brokerage ON org_structure(brokerage_id);
CREATE INDEX idx_org_structure_reports_to ON org_structure(reports_to_role_id);

-- =====================================================
-- 2. MEETING TEMPLATES TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS meeting_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Ownership
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  
  -- Template details
  name TEXT NOT NULL,
  description TEXT,
  cadence meeting_cadence NOT NULL,
  
  -- Agenda structure (JSONB array of agenda items)
  -- Example: [{"title": "Pipeline Review", "duration_minutes": 15, "owner": "team_lead"}, ...]
  agenda JSONB DEFAULT '[]'::jsonb,
  
  -- Participants
  required_roles TEXT[] DEFAULT ARRAY[]::TEXT[],  -- role_names from org_structure
  optional_roles TEXT[] DEFAULT ARRAY[]::TEXT[],
  
  -- Settings
  duration_minutes INTEGER DEFAULT 60,
  is_active BOOLEAN DEFAULT true,
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES users(id),
  
  CONSTRAINT unique_meeting_per_brokerage UNIQUE (brokerage_id, name)
);

CREATE INDEX idx_meeting_templates_brokerage ON meeting_templates(brokerage_id);
CREATE INDEX idx_meeting_templates_cadence ON meeting_templates(cadence);

-- =====================================================
-- 3. TRAINING PLANS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS training_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Ownership
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  
  -- Plan details
  name TEXT NOT NULL,
  description TEXT,
  
  -- Target roles
  from_role TEXT,  -- Starting role (e.g., "Junior Agent")
  to_role TEXT,    -- Target role (e.g., "Senior Agent")
  
  -- Linked academy modules (array of academy_content IDs)
  -- Example: {"modules": ["uuid1", "uuid2"], "order": [0, 1], "required": [true, true]}
  linked_academy_modules JSONB DEFAULT '{}'::jsonb,
  
  -- Requirements
  estimated_duration_days INTEGER,
  required_deals INTEGER DEFAULT 0,
  required_skills TEXT[] DEFAULT ARRAY[]::TEXT[],
  
  -- Metadata
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_by UUID REFERENCES users(id)
);

CREATE INDEX idx_training_plans_brokerage ON training_plans(brokerage_id);
CREATE INDEX idx_training_plans_active ON training_plans(is_active) WHERE is_active = true;

-- =====================================================
-- 4. USER PROGRESSION TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS user_progression (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- User reference
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Progression details
  current_role TEXT NOT NULL,
  target_role TEXT,
  training_plan_id UUID REFERENCES training_plans(id) ON DELETE SET NULL,
  
  -- Status tracking
  status progression_status DEFAULT 'not_started',
  completion_percentage INTEGER DEFAULT 0 CHECK (completion_percentage BETWEEN 0 AND 100),
  
  -- Milestones completed (JSONB array)
  -- Example: [{"module_id": "uuid", "completed_at": "2024-01-15", "score": 95}, ...]
  completed_milestones JSONB DEFAULT '[]'::jsonb,
  
  -- Dates
  started_at TIMESTAMPTZ,
  target_completion_date TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  CONSTRAINT unique_user_progression UNIQUE (user_id)
);

CREATE INDEX idx_user_progression_user ON user_progression(user_id);
CREATE INDEX idx_user_progression_training_plan ON user_progression(training_plan_id);
CREATE INDEX idx_user_progression_status ON user_progression(status);

-- =====================================================
-- 5. MEETING INSTANCES TABLE (Optional - for tracking actual meetings)
-- =====================================================

CREATE TABLE IF NOT EXISTS meeting_instances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Template reference
  meeting_template_id UUID NOT NULL REFERENCES meeting_templates(id) ON DELETE CASCADE,
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  
  -- Meeting details
  scheduled_at TIMESTAMPTZ NOT NULL,
  actual_start_time TIMESTAMPTZ,
  actual_end_time TIMESTAMPTZ,
  
  -- Participants
  attendees UUID[] DEFAULT ARRAY[]::UUID[],  -- user IDs
  
  -- Notes and action items
  notes TEXT,
  action_items JSONB DEFAULT '[]'::jsonb,
  
  -- Status
  status TEXT DEFAULT 'scheduled',  -- scheduled, in_progress, completed, cancelled
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_meeting_instances_template ON meeting_instances(meeting_template_id);
CREATE INDEX idx_meeting_instances_brokerage ON meeting_instances(brokerage_id);
CREATE INDEX idx_meeting_instances_scheduled ON meeting_instances(scheduled_at);

-- =====================================================
-- RLS POLICIES
-- =====================================================

-- Enable RLS
ALTER TABLE org_structure ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE training_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_progression ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_instances ENABLE ROW LEVEL SECURITY;

-- org_structure policies
CREATE POLICY org_structure_select ON org_structure
  FOR SELECT USING (
    brokerage_id IN (SELECT auth.user_brokerage_ids())
  );

CREATE POLICY org_structure_admin_all ON org_structure
  FOR ALL USING (
    auth.user_is_admin() AND brokerage_id IN (SELECT auth.user_brokerage_ids())
  );

-- meeting_templates policies
CREATE POLICY meeting_templates_select ON meeting_templates
  FOR SELECT USING (
    brokerage_id IN (SELECT auth.user_brokerage_ids())
  );

CREATE POLICY meeting_templates_admin_all ON meeting_templates
  FOR ALL USING (
    auth.user_is_admin() AND brokerage_id IN (SELECT auth.user_brokerage_ids())
  );

-- training_plans policies
CREATE POLICY training_plans_select ON training_plans
  FOR SELECT USING (
    brokerage_id IN (SELECT auth.user_brokerage_ids())
  );

CREATE POLICY training_plans_admin_all ON training_plans
  FOR ALL USING (
    auth.user_is_admin() AND brokerage_id IN (SELECT auth.user_brokerage_ids())
  );

-- user_progression policies
CREATE POLICY user_progression_own ON user_progression
  FOR SELECT USING (
    user_id = auth.uid()
  );

CREATE POLICY user_progression_admin_all ON user_progression
  FOR ALL USING (
    auth.user_is_admin()
  );

-- meeting_instances policies
CREATE POLICY meeting_instances_select ON meeting_instances
  FOR SELECT USING (
    brokerage_id IN (SELECT auth.user_brokerage_ids())
  );

CREATE POLICY meeting_instances_admin_all ON meeting_instances
  FOR ALL USING (
    auth.user_is_admin() AND brokerage_id IN (SELECT auth.user_brokerage_ids())
  );

-- =====================================================
-- TRIGGERS FOR updated_at
-- =====================================================

CREATE TRIGGER set_org_structure_updated_at BEFORE UPDATE ON org_structure
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_meeting_templates_updated_at BEFORE UPDATE ON meeting_templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_training_plans_updated_at BEFORE UPDATE ON training_plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_user_progression_updated_at BEFORE UPDATE ON user_progression
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_meeting_instances_updated_at BEFORE UPDATE ON meeting_instances
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- SEED DATA
-- =====================================================

-- Example org structure roles (will be inserted per brokerage)
-- INSERT INTO org_structure (brokerage_id, role_name, description, level) VALUES
-- ('brokerage-uuid', 'Managing Broker', 'Oversees all brokerage operations', 0),
-- ('brokerage-uuid', 'Team Lead', 'Manages a team of agents', 1),
-- ('brokerage-uuid', 'Senior Agent', 'Experienced agent with proven track record', 2),
-- ('brokerage-uuid', 'Agent', 'Licensed real estate agent', 2),
-- ('brokerage-uuid', 'Junior Agent', 'New agent in training', 3);

-- Example meeting templates
-- INSERT INTO meeting_templates (brokerage_id, name, cadence, agenda, duration_minutes) VALUES
-- ('brokerage-uuid', 'Weekly Pipeline Review', 'weekly', '[{"title": "Hot Leads Review", "duration_minutes": 10}, {"title": "Deals in Progress", "duration_minutes": 15}, {"title": "Upcoming Closings", "duration_minutes": 10}]', 60);
