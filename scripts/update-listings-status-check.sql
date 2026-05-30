-- Add 'draft' to listings.status so a partial listing row can be persisted
-- before the listing agreement is complete (intentional draft state). The
-- status vocabulary is otherwise the MLS set. Applied to the live project.
ALTER TABLE public.listings DROP CONSTRAINT IF EXISTS listings_status_check;
ALTER TABLE public.listings ADD CONSTRAINT listings_status_check
  CHECK (status = ANY (ARRAY['draft'::text,'coming_soon'::text,'active'::text,'pending'::text,'sold'::text,'expired'::text,'withdrawn'::text]));
