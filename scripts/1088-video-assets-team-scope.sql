-- ===========================================================================
-- 1088-video-assets-team-scope.sql
--
-- Team-scoped video assets so a team can curate intros/outros/b-roll/avatar
-- backgrounds that all team members pick from in the wizard without exposing
-- them brokerage-wide. Agent-scoped clips remain private to the uploading
-- agent.
--
-- Scope cascade resolved by the picker (most-specific wins):
--   1. agent_id = me     → my own private clips
--   2. team_id = my team → team library
--   3. brokerage_id only → brokerage library (admin-managed)
--
-- The agent / team uploads via the BrollPicker "Upload" dialog (no admin
-- escalation required). Brokerage-wide publishing stays admin-only (route
-- /dashboard/admin/video-library, separate workflow).
--
-- APPLIED VIA: supabase apply_migration "video_assets_team_scope"
-- ===========================================================================

ALTER TABLE public.video_assets
  ADD COLUMN IF NOT EXISTS team_id uuid REFERENCES public.teams(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_video_assets_team_category
  ON public.video_assets(team_id, category)
  WHERE team_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_video_assets_agent_category
  ON public.video_assets(agent_id, category)
  WHERE agent_id IS NOT NULL;
