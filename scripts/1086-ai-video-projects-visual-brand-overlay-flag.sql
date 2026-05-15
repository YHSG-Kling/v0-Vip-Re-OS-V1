-- ===========================================================================
-- 1086-ai-video-projects-visual-brand-overlay-flag.sql
--
-- ffmpeg-based visual brand overlay was the "Sprint C" deferred work in
-- lib/did/index.ts — pixel-level logo + attribution band burned into the
-- finished video so non-audio renderings (silent loops, story snippets,
-- thumbnails) still carry the legally-required brokerage attribution.
--
-- This sprint installs ffmpeg-static + fluent-ffmpeg and wires
-- compositeVideoAttribution() into the D-ID poll cron immediately after
-- the rendered video is persisted to Supabase Storage.
--
-- Compliance gate reads has_visual_brand_overlay to verify the overlay
-- step actually ran. Public-marketing videos REQUIRE it; MLS-bound
-- videos REQUIRE it to be FALSE (no agent / brokerage branding allowed
-- on the MLS feed).
--
-- APPLIED VIA: supabase apply_migration "ai_video_projects_visual_brand_overlay_flag"
-- ===========================================================================

ALTER TABLE public.ai_video_projects
  ADD COLUMN IF NOT EXISTS has_visual_brand_overlay boolean DEFAULT false;
