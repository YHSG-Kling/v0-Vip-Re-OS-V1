-- Plan FIX 0C.6 / J5A: Voice & Avatar Setup is one unified profile per agent —
-- ElevenLabs cloned voice + D-ID avatar source (photo or video). Used by podcast,
-- video studio, AI ISA, and chat widget. Backed by agent_voice_profiles (canonical).

ALTER TABLE public.agent_voice_profiles
  ADD COLUMN IF NOT EXISTS elevenlabs_voice_id text,
  ADD COLUMN IF NOT EXISTS did_photo_url text,
  ADD COLUMN IF NOT EXISTS did_video_url text,
  ADD COLUMN IF NOT EXISTS preferred_avatar_provider text DEFAULT 'did';

-- Index agent_id for the per-agent lookups in dispatch + video-create-client
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_voice_profiles_agent_id
  ON public.agent_voice_profiles(agent_id);

CREATE INDEX IF NOT EXISTS idx_agent_voice_profiles_brokerage
  ON public.agent_voice_profiles(brokerage_id) WHERE brokerage_id IS NOT NULL;
