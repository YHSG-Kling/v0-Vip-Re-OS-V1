-- =====================================================
-- MIGRATION 023: UGC Mode field for AI Video Projects
-- =====================================================

ALTER TABLE ai_video_projects
  ADD COLUMN IF NOT EXISTS ugc_mode BOOLEAN NOT NULL DEFAULT FALSE;
