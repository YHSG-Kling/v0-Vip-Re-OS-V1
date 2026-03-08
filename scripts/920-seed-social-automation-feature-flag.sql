-- scripts/920-seed-social-automation-feature-flag.sql
-- Layer 9.2 Social Media Automation — Feature Flag Seeding
-- Adds the 'social_automation' feature key to feature_flags table

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
  'social_automation',
  'Social Media Automation',
  'Schedule and publish posts to connected social media accounts with approval workflows and compliance checks',
  'marketing',
  true,
  true,
  true,
  true,
  10,   -- Solo agent: 10 scheduled posts per month
  50,   -- Team: 50 scheduled posts per month
  200,  -- Brokerage: 200 scheduled posts per month
  1000, -- Multi-location: 1000 scheduled posts per month
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
SELECT feature_key, display_name, category, solo_agent_limit, team_limit, brokerage_limit 
FROM feature_flags 
WHERE feature_key = 'social_automation';
