-- Layer 9.11: Omnipresence Repurposer Feature Flag
-- Seeds the omnipresence_repurposer feature with tier-based limits and notification rules

-- 1. Insert or update the omnipresence_repurposer feature flag with tier limits
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
  'omnipresence_repurposer',
  'Omnipresence Repurposer',
  'Layer 9.11: Multi-channel content distribution with AI optimization',
  'content_distribution',
  2,
  8,
  25,
  250,
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
  solo_agent_limit = 2,
  team_limit = 8,
  brokerage_limit = 25,
  multi_location_limit = 250,
  enabled = true,
  updated_at = NOW();

-- 2. Create indexes on repurpose_pipelines for performance
CREATE INDEX IF NOT EXISTS idx_repurpose_pipelines_brokerage_id
ON repurpose_pipelines(brokerage_id);

CREATE INDEX IF NOT EXISTS idx_repurpose_pipelines_agent_user_id
ON repurpose_pipelines(agent_user_id);

CREATE INDEX IF NOT EXISTS idx_repurpose_pipelines_created_at
ON repurpose_pipelines(created_at DESC);

-- 3. Create indexes on repurposed_content_log for analytics
CREATE INDEX IF NOT EXISTS idx_repurposed_content_log_brokerage_id
ON repurposed_content_log(brokerage_id);

CREATE INDEX IF NOT EXISTS idx_repurposed_content_log_created_at
ON repurposed_content_log(created_at DESC);

-- 4. Create indexes on video_snippets for efficiency
CREATE INDEX IF NOT EXISTS idx_video_snippets_video_project_id
ON video_snippets(video_project_id);

-- Final: Log that omnipresence_repurposer has been seeded
SELECT 'omnipresence_repurposer feature flag seeded successfully' AS status;
