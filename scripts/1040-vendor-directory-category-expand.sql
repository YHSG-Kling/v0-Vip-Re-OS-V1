-- ============================================================================
-- vendor_directory.category — expand allowed values
-- ============================================================================
--
-- Surfaced by the Sprint 5 e2e flow test: the existing 11-value CHECK
-- constraint excluded most homeowner-services categories, so the
-- Forever Mode toolkit couldn't store the vendors it's designed to
-- surface (handyman, property_management, landscaping, hvac, etc.).
--
-- This migration expands the allowed set to cover the full lifecycle:
-- pre-listing prep + closing + post-close homeowner services.
--
-- Side effects: none — all previously-allowed values remain valid.
-- Existing rows are unaffected. Brokers can now write the categories
-- the audience+stage filter (migration 1039) is designed to target.
-- ============================================================================

ALTER TABLE vendor_directory
  DROP CONSTRAINT IF EXISTS vendor_directory_category_check;

ALTER TABLE vendor_directory
  ADD CONSTRAINT vendor_directory_category_check CHECK (category = ANY (ARRAY[
    -- Transaction-stage vendors (originals, retained)
    'inspector', 'lender', 'title', 'attorney', 'contractor',
    'stager', 'photographer', 'cleaner', 'mover', 'insurance',
    -- Forever-mode / homeowner-services vendors
    'handyman', 'property_management', 'landscaping', 'pest_control',
    'pool_service', 'hvac', 'plumber', 'electrician', 'roofer',
    'painter', 'flooring', 'solar', 'security', 'smart_home',
    'appliance_repair', 'window_treatment', 'garage_door',
    'refinance_lender', 'home_warranty', 'tax_pro', 'financial_advisor',
    'interior_design', 'organizer', 'estate_sale',
    -- Pre-listing media vendors
    'videographer', 'drone_pilot', '3d_tour',
    -- Catch-all
    'other'
  ]));
