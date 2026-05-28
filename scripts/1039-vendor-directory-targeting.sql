-- ============================================================================
-- Vendor Directory — team scoping + audience/stage targeting
-- ============================================================================
--
-- Today vendor_directory has only brokerage_id and a free-text `category`.
-- That makes it impossible to:
--   (a) maintain a team-level curated list separate from the brokerage's
--   (b) target specific vendors at specific contact personas (a first-time
--       buyer needs movers + home warranty; an investor needs property
--       managers + tax pros)
--   (c) surface different vendors at different lifecycle stages (pre-
--       listing prep vs under-contract vs post-close homeowner services)
--
-- This migration adds the targeting metadata. UI then filters the
-- contact's view by the matching tags, while still falling back to the
-- whole list when nothing matches (broad-cast behavior preserved).
-- ============================================================================

ALTER TABLE vendor_directory
  ADD COLUMN IF NOT EXISTS team_id        uuid REFERENCES teams(id) ON DELETE SET NULL,

  -- Audience tags. UI matches against contact.contact_persona +
  -- contact.contact_type. NULL/empty array = show to everyone.
  -- Example values: 'first_time_buyer', 'investor', 'downsizer',
  -- 'luxury_buyer', 'seller', 'lifetime_customer'.
  ADD COLUMN IF NOT EXISTS audience_tags  text[] NOT NULL DEFAULT ARRAY[]::text[],

  -- Lifecycle stage tags. UI matches against the contact's current
  -- portal_view + transaction stage. NULL/empty = show on every stage.
  -- Example values: 'pre_listing', 'under_contract', 'closing_prep',
  -- 'closed', 'forever' (= homeowner services post-close).
  ADD COLUMN IF NOT EXISTS stage_tags     text[] NOT NULL DEFAULT ARRAY[]::text[],

  -- Display priority — higher floats to the top within a category.
  -- Lets the broker pin a single preferred vendor per category.
  ADD COLUMN IF NOT EXISTS display_priority int NOT NULL DEFAULT 0,

  -- Visibility flag — broker can hide a vendor from the contact portal
  -- without deleting the row. Defaults to TRUE so existing rows stay
  -- visible.
  ADD COLUMN IF NOT EXISTS visible_in_portal boolean NOT NULL DEFAULT true;

CREATE INDEX IF NOT EXISTS idx_vendor_directory_team
  ON vendor_directory(team_id) WHERE team_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_vendor_directory_visible
  ON vendor_directory(brokerage_id, visible_in_portal, display_priority DESC)
  WHERE visible_in_portal = true;

-- GIN indexes so audience/stage filters scan quickly even with many rows.
CREATE INDEX IF NOT EXISTS idx_vendor_directory_audience
  ON vendor_directory USING gin(audience_tags);

CREATE INDEX IF NOT EXISTS idx_vendor_directory_stage
  ON vendor_directory USING gin(stage_tags);

COMMENT ON COLUMN vendor_directory.audience_tags IS
  'Contact-persona / contact-type tags. UI surfaces this vendor when the contact''s persona or type intersects this array. Empty array = show to everyone.';

COMMENT ON COLUMN vendor_directory.stage_tags IS
  'Lifecycle-stage tags (pre_listing / under_contract / closing_prep / closed / forever). UI surfaces this vendor when the contact''s current stage intersects this array. Empty = show on every stage.';
