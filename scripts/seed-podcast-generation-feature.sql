-- Layer 9.8 Podcast Creation System: Feature Flag Seed
-- This script inserts the podcast_generation feature flag to enable the feature gate.

-- Insert feature flag for podcast_generation
INSERT INTO feature_flags (
  feature_key,
  display_name,
  description,
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
  category,
  created_at,
  updated_at
) VALUES (
  'podcast_generation',
  'AI Podcast Generation',
  'Automated podcast creation from keywords/scripts with voice synthesis and multi-channel distribution',
  true,                    -- enabled
  true,                    -- solo_agent_access
  true,                    -- team_access
  true,                    -- brokerage_access
  true,                    -- multi_location_access
  5,                       -- solo_agent_limit (5 episodes/month)
  20,                      -- team_limit (20 episodes/month)
  100,                     -- brokerage_limit (100 episodes/month)
  null,                    -- multi_location_limit (unlimited)
  false,                   -- superadmin_only
  false,                   -- beta
  false,                   -- deprecated
  'marketing',             -- category
  now(),
  now()
)
ON CONFLICT (feature_key) 
DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
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

-- Insert notification rules for podcast events
INSERT INTO notification_rules (
  id,
  brokerage_id,
  rule_name,
  trigger_event,
  notification_type,
  recipient_role,
  is_active,
  created_at,
  updated_at
) 
SELECT 
  gen_random_uuid(),
  b.id,
  'Podcast Episode Generated',
  'podcast_episode_generated',
  'in_app',
  'agent',
  true,
  now(),
  now()
FROM brokerages b
WHERE NOT EXISTS (
  SELECT 1 FROM notification_rules nr 
  WHERE nr.brokerage_id = b.id 
  AND nr.trigger_event = 'podcast_episode_generated'
);

INSERT INTO notification_rules (
  id,
  brokerage_id,
  rule_name,
  trigger_event,
  notification_type,
  recipient_role,
  is_active,
  created_at,
  updated_at
) 
SELECT 
  gen_random_uuid(),
  b.id,
  'Podcast Episode Distributed',
  'podcast_episode_distributed',
  'in_app',
  'agent',
  true,
  now(),
  now()
FROM brokerages b
WHERE NOT EXISTS (
  SELECT 1 FROM notification_rules nr 
  WHERE nr.brokerage_id = b.id 
  AND nr.trigger_event = 'podcast_episode_distributed'
);

INSERT INTO notification_rules (
  id,
  brokerage_id,
  rule_name,
  trigger_event,
  notification_type,
  recipient_role,
  is_active,
  created_at,
  updated_at
) 
SELECT 
  gen_random_uuid(),
  b.id,
  'Podcast Episode Failed',
  'podcast_episode_failed',
  'in_app',
  'agent',
  true,
  now(),
  now()
FROM brokerages b
WHERE NOT EXISTS (
  SELECT 1 FROM notification_rules nr 
  WHERE nr.brokerage_id = b.id 
  AND nr.trigger_event = 'podcast_episode_failed'
);

-- Seed default distribution channels for each brokerage
INSERT INTO podcast_distribution_channels (
  id,
  brokerage_id,
  channel_name,
  is_enabled,
  external_show_id,
  distribution_config,
  created_at,
  updated_at
)
SELECT 
  gen_random_uuid(),
  b.id,
  'spotify',
  false,
  null,
  '{"requires_approval": true}'::jsonb,
  now(),
  now()
FROM brokerages b
WHERE NOT EXISTS (
  SELECT 1 FROM podcast_distribution_channels pdc 
  WHERE pdc.brokerage_id = b.id 
  AND pdc.channel_name = 'spotify'
);

INSERT INTO podcast_distribution_channels (
  id,
  brokerage_id,
  channel_name,
  is_enabled,
  external_show_id,
  distribution_config,
  created_at,
  updated_at
)
SELECT 
  gen_random_uuid(),
  b.id,
  'apple',
  false,
  null,
  '{"requires_approval": true}'::jsonb,
  now(),
  now()
FROM brokerages b
WHERE NOT EXISTS (
  SELECT 1 FROM podcast_distribution_channels pdc 
  WHERE pdc.brokerage_id = b.id 
  AND pdc.channel_name = 'apple'
);

INSERT INTO podcast_distribution_channels (
  id,
  brokerage_id,
  channel_name,
  is_enabled,
  external_show_id,
  distribution_config,
  created_at,
  updated_at
)
SELECT 
  gen_random_uuid(),
  b.id,
  'youtube',
  false,
  null,
  '{"requires_approval": true}'::jsonb,
  now(),
  now()
FROM brokerages b
WHERE NOT EXISTS (
  SELECT 1 FROM podcast_distribution_channels pdc 
  WHERE pdc.brokerage_id = b.id 
  AND pdc.channel_name = 'youtube'
);

INSERT INTO podcast_distribution_channels (
  id,
  brokerage_id,
  channel_name,
  is_enabled,
  external_show_id,
  distribution_config,
  created_at,
  updated_at
)
SELECT 
  gen_random_uuid(),
  b.id,
  'rss',
  true,  -- RSS is enabled by default
  null,
  '{"auto_generate": true}'::jsonb,
  now(),
  now()
FROM brokerages b
WHERE NOT EXISTS (
  SELECT 1 FROM podcast_distribution_channels pdc 
  WHERE pdc.brokerage_id = b.id 
  AND pdc.channel_name = 'rss'
);

-- Completed: Layer 9.8 Podcast feature flag and supporting data seeded.
