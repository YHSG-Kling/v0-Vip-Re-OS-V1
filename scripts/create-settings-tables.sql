-- Create global settings management tables for VIP Real Estate OS
-- Purpose: Store brokerage-wide settings including branding, commissions, templates, and integrations

-- 1. Global Settings Table
CREATE TABLE IF NOT EXISTS global_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id uuid NOT NULL REFERENCES brokerages(id),
  
  -- App Configuration
  app_name text NOT NULL DEFAULT 'VIP Real Estate OS',
  app_logo_url text,
  primary_color text NOT NULL DEFAULT '#2563eb',
  secondary_color text NOT NULL DEFAULT '#1e40af',
  font_family text NOT NULL DEFAULT 'system-ui',
  
  -- Regional Settings
  fiscal_year_start integer NOT NULL DEFAULT 1 CHECK (fiscal_year_start BETWEEN 1 AND 12),
  timezone text NOT NULL DEFAULT 'America/New_York',
  date_format text NOT NULL DEFAULT 'MM/DD/YYYY' CHECK (date_format IN ('MM/DD/YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD')),
  currency_symbol text NOT NULL DEFAULT '$',
  
  -- Email Configuration
  smtp_host text,
  smtp_port integer,
  smtp_username text,
  smtp_password text,
  from_email text,
  from_name text,
  
  -- Notification Toggles
  email_notifications_enabled boolean NOT NULL DEFAULT true,
  sms_notifications_enabled boolean NOT NULL DEFAULT false,
  push_notifications_enabled boolean NOT NULL DEFAULT false,
  
  -- API Keys (stored here, use integration_credentials for full details)
  ghl_api_key text,
  zapier_api_key text,
  airtable_api_key text,
  
  -- Additional flexible settings
  additional_settings jsonb DEFAULT '{}',
  
  -- Audit fields
  created_by_user_id uuid REFERENCES users(id),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- 2. Commission Structures Table
CREATE TABLE IF NOT EXISTS commission_structures (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id uuid NOT NULL REFERENCES brokerages(id),
  
  -- Structure details
  name text NOT NULL,
  description text,
  commission_type text NOT NULL CHECK (commission_type IN ('percentage', 'flat', 'tiered')),
  
  -- Base rates (for percentage and flat)
  base_percentage numeric(5,2) CHECK (base_percentage >= 0 AND base_percentage <= 100),
  base_amount numeric(12,2) CHECK (base_amount >= 0),
  
  -- Tiered rules (JSON array for tiered commissions)
  tier_rules jsonb, -- e.g., [{"threshold": 250000, "percentage": 3}, {"threshold": 500000, "percentage": 2.5}]
  
  -- Status
  is_active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false,
  
  -- Audit fields
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- 3. Email Templates Table
CREATE TABLE IF NOT EXISTS email_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id uuid NOT NULL REFERENCES brokerages(id),
  
  -- Template details
  name text NOT NULL,
  slug text NOT NULL, -- auto-generated from name
  subject text NOT NULL,
  body text NOT NULL,
  template_type text NOT NULL CHECK (template_type IN ('welcome', 'offer', 'closing', 'followup', 'reminder')),
  
  -- Variables support (extracted from body {{variable}})
  variables jsonb DEFAULT '[]',
  
  -- Status
  is_active boolean NOT NULL DEFAULT true,
  
  -- Audit fields
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  
  -- Unique constraint per brokerage
  UNIQUE(brokerage_id, slug)
);

