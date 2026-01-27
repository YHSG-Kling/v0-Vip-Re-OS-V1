-- AI Auto-Pilot Plans Table
-- Stores AI-generated nurture plans for leads

CREATE TABLE IF NOT EXISTS ai_autopilot_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL,
  agent_id UUID NOT NULL,
  autopilot_level TEXT NOT NULL CHECK (autopilot_level IN ('conservative', 'moderate', 'aggressive')),
  nurture_plan JSONB NOT NULL,
  is_active BOOLEAN DEFAULT true,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paused_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_action_at TIMESTAMPTZ,
  next_action_at TIMESTAMPTZ,
  total_touchpoints INTEGER DEFAULT 0,
  successful_touchpoints INTEGER DEFAULT 0,
  escalated_to_agent BOOLEAN DEFAULT false,
  escalation_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI Auto-Pilot Actions Log (tracks execution of plan touchpoints)
CREATE TABLE IF NOT EXISTS ai_autopilot_actions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  autopilot_plan_id UUID NOT NULL REFERENCES ai_autopilot_plans(id) ON DELETE CASCADE,
  lead_id UUID NOT NULL,
  action_type TEXT NOT NULL, -- send_email, send_property_recommendations, check_engagement, etc.
  action_details JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'failed', 'skipped')),
  scheduled_for TIMESTAMPTZ NOT NULL,
  executed_at TIMESTAMPTZ,
  result JSONB,
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- AI Auto-Pilot Triggers (behavioral triggers that modify the plan)
CREATE TABLE IF NOT EXISTS ai_autopilot_triggers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  autopilot_plan_id UUID NOT NULL REFERENCES ai_autopilot_plans(id) ON DELETE CASCADE,
  trigger_event TEXT NOT NULL, -- property_viewed, email_opened_3_times, no_activity_14_days, etc.
  trigger_action TEXT NOT NULL,
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  action_taken JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_autopilot_plans_lead_id ON ai_autopilot_plans(lead_id);
CREATE INDEX IF NOT EXISTS idx_autopilot_plans_agent_id ON ai_autopilot_plans(agent_id);
CREATE INDEX IF NOT EXISTS idx_autopilot_plans_is_active ON ai_autopilot_plans(is_active);
CREATE INDEX IF NOT EXISTS idx_autopilot_plans_next_action ON ai_autopilot_plans(next_action_at) WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_autopilot_actions_plan_id ON ai_autopilot_actions(autopilot_plan_id);
CREATE INDEX IF NOT EXISTS idx_autopilot_actions_lead_id ON ai_autopilot_actions(lead_id);
CREATE INDEX IF NOT EXISTS idx_autopilot_actions_scheduled ON ai_autopilot_actions(scheduled_for) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_autopilot_actions_status ON ai_autopilot_actions(status);

CREATE INDEX IF NOT EXISTS idx_autopilot_triggers_plan_id ON ai_autopilot_triggers(autopilot_plan_id);

-- Enable RLS
ALTER TABLE ai_autopilot_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_autopilot_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_autopilot_triggers ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any
DROP POLICY IF EXISTS "autopilot_plans_all" ON ai_autopilot_plans;
DROP POLICY IF EXISTS "autopilot_actions_all" ON ai_autopilot_actions;
DROP POLICY IF EXISTS "autopilot_triggers_all" ON ai_autopilot_triggers;

-- RLS Policies (allow authenticated users)
CREATE POLICY "autopilot_plans_all" ON ai_autopilot_plans FOR ALL TO authenticated USING (true);
CREATE POLICY "autopilot_actions_all" ON ai_autopilot_actions FOR ALL TO authenticated USING (true);
CREATE POLICY "autopilot_triggers_all" ON ai_autopilot_triggers FOR ALL TO authenticated USING (true);
