-- ===========================================================================
-- 1087-ai-video-projects-intro-outro-broll.sql
--
-- Cinematic touches the agent can layer onto an AI video from the wizard
-- without touching a video editor. The whole UX is "answer basic
-- questions → finished branded video" — the agent picks from a curated
-- stock library of intros, outros, and b-roll, and the poll cron stitches
-- everything together with branding overlays after D-ID returns.
--
--   intro_video_url  brand intro / drone fly-in / logo sting before the
--                    talking head
--   outro_video_url  closing shot / drone fly-away / CTA card after the
--                    talking head
--   b_roll_urls      list of clips to splice into the main timeline (future:
--                    segment-aware splicing; today stored so the BrollPicker
--                    UI and the audit trail know what the agent picked)
--
-- The cron concatenates intro -> main -> outro after the brand-overlay
-- step. Intro and outro come from the brokerage's stock library
-- (video_assets) so they are already brokerage-approved and don't need
-- their own attribution band overlaid.
--
-- APPLIED VIA: supabase apply_migration "ai_video_projects_intro_outro_broll"
-- ===========================================================================

ALTER TABLE public.ai_video_projects
  ADD COLUMN IF NOT EXISTS intro_video_url text,
  ADD COLUMN IF NOT EXISTS outro_video_url text,
  ADD COLUMN IF NOT EXISTS b_roll_urls     jsonb DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_video_assets_brokerage_category
  ON public.video_assets(brokerage_id, category);
