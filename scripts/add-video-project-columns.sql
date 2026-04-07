-- Migration: Add canonical columns to ai_video_projects per document spec
-- Safe to run multiple times (IF NOT EXISTS).

-- thumbnail_url: hosted thumbnail for the generated video
ALTER TABLE public.ai_video_projects
  ADD COLUMN IF NOT EXISTS thumbnail_url text;

-- background_type: solid | gradient | branded | image | stock
ALTER TABLE public.ai_video_projects
  ADD COLUMN IF NOT EXISTS background_type text;

-- background_url: URL of custom background image (when background_type = 'image' or 'stock')
ALTER TABLE public.ai_video_projects
  ADD COLUMN IF NOT EXISTS background_url text;

-- format: horizontal | square | vertical (maps to output_orientation)
ALTER TABLE public.ai_video_projects
  ADD COLUMN IF NOT EXISTS format text;

-- captions_enabled: whether captions were requested
ALTER TABLE public.ai_video_projects
  ADD COLUMN IF NOT EXISTS captions_enabled boolean DEFAULT false;
