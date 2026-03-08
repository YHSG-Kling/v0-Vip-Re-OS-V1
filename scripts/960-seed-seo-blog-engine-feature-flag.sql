-- ══════════════════════════════════════════════════════════════════════════════
-- Layer 9.6 SEO & Blog Engine Feature Flag
-- ══════════════════════════════════════════════════════════════════════════════

-- Insert seo_blog_engine feature flag with tier-based limits
INSERT INTO feature_flags (
  id,
  feature_key,
  display_name,
  description,
  category,
  enabled,
  solo_agent_access,
  team_access,
  brokerage_access,
  multi_location_access,
  solo_agent_limit,
  team_limit,
  brokerage_limit,
  multi_location_limit,
  superadmin_only,
  beta,
  deprecated,
  created_at,
  updated_at
) VALUES (
  gen_random_uuid(),
  'seo_blog_engine',
  'SEO & Blog Engine',
  'AI-powered blog post generation with SEO optimization, keyword management, and WordPress publishing integration',
  'marketing',
  true,
  true,
  true,
  true,
  true,
  5,      -- Solo agents: 5 blog posts per month
  20,     -- Teams: 20 blog posts per month
  50,     -- Brokerages: 50 blog posts per month
  100,    -- Multi-location: 100 blog posts per month
  false,
  false,
  false,
  now(),
  now()
)
ON CONFLICT (feature_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  enabled = EXCLUDED.enabled,
  solo_agent_limit = EXCLUDED.solo_agent_limit,
  team_limit = EXCLUDED.team_limit,
  brokerage_limit = EXCLUDED.brokerage_limit,
  multi_location_limit = EXCLUDED.multi_location_limit,
  updated_at = now();

-- Verify insertion
SELECT feature_key, display_name, solo_agent_limit, team_limit, brokerage_limit, multi_location_limit
FROM feature_flags
WHERE feature_key = 'seo_blog_engine';
