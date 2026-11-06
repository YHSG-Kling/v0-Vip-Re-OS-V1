-- ── APPLIED LIVE 2026-11-06 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 150, lane 150XY ──
--
-- m993 — OWNER-UPLOADED LISTING PHOTOS: SOURCE + OWNERSHIP ATTESTATION ON THE ONE MEDIA STORE (owner ruling 2026-11-06, R9).
--
-- Owner, 2026-11-06: listing photos come from exactly two lawful sources — the tenant's own IDX / MLS feed, and photos the
-- tenant user UPLOADS and OWNS, "stored in the tenant's listing-media bucket with the uploading user, listing and an ownership
-- attestation recorded; the existing listings.photos / listing-media survivor, never a second media store".
--
-- SURVIVOR (CLAUDE.md §1, extend before replacing): public.listing_media — the ONE photo store since m368/m369 (listing_photos
-- was merged onto it and dropped). It already records the uploader (uploaded_by → users.id) and the listing (listing_id →
-- listings.id). What it did NOT record is WHERE a photo came from and THAT the uploader attested to owning it. Four columns, no
-- new table. listings.photos (jsonb, m206) stays the denormalised gallery the listing page / portal / producers read; the one
-- writer lib/listings/owner-photo-upload.ts recordOwnerUploadedListingPhoto appends the same provenance onto each entry.
--
-- Existing rows keep photo_source NULL = "not recorded" (never back-filled to a source nobody attested). The CHECK makes an
-- owner_upload row without its uploader + attestation impossible, so the attestation cannot be skipped by a second writer.

ALTER TABLE public.listing_media
  ADD COLUMN IF NOT EXISTS photo_source                  text,
  ADD COLUMN IF NOT EXISTS ownership_attested_by         uuid REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ownership_attested_at         timestamptz,
  ADD COLUMN IF NOT EXISTS ownership_attestation_version text;

ALTER TABLE public.listing_media DROP CONSTRAINT IF EXISTS listing_media_photo_source_check;
ALTER TABLE public.listing_media
  ADD CONSTRAINT listing_media_photo_source_check
  CHECK (photo_source IS NULL OR photo_source IN ('idx_mls', 'owner_upload'));

ALTER TABLE public.listing_media DROP CONSTRAINT IF EXISTS listing_media_owner_upload_attested_check;
ALTER TABLE public.listing_media
  ADD CONSTRAINT listing_media_owner_upload_attested_check
  CHECK (
    photo_source IS DISTINCT FROM 'owner_upload'
    OR (uploaded_by IS NOT NULL AND ownership_attested_by IS NOT NULL AND ownership_attested_at IS NOT NULL
        AND ownership_attestation_version IS NOT NULL AND ownership_attested_by = uploaded_by)
  );

COMMENT ON COLUMN public.listing_media.photo_source IS
  'Lawful source of a listing photo (owner ruling 2026-11-06): idx_mls = the tenant''s own IDX/MLS feed; owner_upload = uploaded by a tenant user who attested ownership. NULL = not recorded (pre-m993). RentCast / Tracerfy / DataZapp are never a photo source.';
COMMENT ON COLUMN public.listing_media.ownership_attested_by IS
  'users.id of the tenant user who attested to owning (or holding a licence to) an owner_upload photo — always the uploader (CHECK).';
COMMENT ON COLUMN public.listing_media.ownership_attested_at IS 'When the ownership attestation was given (server clock).';
COMMENT ON COLUMN public.listing_media.ownership_attestation_version IS
  'Version of the attestation statement shown (lib/listings/owner-photo-upload.ts OWNER_PHOTO_ATTESTATION_VERSION).';

-- READ-BACK (integrator, after apply):
--   SELECT column_name, data_type FROM information_schema.columns
--    WHERE table_schema='public' AND table_name='listing_media'
--      AND column_name IN ('photo_source','ownership_attested_by','ownership_attested_at','ownership_attestation_version');
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid='public.listing_media'::regclass
--      AND conname IN ('listing_media_photo_source_check','listing_media_owner_upload_attested_check');
-- Then regenerate scripts/schema-snapshot.ts, scripts/schema-fk-map.ts (listing_media.ownership_attested_by → users) and
-- scripts/check-vocabularies.ts (listing_media.photo_source).
