-- ── APPLIED LIVE 2026-11-09 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 151, lane 151B ──
--
-- L6.3 (lane 150XY open question; OWNER DECISION, wave 151 directive §151B "Photographer"): an ASSIGNED photographer uploads
-- listing photographs for the specific listing they are assigned to — authenticated photographer → permitted listing-media
-- upload → media validation → source / rights and ownership provenance → asset review (never auto-published) → availability →
-- agent notification. No access to unrelated listings.
--
-- SURVIVOR (CLAUDE.md §1): public.listing_media + m993's provenance columns (photo_source, ownership_attested_by / _at /
-- _version). m993 admitted exactly two lawful sources — idx_mls and owner_upload — and left a commissioned photographer's
-- delivery unrecorded (photo_source NULL, app/actions/photo-management.ts processVendorPhotos). The ONE code constant is
-- lib/listings/owner-photo-upload.ts LISTING_PHOTO_SOURCES; this migration widens the CHECK to match its third value.
--
--   vendor_delivery — a photo delivered by the tenant's ASSIGNED photographer vendor for the listing of its booking
--                     (vendor_bookings.listing_id), written only by lib/listings/owner-photo-upload.ts
--                     recordPhotographerDelivery after app/actions/photo-management.ts submitPhotographerDelivery's gate
--                     (requireVendorActor → the booking is this vendor's, confirmed / completed, approved or direct, and
--                     the vendor row is category 'photographer').
--
-- PROVENANCE a vendor_delivery row MUST carry (the second CHECK): the uploading photographer (uploaded_by, a users.id), the
-- photographer's rights attestation (ownership_attested_by = uploaded_by, _at, _version — the statement is the vendor's
-- license to the brokerage for THIS listing, versioned like the owner's), and the booking that authorized it
-- (vendor_booking_id → vendor_bookings). The owner_upload CHECK of m993 is untouched.
--
-- REVIEW IS NOT AUTOMATIC: the writer lands rows with approval_required = true and is_approved = false (listing_media's own
-- review defaults; the Media Manager's approve door — app/actions/listing-media.ts approveListingMedia — is the review) and
-- NEVER appends to listings.photos (the public gallery) — availability follows approval.
--
-- NULL still means "not recorded" (pre-m993 rows, and processVendorPhotos' staff-ingested URLs, which carry no attestation).
-- A NULL passes any CHECK, so the `IS NULL OR` arm m993 spelled is redundant and dropped (the vocabulary guard parses this
-- exact `<constraint> CHECK (<column> IN (…))` shape from a WRITTEN-NOT-APPLIED file to queue the new value).

ALTER TABLE public.listing_media
  ADD COLUMN IF NOT EXISTS vendor_booking_id uuid REFERENCES public.vendor_bookings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS listing_media_vendor_booking_id_idx ON public.listing_media (vendor_booking_id) WHERE vendor_booking_id IS NOT NULL;

ALTER TABLE public.listing_media DROP CONSTRAINT IF EXISTS listing_media_photo_source_check;
ALTER TABLE public.listing_media
  ADD CONSTRAINT listing_media_photo_source_check
  CHECK (photo_source IN ('idx_mls', 'owner_upload', 'vendor_delivery'));

ALTER TABLE public.listing_media DROP CONSTRAINT IF EXISTS listing_media_vendor_delivery_attested_check;
ALTER TABLE public.listing_media
  ADD CONSTRAINT listing_media_vendor_delivery_attested_check
  CHECK (
    photo_source IS DISTINCT FROM 'vendor_delivery'
    OR (uploaded_by IS NOT NULL AND ownership_attested_by IS NOT NULL AND ownership_attested_at IS NOT NULL
        AND ownership_attestation_version IS NOT NULL AND ownership_attested_by = uploaded_by
        AND vendor_booking_id IS NOT NULL)
  );

COMMENT ON COLUMN public.listing_media.photo_source IS
  'Lawful source of a listing photo (owner rulings 2026-11-06 R9 + wave 151 L6.3): idx_mls = the tenant''s own IDX/MLS feed; owner_upload = uploaded by a tenant user who attested ownership; vendor_delivery = delivered by the tenant''s ASSIGNED photographer vendor for the listing of its booking (vendor_booking_id), attested, review-gated. NULL = not recorded. RentCast / Tracerfy / DataZapp are never a photo source.';
COMMENT ON COLUMN public.listing_media.vendor_booking_id IS
  'The vendor_bookings row that authorized a vendor_delivery photo (the assignment evidence). Required by CHECK for vendor_delivery; NULL otherwise.';

-- READ-BACK (integrator, after apply):
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conrelid = 'public.listing_media'::regclass
--      AND conname IN ('listing_media_photo_source_check','listing_media_vendor_delivery_attested_check');
--   SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='listing_media' AND column_name='vendor_booking_id';
-- Then regenerate scripts/schema-snapshot.ts, scripts/schema-fk-map.ts (listing_media.vendor_booking_id → vendor_bookings) and
-- scripts/check-vocabularies.ts (listing_media.photo_source gains vendor_delivery). Apply WITH the code: before this lands, the
-- delivery writer refuses by name (the CHECK rejects 'vendor_delivery' and PGRST204 names vendor_booking_id) and nothing is stored.
