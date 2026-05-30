-- ===========================================================================
-- 1084-brokerage-advertising-compliance-columns.sql
--
-- Real-estate advertising law requires every public-facing piece of marketing
-- to carry: brokerage name, license # (most states), brokerage logo, and
-- Equal Housing Opportunity attribution (federal Fair Housing Act, when the
-- content is housing-related). Audit found:
--
--   * brokerages has no logo_url, license_number, or license_state columns.
--     The image-generation pipeline tried to read brokerages.logo_url and
--     silently got undefined — every AI-rendered marketing image shipped
--     WITHOUT a logo and WITHOUT a license #.
--   * listing_media had no way to record whether the asset had been
--     overlaid with attribution. Compliance gate had no signal to enforce.
--   * compliance_manager and compliance_officer are aliased in the role
--     canonicalization map, but the on-disk user_type column distinguishes
--     both. The onboarding curriculum only targeted compliance_officer, so
--     users literally stored as compliance_manager got the agent curriculum
--     (the same bug 1083 fixed for other roles).
--
-- This migration:
--   1) Adds logo_url, license_number, license_state, dba to brokerages.
--   2) Back-fills logo_url from global_settings.app_logo_url where the
--      onboarding brand flow already captured one.
--   3) Adds has_logo_overlay, has_brokerage_attribution, has_eho_mark to
--      listing_media so the compliance gate can verify each public asset.
--   4) Updates compliance onboarding steps to target both role values.
--
-- APPLIED VIA: supabase apply_migration "brokerage_advertising_compliance_columns"
-- ===========================================================================

ALTER TABLE public.brokerages
  ADD COLUMN IF NOT EXISTS logo_url       text,
  ADD COLUMN IF NOT EXISTS license_number text,
  ADD COLUMN IF NOT EXISTS license_state  text,
  ADD COLUMN IF NOT EXISTS dba            text;

UPDATE public.brokerages b
SET    logo_url = gs.app_logo_url
FROM   public.global_settings gs
WHERE  gs.brokerage_id = b.id
  AND  gs.app_logo_url IS NOT NULL
  AND  b.logo_url IS NULL;

ALTER TABLE public.listing_media
  ADD COLUMN IF NOT EXISTS has_logo_overlay          boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_brokerage_attribution boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS has_eho_mark              boolean DEFAULT false;

UPDATE public.onboarding_steps
SET    target_role = ARRAY['compliance_officer','compliance_manager']::text[],
       updated_at = now()
WHERE  brokerage_id IS NULL
  AND  target_role = ARRAY['compliance_officer']::text[];
