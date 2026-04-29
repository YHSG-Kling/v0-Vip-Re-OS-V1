-- =====================================================
-- MIGRATION 025: Multi-Provider Video Stack
-- =====================================================
-- Adds ElevenLabs voice ID, D-ID photo URL, and preferred
-- avatar provider to agent_voice_profiles so the provider
-- resolver can route each video to the cheapest capable provider.
-- Also adds video_render_log for cost tracking per brokerage.
-- =====================================================

-- ─── agent_voice_profiles additions ──────────────────────────────────────────
ALTER TABLE agent_voice_profiles
  ADD COLUMN IF NOT EXISTS elevenlabs_voice_id      TEXT,
  ADD COLUMN IF NOT EXISTS did_photo_url            TEXT,
  ADD COLUMN IF NOT EXISTS preferred_avatar_provider TEXT NOT NULL DEFAULT 'did'
    CHECK (preferred_avatar_provider IN ('did', 'heygen'));

-- ─── video_render_log ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS video_render_log (
  id                     UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id             UUID        REFERENCES ai_video_projects(id) ON DELETE SET NULL,
  provider               TEXT        NOT NULL,   -- 'did' | 'heygen' | 'elevenlabs_slideshow'
  cost_cents             INTEGER,                -- populated post-billing reconciliation
  render_duration_seconds INTEGER,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE video_render_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "brokerage_video_render_log"
  ON video_render_log FOR ALL
  USING (
    project_id IN (
      SELECT id FROM ai_video_projects WHERE brokerage_id = auth.user_brokerage_id()
    )
  );
