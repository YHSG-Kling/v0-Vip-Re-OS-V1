-- Migration: Fix services-config schema mismatches
-- 1. agents: add 'active' column (actions use 'active', schema only has 'is_active')
ALTER TABLE agents ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
UPDATE agents SET active = is_active WHERE active IS DISTINCT FROM is_active;

-- 2. compliance_rules: add stage rule columns used by createStageRule action
ALTER TABLE compliance_rules ADD COLUMN IF NOT EXISTS from_stage text;
ALTER TABLE compliance_rules ADD COLUMN IF NOT EXISTS to_stage text;
ALTER TABLE compliance_rules ADD COLUMN IF NOT EXISTS required_conditions jsonb DEFAULT '[]'::jsonb;
ALTER TABLE compliance_rules ADD COLUMN IF NOT EXISTS auto_transition boolean NOT NULL DEFAULT false;
ALTER TABLE compliance_rules ADD COLUMN IF NOT EXISTS actions_on_transition jsonb DEFAULT '[]'::jsonb;

-- 3. plan_tasks: add playbook columns used by createPlaybook action
--    (getPlaybooks fetches from plan_tasks, createPlaybook inserts into plan_tasks)
ALTER TABLE plan_tasks ADD COLUMN IF NOT EXISTS playbook_name text;
ALTER TABLE plan_tasks ADD COLUMN IF NOT EXISTS trigger_type text;
ALTER TABLE plan_tasks ADD COLUMN IF NOT EXISTS steps jsonb DEFAULT '[]'::jsonb;
ALTER TABLE plan_tasks ADD COLUMN IF NOT EXISTS target_persona_ids uuid[] DEFAULT '{}';
ALTER TABLE plan_tasks ADD COLUMN IF NOT EXISTS active boolean NOT NULL DEFAULT true;
ALTER TABLE plan_tasks ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES brokerages(id) ON DELETE CASCADE;
