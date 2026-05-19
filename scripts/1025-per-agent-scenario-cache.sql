-- Migration 1025: per-agent prospect voice for objection training
--
-- The original cache (script 1022) keyed on scenario_key alone — the first
-- agent to use a scenario would lock the prospect voice for everyone. Since
-- prospect voice is a user preference (agents.prospect_voice_id), each agent
-- needs their own scenario agent provisioned with their chosen voice.
--
-- Drop and recreate with composite PK (scenario_key, agent_id). prospect_voice_id
-- is stored on the cached row so we can detect when the user changes their
-- preference and re-provision. Table is empty when this migration runs (Track C
-- hadn't been used yet), so no data preservation needed.

DROP TABLE IF EXISTS public.objection_scenario_agents;

CREATE TABLE public.objection_scenario_agents (
  scenario_key      text        NOT NULL,
  agent_id          uuid        NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  conv_ai_agent_id  text        NOT NULL,
  prospect_voice_id text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (scenario_key, agent_id)
);

CREATE INDEX idx_objection_scenario_agents_agent
  ON public.objection_scenario_agents(agent_id);

ALTER TABLE public.objection_scenario_agents ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE tablename='objection_scenario_agents'
                 AND policyname='Service role manages objection_scenario_agents') THEN
    CREATE POLICY "Service role manages objection_scenario_agents"
      ON public.objection_scenario_agents FOR ALL USING (true);
  END IF;
END$$;
