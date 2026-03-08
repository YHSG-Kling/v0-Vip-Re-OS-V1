-- Layer 9.12: Campaign ROI Dashboard Feature Flag
-- Seeds the campaign_roi_dashboard feature with tier-based limits

-- 1. Insert or update the campaign_roi_dashboard feature flag
INSERT INTO feature_flags (
  id,
  feature_key,
  display_name,
  description,
  category,
  solo_agent_limit,
  team_limit,
  brokerage_limit,
  multi_location_limit,
  enabled,
  beta,
  superadmin_only,
  solo_agent_access,
  team_access,
  brokerage_access,
  multi_location_access,
  created_at,
  updated_at
)
VALUES (
  gen_random_uuid(),
  'campaign_roi_dashboard',
  'Campaign ROI Dashboard',
  'Layer 9.12: Track and analyze marketing campaign ROI with aggregated performance metrics',
  'analytics',
  5,    -- Solo agents: 5 campaigns tracked
  20,   -- Teams: 20 campaigns tracked
  100,  -- Brokerages: 100 campaigns tracked
  500,  -- Multi-location: 500 campaigns tracked
  true,
  false,
  false,
  true,
  true,
  true,
  true,
  NOW(),
  NOW()
)
ON CONFLICT (feature_key) DO UPDATE
SET
  display_name = 'Campaign ROI Dashboard',
  description = 'Layer 9.12: Track and analyze marketing campaign ROI with aggregated performance metrics',
  category = 'analytics',
  solo_agent_limit = 5,
  team_limit = 20,
  brokerage_limit = 100,
  multi_location_limit = 500,
  enabled = true,
  updated_at = NOW();

-- 2. Create indexes on campaign_roi for performance
CREATE INDEX IF NOT EXISTS idx_campaign_roi_brokerage_id
ON campaign_roi(brokerage_id);

CREATE INDEX IF NOT EXISTS idx_campaign_roi_marketing_campaign_id
ON campaign_roi(marketing_campaign_id);

CREATE INDEX IF NOT EXISTS idx_campaign_roi_roi_percentage
ON campaign_roi(roi_percentage DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_campaign_roi_calculated_at
ON campaign_roi(calculated_at DESC);

-- 3. Create indexes on channel_performance for performance
CREATE INDEX IF NOT EXISTS idx_channel_performance_brokerage_id
ON channel_performance(brokerage_id);

CREATE INDEX IF NOT EXISTS idx_channel_performance_channel_type
ON channel_performance(channel_type);

CREATE INDEX IF NOT EXISTS idx_channel_performance_window
ON channel_performance(window_start, window_end);

CREATE INDEX IF NOT EXISTS idx_channel_performance_roi_percentage
ON channel_performance(roi_percentage DESC NULLS LAST);

-- Final: Log that campaign_roi_dashboard has been seeded
SELECT 'campaign_roi_dashboard feature flag seeded successfully' AS status;
