-- 009-marketing-studio-feature-flag.sql
-- Layer 9.1 Marketing Studio Dashboard feature flag

INSERT INTO feature_flags (
  id,
  feature_key,
  display_name,
  description,
  enabled,
  superadmin_only,
  solo_agent_access,
  team_access,
  brokerage_access,
  multi_location_access,
  solo_agent_limit,
  team_limit,
  brokerage_limit,
  multi_location_limit,
  beta,
  deprecated,
  category,
  created_at,
  updated_at
) VALUES (
  gen_random_uuid(),
  'marketing_studio',
  'Marketing Studio',
  'Unified marketing command center for campaigns, assets, calendar scheduling, and content registry. Layer 9.1 feature.',
  true,
  false,
  true,
  true,
  true,
  true,
  5,       -- solo_agent_limit: 5 campaigns
  20,      -- team_limit: 20 campaigns
  100,     -- brokerage_limit: 100 campaigns  
  null,    -- multi_location_limit: unlimited
  false,   -- not beta
  false,   -- not deprecated
  'marketing',
  now(),
  now()
)
ON CONFLICT (feature_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  enabled = EXCLUDED.enabled,
  solo_agent_limit = EXCLUDED.solo_agent_limit,
  team_limit = EXCLUDED.team_limit,
  brokerage_limit = EXCLUDED.brokerage_limit,
  category = EXCLUDED.category,
  updated_at = now();
