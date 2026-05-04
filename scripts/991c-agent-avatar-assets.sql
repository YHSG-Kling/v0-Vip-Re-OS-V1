-- agent_avatar_assets: multi-avatar library per agent.
-- Each row is one named avatar (photo or video source) with its
-- D-ID avatar_id once D-ID has processed the source.
-- agent_voice_profiles.did_avatar_id mirrors the default avatar_id
-- so existing generate-video callers need only one extra column.

-- ─── Multi-avatar asset library ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.agent_avatar_assets (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid        NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  brokerage_id    uuid        REFERENCES public.brokerages(id),
  label           text        NOT NULL DEFAULT 'My Avatar',
  source_type     text        NOT NULL CHECK (source_type IN ('photo', 'video')),
  source_url      text        NOT NULL,
  did_avatar_id   text,
  status          text        NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
  thumbnail_url   text,
  error_message   text,
  is_default      boolean     NOT NULL DEFAULT false,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_avatar_assets_agent
  ON public.agent_avatar_assets(agent_id);

CREATE INDEX IF NOT EXISTS idx_agent_avatar_assets_did
  ON public.agent_avatar_assets(did_avatar_id) WHERE did_avatar_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_avatar_assets_status
  ON public.agent_avatar_assets(status);

ALTER TABLE public.agent_avatar_assets ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'Service role manages agent_avatar_assets'
      AND tablename   = 'agent_avatar_assets'
  ) THEN
    CREATE POLICY "Service role manages agent_avatar_assets"
      ON public.agent_avatar_assets FOR ALL USING (true);
  END IF;
END$$;

-- ─── Primary avatar shortcut on the existing profile row ─────────────────────
-- Stores the active D-ID avatar_id directly on agent_voice_profiles so
-- generate-video and chat-widget lookups remain single-row joins.
ALTER TABLE public.agent_voice_profiles
  ADD COLUMN IF NOT EXISTS did_avatar_id text;

-- Index for quick lookup when routing clips generation
CREATE INDEX IF NOT EXISTS idx_agent_voice_profiles_did_avatar
  ON public.agent_voice_profiles(did_avatar_id) WHERE did_avatar_id IS NOT NULL;
