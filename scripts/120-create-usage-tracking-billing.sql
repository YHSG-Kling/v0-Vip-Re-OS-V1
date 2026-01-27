-- =====================================================
-- USAGE TRACKING & BILLING SYSTEM MIGRATION
-- =====================================================
-- This migration adds monetization infrastructure:
-- 1. Plan tier and billing metadata to brokerages
-- 2. Usage counters table for tracking resource consumption
-- 3. Plan limits configuration
-- =====================================================

-- =====================================================
-- STEP 1: EXTEND BROKERAGES TABLE
-- =====================================================

-- Add plan_tier and billing_metadata to brokerages
ALTER TABLE brokerages 
ADD COLUMN IF NOT EXISTS plan_tier TEXT DEFAULT 'starter' 
  CHECK (plan_tier IN ('starter', 'professional', 'team', 'enterprise'));

ALTER TABLE brokerages 
ADD COLUMN IF NOT EXISTS billing_metadata JSONB DEFAULT '{
  "stripe_customer_id": null,
  "stripe_subscription_id": null,
  "billing_email": null,
  "billing_cycle": "monthly",
  "trial_ends_at": null,
  "subscription_status": "active"
}'::jsonb;

-- =====================================================
-- STEP 2: CREATE USAGE COUNTERS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS usage_counters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  period_start TIMESTAMP NOT NULL,
  period_end TIMESTAMP NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN (
    'llm_calls',
    'video_minutes',
    'active_users',
    'contacts_count',
    'active_transactions',
    'sms_sent',
    'emails_sent',
    'storage_gb'
  )),
  value INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  UNIQUE(brokerage_id, period_start, period_end, metric)
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_usage_counters_brokerage_id ON usage_counters(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_usage_counters_period ON usage_counters(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_usage_counters_metric ON usage_counters(metric);
CREATE INDEX IF NOT EXISTS idx_usage_counters_lookup ON usage_counters(brokerage_id, metric, period_start, period_end);

-- =====================================================
-- STEP 3: CREATE PLAN LIMITS TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS plan_limits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_tier TEXT NOT NULL CHECK (plan_tier IN ('starter', 'professional', 'team', 'enterprise')),
  metric TEXT NOT NULL CHECK (metric IN (
    'llm_calls',
    'video_minutes',
    'active_users',
    'contacts_count',
    'active_transactions',
    'sms_sent',
    'emails_sent',
    'storage_gb'
  )),
  limit_value INTEGER NOT NULL, -- -1 means unlimited
  soft_limit_threshold DECIMAL(3,2) DEFAULT 0.80, -- Warn at 80%
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  UNIQUE(plan_tier, metric)
);

-- =====================================================
-- STEP 4: SEED PLAN LIMITS
-- =====================================================

-- Starter Plan (Free/Low Tier)
INSERT INTO plan_limits (plan_tier, metric, limit_value) VALUES
  ('starter', 'llm_calls', 1000),
  ('starter', 'video_minutes', 30),
  ('starter', 'active_users', 3),
  ('starter', 'contacts_count', 500),
  ('starter', 'active_transactions', 10),
  ('starter', 'sms_sent', 100),
  ('starter', 'emails_sent', 500),
  ('starter', 'storage_gb', 5)
ON CONFLICT (plan_tier, metric) DO NOTHING;

-- Professional Plan
INSERT INTO plan_limits (plan_tier, metric, limit_value) VALUES
  ('professional', 'llm_calls', 5000),
  ('professional', 'video_minutes', 150),
  ('professional', 'active_users', 10),
  ('professional', 'contacts_count', 2000),
  ('professional', 'active_transactions', 50),
  ('professional', 'sms_sent', 1000),
  ('professional', 'emails_sent', 5000),
  ('professional', 'storage_gb', 50)
ON CONFLICT (plan_tier, metric) DO NOTHING;

-- Team Plan
INSERT INTO plan_limits (plan_tier, metric, limit_value) VALUES
  ('team', 'llm_calls', 50000),
  ('team', 'video_minutes', 300),
  ('team', 'active_users', 50),
  ('team', 'contacts_count', 25000),
  ('team', 'active_transactions', 100),
  ('team', 'sms_sent', 5000),
  ('team', 'emails_sent', 25000),
  ('team', 'storage_gb', 250)
ON CONFLICT (plan_tier, metric) DO NOTHING;

-- Enterprise Plan (Unlimited)
INSERT INTO plan_limits (plan_tier, metric, limit_value) VALUES
  ('enterprise', 'llm_calls', 999999),
  ('enterprise', 'video_minutes', 999999),
  ('enterprise', 'active_users', 999999),
  ('enterprise', 'contacts_count', 999999),
  ('enterprise', 'active_transactions', 999999),
  ('enterprise', 'sms_sent', 999999),
  ('enterprise', 'emails_sent', 999999),
  ('enterprise', 'storage_gb', 999999)
ON CONFLICT (plan_tier, metric) DO NOTHING;

-- =====================================================
-- STEP 5: ADD RLS POLICIES
-- =====================================================

ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE plan_limits ENABLE ROW LEVEL SECURITY;

-- Brokers/admins can view their brokerage's usage
CREATE POLICY usage_counters_select_policy ON usage_counters
  FOR SELECT
  USING (
    brokerage_id IN (SELECT auth.user_brokerage_ids())
  );

-- System can insert/update usage (for server actions)
CREATE POLICY usage_counters_insert_policy ON usage_counters
  FOR INSERT
  WITH CHECK (true);

CREATE POLICY usage_counters_update_policy ON usage_counters
  FOR UPDATE
  USING (true);

-- Plan limits are readable by all authenticated users
CREATE POLICY plan_limits_select_policy ON plan_limits
  FOR SELECT
  TO authenticated
  USING (true);

-- =====================================================
-- STEP 6: ADD TRIGGERS
-- =====================================================

CREATE OR REPLACE FUNCTION update_usage_counters_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_usage_counters_updated_at
  BEFORE UPDATE ON usage_counters
  FOR EACH ROW
  EXECUTE FUNCTION update_usage_counters_updated_at();
