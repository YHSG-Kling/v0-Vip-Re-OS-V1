-- Migration 1016: cache the D-ID Agent id per real-estate-agent.
--
-- D-ID Agents (the conversational, real-time avatar product — replaces the
-- deprecated talks/streams + clips/streams APIs) requires creating an Agent
-- record up-front with the presenter, voice, and custom-LLM endpoint baked
-- in. We cache the returned id on agent_voice_profiles so we never POST to
-- /agents twice for the same agent.
--
-- Adjacent columns already on this row:
--   did_avatar_id           presenter_id (visual)
--   elevenlabs_voice_id     voice clone (TTS)
--   did_agent_id (NEW)      D-ID Agent id (conversational session host)

ALTER TABLE public.agent_voice_profiles
  ADD COLUMN IF NOT EXISTS did_agent_id text;

CREATE INDEX IF NOT EXISTS idx_agent_voice_profiles_did_agent
  ON public.agent_voice_profiles(did_agent_id) WHERE did_agent_id IS NOT NULL;
