-- ============================================================================
-- Migration 1052 — Videos: audience_type (in-house vs customer-facing) +
--                          video_render_log if missing
-- ============================================================================
--
-- Two missing pieces my previous video sprint glossed over:
--
-- 1. audience_type on ai_video_projects
--    The same table holds BOTH internal training videos (agent intro,
--    system tutorial, compliance walkthrough) AND customer-facing videos
--    (just-listed reel, market-update, lesson). They have DIFFERENT
--    compliance gates:
--      in_house        → brand voice + admin approval only
--      customer_facing → brand voice + admin approval + DNC/TCPA/fair-
--                        housing via evaluateKernelOutbound at distribute
--    Default 'customer_facing' (safer — over-restrict by default).
--
-- 2. video_render_log
--    Supabase/migrations/025 created this but it may not be on this
--    instance. Idempotently ensure it exists so the provider resolver
--    can compare D-ID vs HeyGen render costs over time.
--
-- D-ID is the default provider per agent_voice_profiles.preferred_avatar_provider
-- DEFAULT 'did' (migration 025). My earlier code hardcoded 'heygen'; the
-- accompanying lib/marketing/video-provider-resolver.ts fixes that by
-- reading the agent + brokerage preference at video creation time.
-- ============================================================================

BEGIN;

ALTER TABLE ai_video_projects
  ADD COLUMN IF NOT EXISTS audience_type text NOT NULL DEFAULT 'customer_facing';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ai_video_projects_audience_type_check') THEN
    ALTER TABLE ai_video_projects ADD CONSTRAINT ai_video_projects_audience_type_check
      CHECK (audience_type IN ('in_house','customer_facing'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_avp_audience_type
  ON ai_video_projects(brokerage_id, audience_type, approval_status);

-- Compliance evaluation result stored once per customer-facing video so
-- distributeVideoAsset can fail fast on already-blocked videos and admin
-- reviewers see what was checked.
ALTER TABLE ai_video_projects
  ADD COLUMN IF NOT EXISTS compliance_status text NOT NULL DEFAULT 'not_evaluated',
  ADD COLUMN IF NOT EXISTS compliance_violations jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS compliance_evaluated_at timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='ai_video_projects_compliance_status_check') THEN
    ALTER TABLE ai_video_projects ADD CONSTRAINT ai_video_projects_compliance_status_check
      CHECK (compliance_status IN ('not_evaluated','passed','failed','needs_review'));
  END IF;
END$$;

-- video_render_log — supabase/migrations/025 may not be applied to this
-- live instance; idempotently create.
CREATE TABLE IF NOT EXISTS video_render_log (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id              uuid        REFERENCES ai_video_projects(id) ON DELETE SET NULL,
  brokerage_id            uuid        REFERENCES brokerages(id) ON DELETE CASCADE,
  provider                text        NOT NULL,
  cost_cents              int,
  render_duration_seconds int,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_vrl_brokerage ON video_render_log(brokerage_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_vrl_provider  ON video_render_log(provider, created_at DESC);

ALTER TABLE video_render_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS vrl_service_all ON video_render_log;
CREATE POLICY vrl_service_all ON video_render_log FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS vrl_tenant_select ON video_render_log;
CREATE POLICY vrl_tenant_select ON video_render_log FOR SELECT
  USING (brokerage_id = current_user_brokerage_id());

-- Pre-existing video_provider CHECK never included 'did' even though
-- @d-id/client-sdk is the platform's primary avatar provider. Extend so
-- the resolver can persist its choice.
DO $$
BEGIN
  ALTER TABLE ai_video_projects DROP CONSTRAINT IF EXISTS ai_video_projects_video_provider_check;
EXCEPTION WHEN undefined_object THEN NULL; END$$;
ALTER TABLE ai_video_projects ADD CONSTRAINT ai_video_projects_video_provider_check
  CHECK (video_provider = ANY (ARRAY['did','heygen','google_flow','synthesia','custom','upload']));

COMMIT;
