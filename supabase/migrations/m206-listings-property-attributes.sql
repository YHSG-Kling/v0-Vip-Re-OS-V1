-- m206 — listing property attributes + media + sale outcome (Listing Concierge burn).
-- Code across portal-seller, listing pages, marketing automation, and the Remotion
-- listing-video pipeline has referenced these since day one but the columns never
-- existed (every read/write silently failed). Canonical homes:
--   year_built / lot_size / hoa_dues — property attributes (CMA, buyer matching,
--     listing pages, video scripts)
--   primary_photo_url / photos       — listing media (Remotion promos + portal cards;
--     photos is jsonb [{url, caption?, order?}] — files live in the listing_media bucket)
--   sold_date / sold_price           — sale outcome on the listing record (comps,
--     seller lifetime view; transactions stay the closing source of truth)
--   slug                             — public listing-page slug
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS year_built        integer,
  ADD COLUMN IF NOT EXISTS lot_size          numeric,
  ADD COLUMN IF NOT EXISTS hoa_dues          numeric,
  ADD COLUMN IF NOT EXISTS primary_photo_url text,
  ADD COLUMN IF NOT EXISTS photos            jsonb,
  ADD COLUMN IF NOT EXISTS sold_date         date,
  ADD COLUMN IF NOT EXISTS sold_price        numeric,
  ADD COLUMN IF NOT EXISTS slug              text;
