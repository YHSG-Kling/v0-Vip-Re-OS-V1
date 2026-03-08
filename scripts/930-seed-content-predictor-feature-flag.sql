-- ================================================================
-- scripts/930-seed-content-predictor-feature-flag.sql
-- Layer 9.3 Content Performance Predictor — Feature Flag Seed
-- ================================================================

-- IDEMPOTENT: Delete existing row and re-insert to ensure correct state
DELETE FROM feature_flags 
WHERE feature_key = 'content_performance_predictor';

-- Insert the content_performance_predictor feature flag
INSERT INTO feature_flags (
  id,
  feature_key,
  display_name,
  description,
  category,
  enabled,
  beta,
  deprecated,
  superadmin_only,
  solo_agent_access,
  team_access,
  brokerage_access,
  multi_location_access,
  solo_agent_limit,
  team_limit,
  brokerage_limit,
  multi_location_limit,
  created_at,
  updated_at
) VALUES (
  gen_random_uuid(),
  'content_performance_predictor',
  'Content Performance Predictor',
  'AI-powered prediction of marketing content performance before publishing. Advisory only — does not auto-publish.',
  'marketing',
  true,
  false,
  false,
  false,
  true,  -- solo_agent_access
  true,  -- team_access
  true,  -- brokerage_access
  true,  -- multi_location_access
  5,     -- solo_agent_limit: 5 predictions per month
  25,    -- team_limit: 25 predictions per month
  100,   -- brokerage_limit: 100 predictions per month
  500,   -- multi_location_limit: 500 predictions per month
  NOW(),
  NOW()
);

-- Verify insertion
SELECT 
  feature_key,
  display_name,
  enabled,
  solo_agent_limit,
  team_limit,
  brokerage_limit,
  multi_location_limit
FROM feature_flags 
WHERE feature_key = 'content_performance_predictor';
