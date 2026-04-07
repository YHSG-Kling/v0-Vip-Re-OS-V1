-- Migration: add IDX property snapshot columns to saved_properties
-- These store MLS data at save-time so IDX results can be displayed
-- without re-fetching. listing_id remains nullable and is only set
-- when the saved property is confirmed as a brokerage listing.

ALTER TABLE saved_properties
  ADD COLUMN IF NOT EXISTS property_address  text,
  ADD COLUMN IF NOT EXISTS mls_number        text,
  ADD COLUMN IF NOT EXISTS list_price        numeric,
  ADD COLUMN IF NOT EXISTS bedrooms          integer,
  ADD COLUMN IF NOT EXISTS bathrooms         numeric,
  ADD COLUMN IF NOT EXISTS sqft              integer,
  ADD COLUMN IF NOT EXISTS city              text,
  ADD COLUMN IF NOT EXISTS state             text,
  ADD COLUMN IF NOT EXISTS property_type     text,
  ADD COLUMN IF NOT EXISTS primary_photo_url text;

-- Index to speed up the brokerage-listing join in the dual agency query
CREATE INDEX IF NOT EXISTS idx_saved_properties_listing_id
  ON saved_properties (listing_id)
  WHERE listing_id IS NOT NULL;
