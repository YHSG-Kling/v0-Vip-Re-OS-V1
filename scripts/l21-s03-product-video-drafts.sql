-- l21-s03-product-video-drafts.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- PLATFORM PRODUCT VIDEOS — the platform's social pipeline gains a second media
-- type: promo VIDEOS rendered from the real ProductPromoReel Remotion composition
-- (same PRODUCT_ANGLES story as the text posts — one source of truth). A video
-- draft carries the VO script + the rendered file URL; posting a video requires
-- video_url in addition to the permalink. Idempotent.

ALTER TABLE public.platform_social_drafts ADD COLUMN IF NOT EXISTS media_type text NOT NULL DEFAULT 'post'
  CHECK (media_type = ANY (ARRAY['post','video']::text[]));
ALTER TABLE public.platform_social_drafts ADD COLUMN IF NOT EXISTS format text;
ALTER TABLE public.platform_social_drafts ADD COLUMN IF NOT EXISTS script text;
ALTER TABLE public.platform_social_drafts ADD COLUMN IF NOT EXISTS video_url text;
