-- Add listing_id and metadata columns to transparency_updates
-- Required for shareNetSheetToPortal which links net sheet updates to a listing
ALTER TABLE transparency_updates
  ADD COLUMN IF NOT EXISTS listing_id uuid REFERENCES listings(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS metadata jsonb;

CREATE INDEX IF NOT EXISTS idx_transparency_updates_listing_id
  ON transparency_updates(listing_id)
  WHERE listing_id IS NOT NULL;
