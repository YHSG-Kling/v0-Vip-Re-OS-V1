-- ═══════════════════════════════════════════════════════════════════════════════
-- LAYER 9.7 — NEWSLETTER ENGINE FEATURE FLAG
-- Seeds the feature_flags table with newsletter_engine access control
-- ═══════════════════════════════════════════════════════════════════════════════

-- Insert newsletter_engine feature flag
INSERT INTO feature_flags (
  feature_key,
  display_name,
  description,
  category,
  enabled,
  solo_agent_access,
  solo_agent_limit,
  team_access,
  team_limit,
  brokerage_access,
  brokerage_limit,
  multi_location_access,
  multi_location_limit
)
VALUES (
  'newsletter_engine',
  'Newsletter Engine',
  'AI-powered newsletter creation with subject line generation, content writing, send time optimization, and personalization. Includes subscriber management and performance analytics.',
  'marketing',
  true,
  true,
  5,
  true,
  20,
  true,
  100,
  true,
  500
)
ON CONFLICT (feature_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  enabled = EXCLUDED.enabled,
  solo_agent_access = EXCLUDED.solo_agent_access,
  solo_agent_limit = EXCLUDED.solo_agent_limit,
  team_access = EXCLUDED.team_access,
  team_limit = EXCLUDED.team_limit,
  brokerage_access = EXCLUDED.brokerage_access,
  brokerage_limit = EXCLUDED.brokerage_limit,
  multi_location_access = EXCLUDED.multi_location_access,
  multi_location_limit = EXCLUDED.multi_location_limit,
  updated_at = NOW();

-- Verify insertion
SELECT 
  feature_key,
  display_name,
  category,
  enabled,
  solo_agent_access,
  solo_agent_limit,
  team_limit,
  brokerage_limit,
  multi_location_limit
FROM feature_flags
WHERE feature_key = 'newsletter_engine';
