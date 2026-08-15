-- Migration: Add missing columns to copilot_plans
-- These columns were present in the application code but missing from the live table.
-- All other tables with agent_id/brokerage_id scope data to the correct agent+brokerage.

-- Add agent_id (FK to agents.id) — required for RLS and agent-scoped queries
ALTER TABLE public.copilot_plans
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL;

-- Add brokerage_id (FK to brokerages.id) — required for brokerage-level RLS
ALTER TABLE public.copilot_plans
  ADD COLUMN IF NOT EXISTS brokerage_id uuid REFERENCES public.brokerages(id) ON DELETE SET NULL;

-- Add plan_data (jsonb) — stores the full AI-generated nurture plan JSON
ALTER TABLE public.copilot_plans
  ADD COLUMN IF NOT EXISTS plan_data jsonb;

-- Add indexes for common query patterns
CREATE INDEX IF NOT EXISTS copilot_plans_agent_id_idx
  ON public.copilot_plans (agent_id);

CREATE INDEX IF NOT EXISTS copilot_plans_brokerage_id_idx
  ON public.copilot_plans (brokerage_id);

CREATE INDEX IF NOT EXISTS copilot_plans_status_idx
  ON public.copilot_plans (status);

-- Enable RLS (it was not previously enabled on this table)
ALTER TABLE public.copilot_plans ENABLE ROW LEVEL SECURITY;

-- RLS policy: agents can only see plans for their own contacts
DROP POLICY IF EXISTS copilot_plans_agent_policy ON public.copilot_plans;
CREATE POLICY copilot_plans_agent_policy ON public.copilot_plans
  FOR ALL
  USING (
    agent_id IN (
      SELECT id FROM public.agents WHERE user_id = auth.uid()
    )
    OR
    brokerage_id IN (
      SELECT brokerage_id FROM public.users WHERE id = auth.uid()
    )
  );
