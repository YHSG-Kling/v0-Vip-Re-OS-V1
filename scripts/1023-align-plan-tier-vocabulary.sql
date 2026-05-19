-- Migration 1023: Align brokerages.plan_tier + plan_limits.plan_tier vocabulary
-- with the canonical subscription_tiers.tier_name values.
--
-- Old values: starter | professional | team | enterprise
-- New values: solo_agent | team | brokerage | multi_location
--
-- Mapping:
--   starter      → solo_agent      (1 agent)
--   professional → team            (small team — consolidates with existing 'team')
--   team         → brokerage       (was middle-tier; becomes single-brokerage)
--   enterprise   → multi_location  (multi-brokerage)
--
-- Note: 'team' exists in BOTH old and new vocabularies but means different
-- things (old: middle tier; new: small team). Two-pass rename via temporary
-- placeholders avoids constraint conflicts mid-migration.
--
-- Applied to live Supabase 2026-05-08.

ALTER TABLE public.brokerages   DROP CONSTRAINT IF EXISTS brokerages_plan_tier_check;
ALTER TABLE public.plan_limits  DROP CONSTRAINT IF EXISTS plan_limits_plan_tier_check;

UPDATE public.brokerages SET plan_tier = '__starter_tmp__'      WHERE plan_tier = 'starter';
UPDATE public.brokerages SET plan_tier = '__professional_tmp__' WHERE plan_tier = 'professional';
UPDATE public.brokerages SET plan_tier = '__team_old_tmp__'     WHERE plan_tier = 'team';
UPDATE public.brokerages SET plan_tier = '__enterprise_tmp__'   WHERE plan_tier = 'enterprise';

UPDATE public.plan_limits SET plan_tier = '__starter_tmp__'      WHERE plan_tier = 'starter';
UPDATE public.plan_limits SET plan_tier = '__professional_tmp__' WHERE plan_tier = 'professional';
UPDATE public.plan_limits SET plan_tier = '__team_old_tmp__'     WHERE plan_tier = 'team';
UPDATE public.plan_limits SET plan_tier = '__enterprise_tmp__'   WHERE plan_tier = 'enterprise';

UPDATE public.brokerages SET plan_tier = 'solo_agent'     WHERE plan_tier = '__starter_tmp__';
UPDATE public.brokerages SET plan_tier = 'team'           WHERE plan_tier = '__professional_tmp__';
UPDATE public.brokerages SET plan_tier = 'brokerage'      WHERE plan_tier = '__team_old_tmp__';
UPDATE public.brokerages SET plan_tier = 'multi_location' WHERE plan_tier = '__enterprise_tmp__';

UPDATE public.plan_limits SET plan_tier = 'solo_agent'     WHERE plan_tier = '__starter_tmp__';
UPDATE public.plan_limits SET plan_tier = 'team'           WHERE plan_tier = '__professional_tmp__';
UPDATE public.plan_limits SET plan_tier = 'brokerage'      WHERE plan_tier = '__team_old_tmp__';
UPDATE public.plan_limits SET plan_tier = 'multi_location' WHERE plan_tier = '__enterprise_tmp__';

ALTER TABLE public.brokerages
  ADD CONSTRAINT brokerages_plan_tier_check
  CHECK (plan_tier IN ('solo_agent','team','brokerage','multi_location'));

ALTER TABLE public.plan_limits
  ADD CONSTRAINT plan_limits_plan_tier_check
  CHECK (plan_tier IN ('solo_agent','team','brokerage','multi_location'));

ALTER TABLE public.brokerages ALTER COLUMN plan_tier SET DEFAULT 'solo_agent';
