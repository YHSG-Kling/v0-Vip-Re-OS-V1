-- m096: add the real property_type field to listings
-- property_type (single_family, condo, townhouse, multi_family, land, commercial,
-- residential, ...) is a first-class listing attribute used by lookup auto-fill,
-- search, and marketing — not metadata. Kept as flexible text (no strict CHECK)
-- so provider/OSINT-derived values and the "residential" default all fit.
ALTER TABLE public.listings ADD COLUMN IF NOT EXISTS property_type text;
