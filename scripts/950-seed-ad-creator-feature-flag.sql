-- scripts/950-seed-ad-creator-feature-flag.sql
-- Layer 9.5 — Ad Creator Feature Flag
-- Seeds the ad_creator feature flag for tier-based access control

INSERT INTO feature_flags (
  feature_key,
  display_name,
  description,
  category,
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
  deprecated
) VALUES (
  'ad_creator',
  'Ad Creator',
  'Create and manage ad campaigns with AI-generated creatives for Facebook, Instagram, Google, LinkedIn, and TikTok',
  'marketing',
  true,
  false,
  true,   -- solo agents can access
  true,   -- teams can access
  true,   -- brokerages can access
  true,   -- multi-location can access
  3,      -- solo agent: 3 campaigns per month
  15,     -- team: 15 campaigns per month
  50,     -- brokerage: 50 campaigns per month
  200,    -- multi-location: 200 campaigns per month
  false,
  false
)
ON CONFLICT (feature_key)
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  enabled = EXCLUDED.enabled,
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
SELECT feature_key, display_name, enabled, solo_agent_limit, team_limit, brokerage_limit
FROM feature_flags
WHERE feature_key = 'ad_creator';
