-- ============================================================
-- L11-S02: Brand Setup Wizard Tables
-- VIP Real Estate AI OS — Layer 11
-- ============================================================

-- Table: brokerage_brand_settings
-- Stores wizard progress and extended brand configuration
CREATE TABLE IF NOT EXISTS brokerage_brand_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  tagline TEXT,
  website_url TEXT,
  facebook_url TEXT,
  instagram_url TEXT,
  linkedin_url TEXT,
  email_signature_html TEXT,
  letterhead_html TEXT,
  accent_color TEXT,
  heading_size TEXT DEFAULT 'medium',
  body_text_size TEXT DEFAULT 'medium',
  wizard_step_reached INTEGER DEFAULT 1,
  wizard_completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(brokerage_id)
);

-- Table: brand_templates
-- Stores email signatures, letterheads, and other reusable brand templates
CREATE TABLE IF NOT EXISTS brand_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  template_name TEXT NOT NULL,
  template_type TEXT NOT NULL CHECK (template_type IN ('email_signature', 'letterhead', 'business_card', 'custom')),
  content_html TEXT,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE brokerage_brand_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_templates ENABLE ROW LEVEL SECURITY;

-- RLS Policies for brokerage_brand_settings
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'brok_brand_settings_all' AND tablename = 'brokerage_brand_settings'
  ) THEN
    CREATE POLICY brok_brand_settings_all ON brokerage_brand_settings
      FOR ALL
      USING (
        brokerage_id IN (
          SELECT brokerage_id FROM users WHERE id = auth.uid()
        )
      )
      WITH CHECK (
        brokerage_id IN (
          SELECT brokerage_id FROM users WHERE id = auth.uid()
        )
      );
  END IF;
END $$;

-- RLS Policies for brand_templates
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'brok_brand_templates_all' AND tablename = 'brand_templates'
  ) THEN
    CREATE POLICY brok_brand_templates_all ON brand_templates
      FOR ALL
      USING (
        brokerage_id IN (
          SELECT brokerage_id FROM users WHERE id = auth.uid()
        )
      )
      WITH CHECK (
        brokerage_id IN (
          SELECT brokerage_id FROM users WHERE id = auth.uid()
        )
      );
  END IF;
END $$;

-- Insert brand_setup feature flag if not exists
INSERT INTO feature_flags (
  feature_key,
  display_name,
  description,
  category,
  enabled,
  solo_agent_access,
  team_access,
  brokerage_access,
  multi_location_access
)
SELECT
  'brand_setup',
  'Brand Setup Wizard',
  'Access to the brand setup wizard for configuring colors, fonts, voice, and templates',
  'onboarding',
  TRUE,
  TRUE,
  TRUE,
  TRUE,
  TRUE
WHERE NOT EXISTS (
  SELECT 1 FROM feature_flags WHERE feature_key = 'brand_setup'
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_brokerage_brand_settings_brokerage ON brokerage_brand_settings(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_brand_templates_brokerage ON brand_templates(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_brand_templates_type ON brand_templates(brokerage_id, template_type);
