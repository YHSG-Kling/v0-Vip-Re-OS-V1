-- ============================================================================
-- Migration 1051 — Videos in the marketing kernel
-- ============================================================================
--
-- Closes the video gaps the audit caught:
--
--   1. ai_video_projects gets the approval columns the unified queue needs
--      (approval_status, is_ai_generated, approved_by/at, rejected_by/at,
--      rejection_reason, marketing_campaign_id FK, brand_voice_context jsonb).
--   2. Sprint 7's case "video" can now create a real ai_video_projects row
--      linked to training_videos via heygen_project_id (already exists).
--   3. contacts.video_opt_out for per-contact video suppression so the
--      campaign-publisher's compliance gate can refuse video sends to
--      opted-out contacts (mirroring email/sms/direct_mail handling).
--   4. marketing_campaign_touchpoints.channel CHECK gains 'video' so video
--      sends record correctly.
-- ============================================================================

BEGIN;

-- 1. ai_video_projects approval + AI provenance + campaign FK + brand voice ──
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='ai_video_projects') THEN
    -- Approval workflow
    BEGIN ALTER TABLE ai_video_projects ADD COLUMN IF NOT EXISTS approval_status text NOT NULL DEFAULT 'pending_review'; EXCEPTION WHEN duplicate_column THEN NULL; END;
    BEGIN ALTER TABLE ai_video_projects ADD CONSTRAINT ai_video_projects_approval_status_check
      CHECK (approval_status IN ('draft','pending_review','approved','rejected','published'));
    EXCEPTION WHEN duplicate_object THEN NULL; END;
    BEGIN ALTER TABLE ai_video_projects ADD COLUMN IF NOT EXISTS is_ai_generated boolean NOT NULL DEFAULT true; EXCEPTION WHEN duplicate_column THEN NULL; END;
    BEGIN ALTER TABLE ai_video_projects ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users(id) ON DELETE SET NULL; EXCEPTION WHEN duplicate_column THEN NULL; END;
    BEGIN ALTER TABLE ai_video_projects ADD COLUMN IF NOT EXISTS approved_at timestamptz; EXCEPTION WHEN duplicate_column THEN NULL; END;
    BEGIN ALTER TABLE ai_video_projects ADD COLUMN IF NOT EXISTS rejected_by uuid REFERENCES users(id) ON DELETE SET NULL; EXCEPTION WHEN duplicate_column THEN NULL; END;
    BEGIN ALTER TABLE ai_video_projects ADD COLUMN IF NOT EXISTS rejected_at timestamptz; EXCEPTION WHEN duplicate_column THEN NULL; END;
    BEGIN ALTER TABLE ai_video_projects ADD COLUMN IF NOT EXISTS rejection_reason text; EXCEPTION WHEN duplicate_column THEN NULL; END;

    -- Campaign FK so videos roll into the marketing rollup like other channels
    BEGIN ALTER TABLE ai_video_projects ADD COLUMN IF NOT EXISTS marketing_campaign_id uuid REFERENCES marketing_campaigns(id) ON DELETE SET NULL; EXCEPTION WHEN duplicate_column THEN NULL; END;

    -- Brand voice context applied during generation (about_text / bio_text /
    -- team_bio / brand_voice_tone — same shape as generateAIEducation).
    BEGIN ALTER TABLE ai_video_projects ADD COLUMN IF NOT EXISTS brand_voice_context jsonb NOT NULL DEFAULT '{}'::jsonb; EXCEPTION WHEN duplicate_column THEN NULL; END;

    -- Link back to the learning_module that triggered this video (Sprint 7 cont.)
    BEGIN ALTER TABLE ai_video_projects ADD COLUMN IF NOT EXISTS learning_module_id uuid; EXCEPTION WHEN duplicate_column THEN NULL; END;

    CREATE INDEX IF NOT EXISTS idx_avp_pending_review
      ON ai_video_projects(brokerage_id, created_at DESC)
      WHERE approval_status = 'pending_review';
    CREATE INDEX IF NOT EXISTS idx_avp_marketing_campaign
      ON ai_video_projects(marketing_campaign_id)
      WHERE marketing_campaign_id IS NOT NULL;
  END IF;
END$$;

-- 2. video_scripts_library — backfill audit columns (it already has
--    approval_status + ai_generated). Add approved_by / rejected_by /
--    rejection_reason for parity with other AI-content tables.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='video_scripts_library') THEN
    BEGIN ALTER TABLE video_scripts_library ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES users(id) ON DELETE SET NULL; EXCEPTION WHEN duplicate_column THEN NULL; END;
    BEGIN ALTER TABLE video_scripts_library ADD COLUMN IF NOT EXISTS approved_at timestamptz; EXCEPTION WHEN duplicate_column THEN NULL; END;
    BEGIN ALTER TABLE video_scripts_library ADD COLUMN IF NOT EXISTS rejected_by uuid REFERENCES users(id) ON DELETE SET NULL; EXCEPTION WHEN duplicate_column THEN NULL; END;
    BEGIN ALTER TABLE video_scripts_library ADD COLUMN IF NOT EXISTS rejected_at timestamptz; EXCEPTION WHEN duplicate_column THEN NULL; END;
    BEGIN ALTER TABLE video_scripts_library ADD COLUMN IF NOT EXISTS rejection_reason text; EXCEPTION WHEN duplicate_column THEN NULL; END;
  END IF;
END$$;

-- 3. contacts.video_opt_out (parity with email_opt_out / sms_opt_out)
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS video_opt_out boolean NOT NULL DEFAULT false;

-- 4. Add 'video' to marketing_campaign_touchpoints.channel CHECK
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'marketing_campaign_touchpoints_channel_check') THEN
    ALTER TABLE marketing_campaign_touchpoints DROP CONSTRAINT marketing_campaign_touchpoints_channel_check;
  END IF;
  ALTER TABLE marketing_campaign_touchpoints ADD CONSTRAINT marketing_campaign_touchpoints_channel_check
    CHECK (channel IN ('email','sms','direct_mail','social','qr_scan','blog','podcast','newsletter','phone','portal','video'));
END$$;

-- 5. training_videos.is_ai_generated (so Sprint 7 video fan-out can mark its rows)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='training_videos') THEN
    BEGIN ALTER TABLE training_videos ADD COLUMN IF NOT EXISTS is_ai_generated boolean NOT NULL DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END;
    BEGIN ALTER TABLE training_videos ADD COLUMN IF NOT EXISTS ai_video_project_id uuid REFERENCES ai_video_projects(id) ON DELETE SET NULL; EXCEPTION WHEN duplicate_column THEN NULL; END;
  END IF;
END$$;

-- 6. Extend ai_video_projects.video_type CHECK so Sprint 7 education + social
--    reel video flows can persist. Original CHECK only allowed listing-side
--    types (listing_tour, just_listed, etc.) which broke learning-module fan-out.
DO $$
BEGIN
  ALTER TABLE ai_video_projects DROP CONSTRAINT IF EXISTS ai_video_projects_video_type_check;
EXCEPTION WHEN undefined_object THEN NULL; END$$;
ALTER TABLE ai_video_projects ADD CONSTRAINT ai_video_projects_video_type_check
  CHECK (video_type = ANY (ARRAY[
    'listing_tour','pre_appointment','coming_soon','just_listed',
    'open_house_promo','just_sold','agent_intro','market_update',
    'education','social_reel','listing_promo','testimonial','welcome'
  ]));

COMMIT;
