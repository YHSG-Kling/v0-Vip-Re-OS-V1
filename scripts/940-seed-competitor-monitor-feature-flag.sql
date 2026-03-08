-- Layer 9.4 — Seed competitor_monitor feature flag
-- This flag controls access to the Competitive Ad + Post Monitor

-- Check if the feature flag already exists
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM feature_flags WHERE feature_key = 'competitor_monitor'
  ) THEN
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
      'competitor_monitor',
      'Competitive Monitor',
      'Track competitor ads and posts, analyze trends, and get AI-powered recommendations. Includes ingest functions, AI insights generation, and trend alerts.',
      'marketing',
      true,
      false,
      false,
      false,
      true,
      true,
      true,
      true,
      5,    -- solo_agent_limit: 5 insights generations per month
      20,   -- team_limit: 20 insights generations per month
      50,   -- brokerage_limit: 50 insights generations per month
      100,  -- multi_location_limit: 100 insights generations per month
      NOW(),
      NOW()
    );

    RAISE NOTICE 'competitor_monitor feature flag seeded successfully';
  ELSE
    RAISE NOTICE 'competitor_monitor feature flag already exists, skipping';
  END IF;
END $$;
