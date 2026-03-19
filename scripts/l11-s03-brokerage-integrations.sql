-- ============================================================
-- SYSTEM: L11-S03 — Tech Stack Setup Migration
-- VIP Real Estate AI OS — Layer 11
-- ============================================================
-- Creates brokerage_integrations table and feature flag for integration_setup

-- 1. Create brokerage_integrations table (tracks status per provider)
CREATE TABLE IF NOT EXISTS brokerage_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  provider_type TEXT NOT NULL, -- 'sms', 'email', 'esign', 'video', 'crm', 'calendar', 'accounting', 'mls', 'direct_mail', 'leads'
  provider_name TEXT NOT NULL, -- 'twilio', 'sendgrid', 'docusign', etc.
  status TEXT NOT NULL DEFAULT 'not_configured' CHECK (status IN ('connected', 'error', 'not_configured')),
  last_health_check_at TIMESTAMPTZ,
  last_error TEXT,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(brokerage_id, provider_name)
);

-- 2. Create index for fast lookups
CREATE INDEX IF NOT EXISTS idx_brokerage_integrations_brokerage 
ON brokerage_integrations(brokerage_id);

CREATE INDEX IF NOT EXISTS idx_brokerage_integrations_status 
ON brokerage_integrations(brokerage_id, status);

-- 3. Enable RLS
ALTER TABLE brokerage_integrations ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policy: Users can only see their brokerage's integrations
CREATE POLICY brokerage_integrations_policy ON brokerage_integrations
  FOR ALL
  USING (
    brokerage_id IN (
      SELECT brokerage_id FROM users WHERE id = auth.uid()
    )
  );

-- 5. Insert feature flag for integration_setup
INSERT INTO feature_flags (
  feature_key,
  display_name,
  description,
  category,
  enabled,
  solo_agent_access,
  team_access,
  brokerage_access,
  superadmin_only,
  created_at,
  updated_at
) VALUES (
  'integration_setup',
  'Integration Setup',
  'Allows agents to configure third-party integrations during onboarding',
  'onboarding',
  true,
  true,
  true,
  true,
  false,
  NOW(),
  NOW()
) ON CONFLICT (feature_key) DO NOTHING;

-- 6. Add last_tested_at and test_status to platform_credentials if missing
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'platform_credentials' AND column_name = 'last_tested_at'
  ) THEN
    ALTER TABLE platform_credentials ADD COLUMN last_tested_at TIMESTAMPTZ;
  END IF;
  
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns 
    WHERE table_name = 'platform_credentials' AND column_name = 'test_status'
  ) THEN
    ALTER TABLE platform_credentials ADD COLUMN test_status TEXT CHECK (test_status IN ('pass', 'fail', 'pending'));
  END IF;
END $$;
