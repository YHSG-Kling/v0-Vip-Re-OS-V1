-- ===========================================================================
-- 1089-brokerages-recruiting-pitch-fields.sql
--
-- Public-facing recruiting funnel at /recruiting/[brokerageSlug]. Brokerages
-- get four optional fields they can fill in to customise the page without
-- us needing a separate per-brokerage table.
--
--   recruiting_pitch          short tagline shown in the hero
--   recruiting_split_to_agent agent's commission % (e.g., 80 = 80/20)
--                             used by the ROI calculator on the page
--   recruiting_monthly_fee    flat monthly tech/desk fee in dollars
--   recruiting_value_props    jsonb array of 3-6 selling-point bullets
--
-- Recruits coming in through the public form are tagged via the existing
-- referral_source text column with one of:
--   public_landing   agent visited /recruiting/[slug] directly
--   agent_referral   came in via /recruiting/[slug]?ref=<agentId>
--                    (recruiter_agent_id is also stamped for attribution)
--   admin_entered    broker / admin added them via /admin/recruiting-hub
--   import           legacy CSV import
--
-- APPLIED VIA: supabase apply_migration "brokerages_recruiting_pitch_fields"
-- ===========================================================================

ALTER TABLE public.brokerages
  ADD COLUMN IF NOT EXISTS recruiting_pitch          text,
  ADD COLUMN IF NOT EXISTS recruiting_split_to_agent numeric,
  ADD COLUMN IF NOT EXISTS recruiting_monthly_fee    numeric,
  ADD COLUMN IF NOT EXISTS recruiting_value_props    jsonb DEFAULT '[]'::jsonb;

COMMENT ON COLUMN public.recruits.referral_source IS
  'How the recruit entered the funnel — values: ''public_landing'', ''agent_referral'', ''admin_entered'', ''import''';
