-- scripts/984-seed-marketing-studio-feature-flag.sql
-- Layer 9.1 Marketing Studio Dashboard — Feature Flag Seeding
-- Adds the 'marketing_studio' feature key to feature_flags table

INSERT INTO feature_flags (
  feature_key,
  display_name,
  description,
  category,
  solo_agent_access,
  team_access,
  brokerage_access,
  multi_location_access,
  solo_agent_limit,
  team_limit,
  brokerage_limit,
  multi_location_limit,
  enabled,
  beta,
  superadmin_only,
  created_at,
  updated_at
) VALUES (
  'marketing_studio',
  'Marketing Studio',
  'Unified marketing dashboard for campaigns, assets, calendar, and content management with AI-powered generation',
  'marketing',
  true,
  true,
  true,
  true,
  null,   -- Solo agent: unlimited access
  null,   -- Team: unlimited access
  null,   -- Brokerage: unlimited access
  null,   -- Multi-location: unlimited access
  true,
  false,
  false,
  now(),
  now()
)
ON CONFLICT (feature_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  solo_agent_access = EXCLUDED.solo_agent_access,
  team_access = EXCLUDED.team_access,
  brokerage_access = EXCLUDED.brokerage_access,
  multi_location_access = EXCLUDED.multi_location_access,
  solo_agent_limit = EXCLUDED.solo_agent_limit,
  team_limit = EXCLUDED.team_limit,
  brokerage_limit = EXCLUDED.brokerage_limit,
  multi_location_limit = EXCLUDED.multi_location_limit,
  updated_at = now();

-- Verify insertion
SELECT feature_key, display_name, category, enabled, solo_agent_access, team_access, brokerage_access 
FROM feature_flags 
WHERE feature_key = 'marketing_studio';
