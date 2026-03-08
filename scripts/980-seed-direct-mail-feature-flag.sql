-- Layer 9.9 Direct Mail Engine: Feature Flag Seed
-- This script inserts the direct_mail feature flag to enable the feature gate.

-- Insert feature flag for direct_mail
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
  'direct_mail',
  'Direct Mail Campaigns',
  'Create and manage direct mail campaigns with recipient tracking, delivery status, and response analytics via Lob integration',
  true,                    -- enabled
  true,                    -- solo_agent_access
  true,                    -- team_access
  true,                    -- brokerage_access
  true,                    -- multi_location_access
  3,                       -- solo_agent_limit (3 campaigns/month)
  10,                      -- team_limit (10 campaigns/month)
  50,                      -- brokerage_limit (50 campaigns/month)
  200,                     -- multi_location_limit (200 campaigns/month)
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

-- Insert notification rules for direct mail events
-- DIRECT_MAIL_CAMPAIGN_CREATED
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
  'Direct Mail Campaign Created',
  'direct_mail_campaign_created',
  'in_app',
  'agent',
  true,
  now(),
  now()
FROM brokerages b
WHERE NOT EXISTS (
  SELECT 1 FROM notification_rules nr 
  WHERE nr.brokerage_id = b.id 
  AND nr.trigger_event = 'direct_mail_campaign_created'
);

-- DIRECT_MAIL_SENT
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
  'Direct Mail Sent',
  'direct_mail_sent',
  'in_app',
  'agent',
  true,
  now(),
  now()
FROM brokerages b
WHERE NOT EXISTS (
  SELECT 1 FROM notification_rules nr 
  WHERE nr.brokerage_id = b.id 
  AND nr.trigger_event = 'direct_mail_sent'
);

-- Also notify broker/admin when direct mail is sent (for cost tracking)
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
  'Direct Mail Sent (Admin)',
  'direct_mail_sent',
  'in_app',
  'admin',
  true,
  now(),
  now()
FROM brokerages b
WHERE NOT EXISTS (
  SELECT 1 FROM notification_rules nr 
  WHERE nr.brokerage_id = b.id 
  AND nr.trigger_event = 'direct_mail_sent'
  AND nr.recipient_role = 'admin'
);

-- Completed: Layer 9.9 Direct Mail feature flag and notification rules seeded.
