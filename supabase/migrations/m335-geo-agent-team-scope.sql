-- m335 — GEO is for agents, teams and brokerages (owner rule)
--
-- The AI-search citation rail was brokerage-scoped at every layer:
--
--   · ai_search_citation_observations carried brokerage_id + project_id.
--   · ai_search_landing_citation_observations carried brokerage_id + form_id.
--   · the GEO tab filtered on brokerage_id alone.
--
-- So an agent looking at GEO saw the whole brokerage's citations — including
-- reels that were not theirs — and could not see their own. A team lead had no
-- team view at all. GEO is the one marketing surface where the unit of value is
-- the PERSON: an AI answer naming an agent is that agent's lead, not the
-- brokerage's.
--
-- WHY DENORMALISE RATHER THAN JOIN. The reel path could reach an agent through
-- ai_video_projects.agent_id, but the landing path goes through
-- lead_capture_forms, and both joins cross tables a reader may not be permitted
-- to see. Stamping the owner ON the observation at write time keeps the read a
-- single filtered scan and keeps the row self-describing — the same reason the
-- observation already carries public_slug rather than re-joining for it.
--
-- team_id is stamped from agents.team_id AS OF the observation. That is
-- deliberate: it records who the citation belonged to on the day it happened, so
-- an agent moving teams does not silently rewrite last quarter's GEO history.
--
-- Both columns are NULLABLE. A brokerage-level page (no agent_id on the source
-- row) genuinely has no agent, and an agent on no team genuinely has no team —
-- NULL is the honest value, not a placeholder to invent.

ALTER TABLE public.ai_search_citation_observations
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS team_id  uuid REFERENCES public.teams(id)  ON DELETE SET NULL;

ALTER TABLE public.ai_search_landing_citation_observations
  ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS team_id  uuid REFERENCES public.teams(id)  ON DELETE SET NULL;

-- The three scopes the owner named, each a covered read.
CREATE INDEX IF NOT EXISTS idx_ai_search_cit_obs_agent
  ON public.ai_search_citation_observations (brokerage_id, agent_id, observed_on DESC);
CREATE INDEX IF NOT EXISTS idx_ai_search_cit_obs_team
  ON public.ai_search_citation_observations (brokerage_id, team_id, observed_on DESC);
CREATE INDEX IF NOT EXISTS idx_ai_search_land_obs_agent
  ON public.ai_search_landing_citation_observations (brokerage_id, agent_id, observed_on DESC);
CREATE INDEX IF NOT EXISTS idx_ai_search_land_obs_team
  ON public.ai_search_landing_citation_observations (brokerage_id, team_id, observed_on DESC);

COMMENT ON COLUMN public.ai_search_citation_observations.agent_id IS
  'The agent who owns the cited page (ai_video_projects.agent_id), stamped at observation time. NULL for a brokerage-level page.';
COMMENT ON COLUMN public.ai_search_citation_observations.team_id IS
  'The agent''s team AS OF this observation — history is not rewritten when an agent changes teams. NULL when the agent is on no team.';
COMMENT ON COLUMN public.ai_search_landing_citation_observations.agent_id IS
  'The agent who owns the cited lead-magnet page (lead_capture_forms.agent_id), stamped at observation time. NULL for a brokerage-level page.';
COMMENT ON COLUMN public.ai_search_landing_citation_observations.team_id IS
  'The agent''s team AS OF this observation. NULL when the agent is on no team.';
