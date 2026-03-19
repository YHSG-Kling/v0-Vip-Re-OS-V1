-- ============================================================
-- SYSTEM: L11-S01 — Agent Onboarding Feature Flag Seed
-- VIP Real Estate AI OS — Layer 11
-- ============================================================
-- Seeds the agent_onboarding feature flag into feature_flags table.
-- Idempotent — safe to run multiple times.

INSERT INTO feature_flags (
  feature_key,
  display_name,
  description,
  category,
  enabled,
  solo_agent_access,
  team_access,
  brokerage_access,
  multi_location_access,
  superadmin_only,
  beta,
  deprecated,
  created_at,
  updated_at
) VALUES (
  'agent_onboarding',
  'Agent Onboarding',
  'Layer 11 Agent Onboarding & Education system including license intake, contract signing, compliance checklist, brand setup, and training modules.',
  'onboarding',
  true,
  true,
  true,
  true,
  true,
  false,
  false,
  false,
  NOW(),
  NOW()
)
ON CONFLICT (feature_key) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  enabled = EXCLUDED.enabled,
  updated_at = NOW();

-- Seed default onboarding steps if they don't exist (using DO block for idempotency)
DO $$
BEGIN
  -- license_upload
  IF NOT EXISTS (SELECT 1 FROM onboarding_steps WHERE step_key = 'license_upload' AND brokerage_id IS NULL) THEN
    INSERT INTO onboarding_steps (brokerage_id, step_key, step_name, category, required, day_number, step_order, estimated_minutes, instructions, created_at, updated_at)
    VALUES (NULL, 'license_upload', 'License Upload', 'compliance', true, 1, 1, 10, 'Upload your real estate license for verification.', NOW(), NOW());
  END IF;

  -- eo_insurance
  IF NOT EXISTS (SELECT 1 FROM onboarding_steps WHERE step_key = 'eo_insurance' AND brokerage_id IS NULL) THEN
    INSERT INTO onboarding_steps (brokerage_id, step_key, step_name, category, required, day_number, step_order, estimated_minutes, instructions, created_at, updated_at)
    VALUES (NULL, 'eo_insurance', 'E&O Insurance', 'compliance', true, 1, 2, 5, 'Provide your Errors & Omissions insurance information.', NOW(), NOW());
  END IF;

  -- contract_signed
  IF NOT EXISTS (SELECT 1 FROM onboarding_steps WHERE step_key = 'contract_signed' AND brokerage_id IS NULL) THEN
    INSERT INTO onboarding_steps (brokerage_id, step_key, step_name, category, required, day_number, step_order, estimated_minutes, instructions, created_at, updated_at)
    VALUES (NULL, 'contract_signed', 'Sign ICA', 'compliance', true, 1, 3, 15, 'Review and sign your Independent Contractor Agreement.', NOW(), NOW());
  END IF;

  -- fair_housing_ack
  IF NOT EXISTS (SELECT 1 FROM onboarding_steps WHERE step_key = 'fair_housing_ack' AND brokerage_id IS NULL) THEN
    INSERT INTO onboarding_steps (brokerage_id, step_key, step_name, category, required, day_number, step_order, estimated_minutes, instructions, created_at, updated_at)
    VALUES (NULL, 'fair_housing_ack', 'Fair Housing Acknowledgment', 'compliance', true, 1, 4, 5, 'I acknowledge that I have read and understand the Fair Housing Act and agree to comply with all fair housing laws.', NOW(), NOW());
  END IF;

  -- tcpa_ack
  IF NOT EXISTS (SELECT 1 FROM onboarding_steps WHERE step_key = 'tcpa_ack' AND brokerage_id IS NULL) THEN
    INSERT INTO onboarding_steps (brokerage_id, step_key, step_name, category, required, day_number, step_order, estimated_minutes, instructions, created_at, updated_at)
    VALUES (NULL, 'tcpa_ack', 'TCPA Compliance', 'compliance', true, 1, 5, 5, 'I acknowledge that I have read and understand the Telephone Consumer Protection Act and agree to obtain proper consent before sending marketing messages.', NOW(), NOW());
  END IF;

  -- mls_rules_ack
  IF NOT EXISTS (SELECT 1 FROM onboarding_steps WHERE step_key = 'mls_rules_ack' AND brokerage_id IS NULL) THEN
    INSERT INTO onboarding_steps (brokerage_id, step_key, step_name, category, required, day_number, step_order, estimated_minutes, instructions, created_at, updated_at)
    VALUES (NULL, 'mls_rules_ack', 'MLS Rules & Regulations', 'compliance', true, 1, 6, 5, 'I acknowledge that I have read and understand the MLS rules and regulations and agree to comply with all MLS policies.', NOW(), NOW());
  END IF;

  -- brand_standards_ack
  IF NOT EXISTS (SELECT 1 FROM onboarding_steps WHERE step_key = 'brand_standards_ack' AND brokerage_id IS NULL) THEN
    INSERT INTO onboarding_steps (brokerage_id, step_key, step_name, category, required, day_number, step_order, estimated_minutes, instructions, created_at, updated_at)
    VALUES (NULL, 'brand_standards_ack', 'Brand Standards', 'compliance', true, 1, 7, 5, 'I acknowledge that I have read and understand the brokerage brand standards and agree to represent the brand professionally.', NOW(), NOW());
  END IF;
END $$;
