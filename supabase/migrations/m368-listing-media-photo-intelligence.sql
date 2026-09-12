-- m368 — listing_media absorbs the photo-intelligence layer from listing_photos.
--
-- WHY: listing_photos and listing_media are the SAME concept spelled two ways
-- (photo_url/file_url, order_index/sort_order, is_hero/is_primary). listing_media
-- already models photos (media_type CHECK admits 'photo') and already models the
-- MLS set (usage_intent CHECK mls|public_marketing|both), and it carries the
-- compliance/branding/approval governance MLS advertising rules require
-- (has_eho_mark, has_brokerage_attribution, has_logo_overlay,
-- uses_approved_template, kernel_compliance_passed, is_approved). listing_media
-- is therefore the survivor.
--
-- The ONE thing listing_photos had that listing_media did not is the
-- photo-intelligence layer: the vision-derived room type + quality score, the
-- analysis bookkeeping, and the enhancement flag. This migration MOVES those
-- columns onto listing_media so nothing is lost when listing_photos is dropped
-- in m369.
--
-- NOT moved, deliberately:
--   order_index -> listing_media.sort_order   (same meaning, already present)
--   is_hero     -> listing_media.is_primary   (same meaning, already present)
--   photo_url   -> listing_media.file_url     (same meaning, already present)
--
-- Types below are copied from the LIVE listing_photos columns
-- (information_schema.columns), not guessed:
--   room_type             text
--   ai_quality_score      numeric(5,2)
--   ai_analysis_completed boolean NOT NULL DEFAULT false
--   ai_analyzed_at        timestamptz
--   enhancement_applied   boolean NOT NULL DEFAULT false

ALTER TABLE public.listing_media
  ADD COLUMN IF NOT EXISTS room_type             text,
  ADD COLUMN IF NOT EXISTS ai_quality_score      numeric(5,2),
  ADD COLUMN IF NOT EXISTS ai_analysis_completed boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_analyzed_at        timestamptz,
  ADD COLUMN IF NOT EXISTS enhancement_applied   boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.listing_media.room_type IS
  'Vision-derived room type for media_type=''photo'' rows (exterior_front, kitchen, ...). Drives MLS photo ordering. Moved from listing_photos.room_type in m368.';
COMMENT ON COLUMN public.listing_media.ai_quality_score IS
  '0-100 MLS-hero quality score from the photo-intelligence vision pass. NULL = never scored. Moved from listing_photos.ai_quality_score in m368.';
COMMENT ON COLUMN public.listing_media.ai_analysis_completed IS
  'True once the photo-intelligence vision pass has written a result to this row. The nightly cron drains rows where this is false. Moved from listing_photos in m368.';
COMMENT ON COLUMN public.listing_media.ai_analyzed_at IS
  'When the photo-intelligence vision pass last wrote to this row. Moved from listing_photos in m368.';
COMMENT ON COLUMN public.listing_media.enhancement_applied IS
  'True once real pixel enhancement (sharp) has replaced file_url with the enhanced JPEG. Moved from listing_photos in m368.';

COMMENT ON COLUMN public.listing_media.is_primary IS
  'The hero/primary asset of its media_type for the listing. Absorbs listing_photos.is_hero (m368) — for media_type=''photo'' this IS the MLS hero.';
COMMENT ON COLUMN public.listing_media.sort_order IS
  'Display / MLS order within the listing. Absorbs listing_photos.order_index (m368).';

-- listing_photos enforced ONE hero per listing with a UNIQUE partial index
-- (uq_listing_photos_one_hero_per_listing). listing_media had no such guard, so
-- dropping listing_photos without this would silently lose the guarantee and let
-- two heroes exist. Scoped by media_type so a listing may still have one primary
-- photo AND one primary video.
CREATE UNIQUE INDEX IF NOT EXISTS uq_listing_media_one_primary_per_type
  ON public.listing_media (listing_id, media_type)
  WHERE is_primary = true;

-- listing_photos had idx_listing_photos_brokerage; every read here is
-- brokerage-scoped, so carry the tenant index over.
CREATE INDEX IF NOT EXISTS idx_listing_media_brokerage
  ON public.listing_media (brokerage_id);

-- The nightly photo-intelligence sweep scans for unanalyzed photos.
CREATE INDEX IF NOT EXISTS idx_listing_media_photo_analysis_backlog
  ON public.listing_media (listing_id)
  WHERE media_type = 'photo' AND ai_analysis_completed = false;