-- 4. Notification Rules Table
CREATE TABLE IF NOT EXISTS notification_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id uuid NOT NULL REFERENCES brokerages(id),
  
  -- Rule details
  rule_name text NOT NULL,
  trigger_event text NOT NULL CHECK (trigger_event IN ('new_lead', 'offer_received', 'contract_signed', 'ready_to_close', 'task_assigned', 'showing_scheduled')),
  notification_type text NOT NULL CHECK (notification_type IN ('email', 'sms', 'push')),
  recipient_role text NOT NULL CHECK (recipient_role IN ('agent', 'broker', 'admin')),
  
  -- Status
  is_active boolean NOT NULL DEFAULT true,
  
  -- Audit fields
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- 5. Integration Credentials Table (encrypted storage)
CREATE TABLE IF NOT EXISTS integration_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id uuid NOT NULL REFERENCES brokerages(id),
  
  -- Provider details
  provider_name text NOT NULL, -- 'gohighlevel', 'zapier', 'airtable', etc.
  api_key text NOT NULL,
  api_secret text,
  webhook_url text,
  
  -- Status
  is_active boolean NOT NULL DEFAULT true,
  
  -- Audit fields
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  
  -- Unique constraint per brokerage per provider
  UNIQUE(brokerage_id, provider_name)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_global_settings_brokerage ON global_settings(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_commission_structures_brokerage ON commission_structures(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_commission_structures_active ON commission_structures(brokerage_id, is_active);
CREATE INDEX IF NOT EXISTS idx_email_templates_brokerage ON email_templates(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_email_templates_active ON email_templates(brokerage_id, is_active);
CREATE INDEX IF NOT EXISTS idx_notification_rules_brokerage ON notification_rules(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_notification_rules_active ON notification_rules(brokerage_id, is_active);
CREATE INDEX IF NOT EXISTS idx_integration_credentials_brokerage ON integration_credentials(brokerage_id);

-- Enable Row Level Security
ALTER TABLE global_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_structures ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_credentials ENABLE ROW LEVEL SECURITY;

-- RLS Policies: Admin-only access

-- Global Settings Policies
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'global_settings' AND policyname = 'Admins and brokers can view settings'
  ) THEN
    CREATE POLICY "Admins and brokers can view settings"
      ON global_settings
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM users 
          WHERE id = auth.uid() 
          AND user_type IN ('admin', 'broker')
        )
      );
  END IF;
END $$;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'global_settings' AND policyname = 'Admins can modify settings'
  ) THEN
    CREATE POLICY "Admins can modify settings"
      ON global_settings
      FOR ALL
      USING (
        EXISTS (
          SELECT 1 FROM users 
          WHERE id = auth.uid() 
          AND user_type = 'admin'
        )
      );
  END IF;
END $$;

-- Commission Structures Policies — DELIBERATELY NOT CREATED HERE.
--
-- This file used to create "Admins and brokers view commission structures"
-- (SELECT) and "Admins can manage commission structures" (FOR ALL). Both tested
-- only `user_type IN ('admin','broker')` with NO tenant term, so either one
-- handed every admin and broker on the platform every brokerage's split table —
-- and the FOR ALL one handed them UPDATE and DELETE on it too, because on a FOR
-- ALL policy USING alone governs DELETE. m438 drops them.
--
-- They are not replaced here. commission_structures' real policies are the
-- tenant-scoped commission_structures_tenant_{select,insert,update,delete} set
-- from m433, which lives in supabase/migrations/ where it can be reviewed and
-- ordered. Re-running this script must never re-open the hole, and a table left
-- with RLS on and no policy is fail-CLOSED, which is the safe direction for a
-- bootstrap that runs ahead of the migrations.

-- Email Templates Policies
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'email_templates' AND policyname = 'Admins and brokers view email templates'
  ) THEN
    CREATE POLICY "Admins and brokers view email templates"
      ON email_templates
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM users 
          WHERE id = auth.uid() 
          AND user_type IN ('admin', 'broker')
        )
      );
  END IF;
END $$;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'email_templates' AND policyname = 'Admins can manage email templates'
  ) THEN
    CREATE POLICY "Admins can manage email templates"
      ON email_templates
      FOR ALL
      USING (
        EXISTS (
          SELECT 1 FROM users 
          WHERE id = auth.uid() 
          AND user_type = 'admin'
        )
      );
  END IF;
END $$;

-- Notification Rules Policies
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'notification_rules' AND policyname = 'Admins and brokers view notification rules'
  ) THEN
    CREATE POLICY "Admins and brokers view notification rules"
      ON notification_rules
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM users 
          WHERE id = auth.uid() 
          AND user_type IN ('admin', 'broker')
        )
      );
  END IF;
END $$;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'notification_rules' AND policyname = 'Admins can manage notification rules'
  ) THEN
    CREATE POLICY "Admins can manage notification rules"
      ON notification_rules
      FOR ALL
      USING (
        EXISTS (
          SELECT 1 FROM users 
          WHERE id = auth.uid() 
          AND user_type = 'admin'
        )
      );
  END IF;
END $$;

-- Integration Credentials Policies
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'integration_credentials' AND policyname = 'Admins view integration credentials'
  ) THEN
    CREATE POLICY "Admins view integration credentials"
      ON integration_credentials
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM users 
          WHERE id = auth.uid() 
          AND user_type = 'admin'
        )
      );
  END IF;
END $$;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'integration_credentials' AND policyname = 'Admins can manage integration credentials'
  ) THEN
    CREATE POLICY "Admins can manage integration credentials"
      ON integration_credentials
      FOR ALL
      USING (
        EXISTS (
          SELECT 1 FROM users 
          WHERE id = auth.uid() 
          AND user_type = 'admin'
        )
      );
  END IF;
END $$;
