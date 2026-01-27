-- Journey Task Completions Table
-- Tracks client progress through journey stages and tasks

-- Create journey_task_completions table
CREATE TABLE IF NOT EXISTS journey_task_completions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  stage_name TEXT NOT NULL,
  task_title TEXT NOT NULL,
  task_type TEXT DEFAULT 'checkbox',
  completed_at TIMESTAMPTZ DEFAULT NOW(),
  form_data JSONB DEFAULT '{}',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create index for fast lookups by contact
CREATE INDEX IF NOT EXISTS idx_journey_task_completions_contact ON journey_task_completions(contact_id);
CREATE INDEX IF NOT EXISTS idx_journey_task_completions_task ON journey_task_completions(task_id);

-- Create journey_stage_progress table to track overall stage progress
CREATE TABLE IF NOT EXISTS journey_stage_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  persona TEXT NOT NULL,
  current_stage_id TEXT NOT NULL,
  current_stage_index INTEGER DEFAULT 0,
  stages_completed INTEGER DEFAULT 0,
  total_stages INTEGER NOT NULL,
  last_activity_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(contact_id)
);

-- Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_journey_stage_progress_contact ON journey_stage_progress(contact_id);

-- Insert demo progress for first-time buyer (Sarah)
INSERT INTO journey_stage_progress (contact_id, persona, current_stage_id, current_stage_index, stages_completed, total_stages)
VALUES ('00000000-0000-0000-0000-000000000001', 'first_time_buyer', 'getting_started', 1, 1, 7)
ON CONFLICT (contact_id) DO UPDATE SET
  current_stage_index = EXCLUDED.current_stage_index,
  stages_completed = EXCLUDED.stages_completed,
  last_activity_at = NOW();

-- Insert demo progress for investor (Marcus)
INSERT INTO journey_stage_progress (contact_id, persona, current_stage_id, current_stage_index, stages_completed, total_stages)
VALUES ('00000000-0000-0000-0000-000000000005', 'investor', 'deal_sourcing', 1, 1, 4)
ON CONFLICT (contact_id) DO UPDATE SET
  current_stage_index = EXCLUDED.current_stage_index,
  stages_completed = EXCLUDED.stages_completed,
  last_activity_at = NOW();

-- Insert some completed tasks for demo
INSERT INTO journey_task_completions (contact_id, task_id, stage_id, stage_name, task_title, task_type, form_data)
VALUES 
  ('00000000-0000-0000-0000-000000000001', 'first_time_buyer-education-task-0', 'education', 'Homebuyer Education', 'Complete homebuyer education course', 'checkbox', '{"completed": true}'),
  ('00000000-0000-0000-0000-000000000001', 'first_time_buyer-education-task-1', 'education', 'Homebuyer Education', 'Review down payment options', 'form', '{"selectedOption": "fha_3.5", "notes": "Looking at FHA 3.5% down"}'),
  ('00000000-0000-0000-0000-000000000005', 'investor-investment_strategy-task-0', 'investment_strategy', 'Investment Strategy', 'Define investment goals', 'form', '{"strategy": "buy_and_hold", "targetROI": "8%", "timeline": "5+ years"}'),
  ('00000000-0000-0000-0000-000000000005', 'investor-investment_strategy-task-1', 'investment_strategy', 'Investment Strategy', 'Set property criteria', 'form', '{"propertyTypes": ["sfh", "duplex"], "priceRange": "$200k-$400k", "targetCapRate": "6%+"}')
ON CONFLICT DO NOTHING;
