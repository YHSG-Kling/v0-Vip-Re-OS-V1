-- Migration 1022: Track C — cache the per-scenario ElevenLabs Conv AI agent_id
--
-- The agent's on-the-go assistant (Track B) provisions one Conv AI agent per
-- real-estate-agent. Track C — objection live training — provisions one Conv
-- AI agent per scenario (the "prospect" that the agent practices against).
-- Six scenarios today, but the cache scales as scenarios are added without
-- a re-deploy needing to bump the cache.

CREATE TABLE IF NOT EXISTS public.objection_scenario_agents (
  scenario_key      text        PRIMARY KEY,
  conv_ai_agent_id  text        NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.objection_scenario_agents ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies
                 WHERE tablename='objection_scenario_agents'
                 AND policyname='Service role manages objection_scenario_agents') THEN
    CREATE POLICY "Service role manages objection_scenario_agents"
      ON public.objection_scenario_agents FOR ALL USING (true);
  END IF;
END$$;
