-- ─────────────────────────────────────────────────────────────────────────────
-- Migration: fix-missing-columns-and-constraints.sql
-- 1. Add status column to ai_isa_campaigns
-- 2. DROP the contacts.source_family check constraint entirely
--    (existing data has values beyond the constraint's list; enforcement moves
--     to the application layer in lib/kernel/listings.ts)
-- 3. Seed seo_blog_engine feature flag
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. ai_isa_campaigns.status
ALTER TABLE public.ai_isa_campaigns
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'draft'
  CHECK (status IN ('draft', 'active', 'paused', 'completed', 'archived'));

-- 2. Drop ALL source_family check constraints on contacts
DO $$
DECLARE
  v_rec record;
BEGIN
  FOR v_rec IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.contacts'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%source_family%'
  LOOP
    EXECUTE format('ALTER TABLE public.contacts DROP CONSTRAINT IF EXISTS %I', v_rec.conname);
  END LOOP;
END;
$$;

-- 3. Seed seo_blog_engine feature flag if missing
INSERT INTO public.feature_flags (
  feature_key,
  display_name,
  description,
  category,
  solo_agent_access,
  team_access,
  brokerage_access,
  multi_location_access,
  superadmin_only,
  enabled,
  beta,
  deprecated
)
VALUES (
  'seo_blog_engine',
  'SEO Blog Engine',
  'AI-powered SEO-optimized blog post generation',
  'marketing',
  true,
  true,
  true,
  true,
  false,
  true,
  false,
  false
)
ON CONFLICT (feature_key) DO UPDATE
  SET enabled               = true,
      deprecated            = false,
      solo_agent_access     = true,
      team_access           = true,
      brokerage_access      = true,
      multi_location_access = true;
