-- m369 — drop listing_photos, the duplicate of listing_media.
--
-- PRECONDITIONS, all verified before this migration was written:
--   · listing_photos = 0 rows, listing_media = 0 rows. No data to migrate.
--   · m368 moved every photo-intelligence column listing_photos had that
--     listing_media lacked (room_type, ai_quality_score, ai_analysis_completed,
--     ai_analyzed_at, enhancement_applied) plus the one-hero-per-listing UNIQUE
--     guard and the brokerage index.
--   · Zero remaining `from("listing_photos")` references in application code —
--     every reader and writer now runs against listing_media with
--     media_type = 'photo'.
--
-- listing_photos is NOT free-standing. Two objects depend on it and are
-- REPOINTED here rather than dropped, because dropping them would delete
-- working capability:
--
--   1. photo_enhancement_jobs.photo_id FK -> listing_photos(id).
--      The enhancement / virtual-staging / twilight pipeline writes a
--      photo_enhancement_jobs row per operation, and photo_id is now a
--      listing_media id. Left pointing at listing_photos, every one of those
--      inserts would be FK-rejected — and supabase-js RESOLVES a rejected
--      insert, so the pipeline would have carried on with a null job id and no
--      audit trail. The FK is repointed to listing_media(id).
--
--   2. photo_enhancement_jobs_set_brokerage() trigger function.
--      It back-fills brokerage_id by joining listing_photos -> listings. With
--      listing_photos gone the function body would raise "relation does not
--      exist" on every insert that takes that branch. It is rewritten to read
--      listing_media directly (which carries brokerage_id itself, so the join
--      through listings is no longer needed) and to pin media_type='photo' so a
--      video id can never be resolved as a photo.

BEGIN;

-- 1. Repoint the enhancement-job FK onto the surviving table.
ALTER TABLE public.photo_enhancement_jobs
  DROP CONSTRAINT IF EXISTS photo_enhancement_jobs_photo_id_fkey;

ALTER TABLE public.photo_enhancement_jobs
  ADD CONSTRAINT photo_enhancement_jobs_photo_id_fkey
  FOREIGN KEY (photo_id) REFERENCES public.listing_media(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.photo_enhancement_jobs.photo_id IS
  'listing_media(id) of a media_type=''photo'' row. Repointed from listing_photos(id) in m369.';

-- 2. Repoint the brokerage back-fill trigger function.
CREATE OR REPLACE FUNCTION public.photo_enhancement_jobs_set_brokerage()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.brokerage_id IS NULL THEN
    IF NEW.agent_id IS NOT NULL THEN
      SELECT brokerage_id INTO NEW.brokerage_id FROM public.agents WHERE id = NEW.agent_id;
    ELSIF NEW.photo_id IS NOT NULL THEN
      -- listing_media carries brokerage_id itself (NOT NULL), so this no longer
      -- has to join through listings. media_type is pinned: an enhancement job
      -- is pixel work on a PHOTO, and resolving a video row here would stamp a
      -- job with a tenant it does not belong to.
      SELECT lm.brokerage_id INTO NEW.brokerage_id
        FROM public.listing_media lm
       WHERE lm.id = NEW.photo_id AND lm.media_type = 'photo';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

-- 3. The duplicate is now unreferenced. Drop it.
--    No CASCADE: if anything still depends on this table the drop must FAIL
--    loudly rather than silently delete the dependent.
DROP TABLE IF EXISTS public.listing_photos;

COMMIT;
