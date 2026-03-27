-- Add contact_id and listing_id to vendor_bookings
-- contact_id: who the booking is for (buyer/seller contact)
-- listing_id: direct link to listing, avoids join through transactions

ALTER TABLE public.vendor_bookings
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS listing_id uuid REFERENCES public.listings(id) ON DELETE SET NULL;

-- Indexes for fast lookups on both new FK columns
CREATE INDEX IF NOT EXISTS idx_vendor_bookings_contact_id
  ON public.vendor_bookings (contact_id)
  WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vendor_bookings_listing_id
  ON public.vendor_bookings (listing_id)
  WHERE listing_id IS NOT NULL;

-- Back-fill listing_id from transactions where possible
UPDATE public.vendor_bookings vb
SET listing_id = t.listing_id
FROM public.transactions t
WHERE vb.transaction_id = t.id
  AND t.listing_id IS NOT NULL
  AND vb.listing_id IS NULL;

-- Back-fill contact_id from transactions where possible (use buyer_contact_id as primary)
UPDATE public.vendor_bookings vb
SET contact_id = COALESCE(t.buyer_contact_id, t.contact_id)
FROM public.transactions t
WHERE vb.transaction_id = t.id
  AND COALESCE(t.buyer_contact_id, t.contact_id) IS NOT NULL
  AND vb.contact_id IS NULL;
