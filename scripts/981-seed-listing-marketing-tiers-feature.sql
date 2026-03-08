-- ============================================
-- Layer 9.10 — Seed listing_marketing_tiers Feature Flag
-- ============================================
-- This script seeds the feature_flags table with the listing_marketing_tiers feature.
-- Tier access levels define how many tiers can be created per brokerage.
-- ============================================

-- 1. Insert the feature flag
INSERT INTO feature_flags (
  id,
  feature_key,
  display_name,
  description,
  category,
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
  created_at,
  updated_at
)
VALUES (
  gen_random_uuid(),
  'listing_marketing_tiers',
  'Listing Marketing Tiers',
  'Price-based marketing tier system for listings. Automatically assigns marketing budgets and required distributions based on listing price ranges.',
  'marketing',
  true,
  false,   -- solo agents cannot access (requires brokerage-level config)
  true,    -- teams can access
  true,    -- brokerages can access
  true,    -- multi-location can access
  0,       -- solo agent limit (N/A)
  5,       -- team limit: 5 tiers
  10,      -- brokerage limit: 10 tiers
  25,      -- multi-location limit: 25 tiers
  false,   -- not superadmin only
  false,   -- not beta
  false,   -- not deprecated
  NOW(),
  NOW()
)
ON CONFLICT (feature_key) DO UPDATE SET
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
  updated_at = NOW();

-- 2. Insert notification rules for LISTING_TIER_ASSIGNED event (per-brokerage)
-- This inserts rules for all existing brokerages
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
  'Listing Tier Assigned Notification',
  'listing_tier_assigned',
  'in_app',
  'agent',
  true,
  NOW(),
  NOW()
FROM brokerages b
WHERE NOT EXISTS (
  SELECT 1 FROM notification_rules nr
  WHERE nr.trigger_event = 'listing_tier_assigned'
    AND nr.brokerage_id = b.id
    AND nr.recipient_role = 'agent'
);

-- 3. Also notify broker/admin when tier is assigned (per-brokerage)
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
  'Listing Tier Assigned - Broker Notification',
  'listing_tier_assigned',
  'in_app',
  'broker',
  true,
  NOW(),
  NOW()
FROM brokerages b
WHERE NOT EXISTS (
  SELECT 1 FROM notification_rules nr
  WHERE nr.trigger_event = 'listing_tier_assigned'
    AND nr.recipient_role = 'broker'
    AND nr.brokerage_id = b.id
);

-- 4. Add marketing_tier_id column to listings if it doesn't exist
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'listings'
      AND column_name = 'marketing_tier_id'
  ) THEN
    ALTER TABLE public.listings
    ADD COLUMN marketing_tier_id UUID REFERENCES listing_marketing_tiers(id);
  END IF;
END $$;

-- 5. Create index for efficient tier lookups
CREATE INDEX IF NOT EXISTS idx_listings_marketing_tier_id
ON listings(marketing_tier_id)
WHERE marketing_tier_id IS NOT NULL;

-- 6. Create index for tier price range queries
CREATE INDEX IF NOT EXISTS idx_listing_marketing_tiers_price_range
ON listing_marketing_tiers(brokerage_id, min_price, max_price)
WHERE is_active = true;
