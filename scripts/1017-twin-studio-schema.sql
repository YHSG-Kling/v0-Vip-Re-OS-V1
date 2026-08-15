-- Migration 1017: Twin Studio — bundle look + voice + personality per twin
--
-- A "twin" is the agent's AI digital twin: photo/video avatar + cloned voice
-- + optional personality. Each agent can save several (Professional, Casual,
-- Listing tour, etc.) and pick a default. The default twin's voice_id is what
-- gets synced to agents.voice_id and used by ISA / portal widget / video gen.
--
-- The agent_avatar_assets table already holds the avatar half (did_avatar_id,
-- source_url, status). Extend it to also hold the voice + personality so one
-- row = one complete twin.

ALTER TABLE public.agent_avatar_assets
  -- ElevenLabs voice clone bound to this twin. Null until the voice step
  -- of the wizard completes; the row is still usable as a video-only avatar.
  ADD COLUMN IF NOT EXISTS voice_id text,
  -- The audio sample the user recorded/uploaded for the clone (kept for
  -- re-cloning if the model improves, or for the user to preview).
  ADD COLUMN IF NOT EXISTS voice_sample_url text,
  -- Free-text personality / tone addendum that gets injected into the D-ID
  -- Agent's instructions for this twin specifically.
  ADD COLUMN IF NOT EXISTS personality text,
  -- D-ID Agent id created with THIS twin's presenter + voice. Replaces the
  -- per-agent did_agent_id on agent_voice_profiles when this twin is active.
  ADD COLUMN IF NOT EXISTS did_agent_id text,
  -- Brokerage approval gate. Pending = freshly created, awaits broker review;
  -- approved = usable on portal/embed/video; rejected = locked, can be
  -- recreated. Default 'approved' since most brokerages won't enforce review;
  -- brokers who require approval can set a brokerage_settings flag to flip
  -- the default to 'pending' for new twins (handled application-side).
  ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'approved'
    CHECK (approval_status IN ('pending','approved','rejected')),
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS approved_at timestamptz,
  ADD COLUMN IF NOT EXISTS rejection_reason text;

-- Index for the broker approval-queue view
CREATE INDEX IF NOT EXISTS idx_agent_avatar_assets_approval
  ON public.agent_avatar_assets(brokerage_id, approval_status)
  WHERE approval_status = 'pending';

-- Index for twin lookup by voice (used by syncAgentVoiceId)
CREATE INDEX IF NOT EXISTS idx_agent_avatar_assets_voice
  ON public.agent_avatar_assets(voice_id) WHERE voice_id IS NOT NULL;

-- ─── Brokerage approval gate flag ─────────────────────────────────────────
-- Brokerage admins can require approval before a twin is usable on
-- public-facing surfaces (portal, embed, video). Defaults to false (no
-- approval needed). When true, new twins are created with
-- approval_status='pending' instead of 'approved'.
ALTER TABLE public.brokerages
  ADD COLUMN IF NOT EXISTS twins_require_approval boolean NOT NULL DEFAULT false;
