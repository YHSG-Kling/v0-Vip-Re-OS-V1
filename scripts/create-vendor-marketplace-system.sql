-- VENDOR MARKETPLACE SYSTEM (System 1.6)
-- Creates tables for vendor pay-plans, subscriptions, billing, and access control

-- Note: The existing 'public.vendors' table is a simple directory (name, email, phone).
-- We'll create new marketplace-specific tables with a different structure for the pay-plan system.

-- Table 1: Vendor Marketplace Profiles (extends existing vendors concept for marketplace)
CREATE TABLE IF NOT EXISTS public.vendor_marketplace_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL UNIQUE,
  description TEXT,
  category TEXT NOT NULL CHECK (category IN ('api', 'service', 'tool', 'integration')),
  website TEXT,
  logo_url TEXT,
  api_endpoint TEXT,
  api_key_encrypted TEXT,
  
  -- Revenue sharing
  default_revenue_share_percent NUMERIC DEFAULT 20 CHECK (default_revenue_share_percent BETWEEN 0 AND 100),
  support_email TEXT,
  support_phone TEXT,
  
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'suspended', 'inactive')),
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_marketplace_user ON public.vendor_marketplace_profiles(user_id);
CREATE INDEX IF NOT EXISTS idx_vendor_marketplace_status ON public.vendor_marketplace_profiles(status);
CREATE INDEX IF NOT EXISTS idx_vendor_marketplace_category ON public.vendor_marketplace_profiles(category);

-- Table 2: Vendor Plans
CREATE TABLE IF NOT EXISTS public.vendor_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID NOT NULL REFERENCES public.vendor_marketplace_profiles(id) ON DELETE CASCADE,
  
  name TEXT NOT NULL,
  description TEXT,
  
  -- Pricing
  price_per_month NUMERIC NOT NULL CHECK (price_per_month >= 0),
  price_per_credit NUMERIC CHECK (price_per_credit >= 0),
  max_credits_per_month INTEGER CHECK (max_credits_per_month IS NULL OR max_credits_per_month > 0),
  
  -- Features
  features_json JSONB DEFAULT '[]'::jsonb,
  
  -- Billing
  billing_cycle TEXT DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'annual')),
  trial_days INTEGER DEFAULT 0 CHECK (trial_days >= 0),
  
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  
  is_default BOOLEAN DEFAULT FALSE,
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_plans_vendor ON public.vendor_plans(vendor_id);
CREATE INDEX IF NOT EXISTS idx_plans_status ON public.vendor_plans(status);

-- Table 3: Vendor Subscriptions
CREATE TABLE IF NOT EXISTS public.vendor_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES public.vendor_marketplace_profiles(id) ON DELETE CASCADE,
  plan_id UUID NOT NULL REFERENCES public.vendor_plans(id) ON DELETE RESTRICT,
  
  -- Subscription status
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'canceled')),
  
  -- Billing dates
  current_period_start TIMESTAMPTZ NOT NULL,
  current_period_end TIMESTAMPTZ NOT NULL,
  canceled_at TIMESTAMPTZ,
  
  -- Stripe integration
  stripe_subscription_id TEXT,
  stripe_customer_id TEXT,
  
  -- Usage tracking
  credits_used_this_period INTEGER DEFAULT 0 CHECK (credits_used_this_period >= 0),
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  
  UNIQUE(brokerage_id, vendor_id, plan_id)
);

CREATE INDEX IF NOT EXISTS idx_subscriptions_brokerage ON public.vendor_subscriptions(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_vendor ON public.vendor_subscriptions(vendor_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_status ON public.vendor_subscriptions(status);
CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe ON public.vendor_subscriptions(stripe_subscription_id);

-- Table 4: Vendor Transactions
CREATE TABLE IF NOT EXISTS public.vendor_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES public.vendor_marketplace_profiles(id) ON DELETE CASCADE,
  subscription_id UUID REFERENCES public.vendor_subscriptions(id) ON DELETE SET NULL,
  
  -- Transaction details
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('charge', 'refund', 'payout', 'credit_usage')),
  amount NUMERIC NOT NULL CHECK (amount >= 0),
  credits_used INTEGER CHECK (credits_used IS NULL OR credits_used >= 0),
  
  description TEXT,
  
  -- Stripe integration
  stripe_charge_id TEXT,
  stripe_invoice_id TEXT,
  
  status TEXT DEFAULT 'completed' CHECK (status IN ('pending', 'completed', 'failed')),
  
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_transactions_brokerage ON public.vendor_transactions(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_transactions_vendor ON public.vendor_transactions(vendor_id);
CREATE INDEX IF NOT EXISTS idx_transactions_type ON public.vendor_transactions(transaction_type);
CREATE INDEX IF NOT EXISTS idx_transactions_created ON public.vendor_transactions(created_at DESC);

-- Table 5: Vendor Access Logs
CREATE TABLE IF NOT EXISTS public.vendor_access_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  vendor_id UUID NOT NULL REFERENCES public.vendor_marketplace_profiles(id) ON DELETE CASCADE,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  
  action TEXT NOT NULL,
  resource TEXT,
  details JSONB,
  
  ip_address TEXT,
  user_agent TEXT,
  
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_access_logs_brokerage ON public.vendor_access_logs(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_access_logs_vendor ON public.vendor_access_logs(vendor_id);
CREATE INDEX IF NOT EXISTS idx_access_logs_created ON public.vendor_access_logs(created_at DESC);

-- Enable RLS on all tables
ALTER TABLE public.vendor_marketplace_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.vendor_access_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policies for vendor_marketplace_profiles
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'vendor_marketplace_profiles' AND policyname = 'Admins can manage vendor profiles'
  ) THEN
    CREATE POLICY "Admins can manage vendor profiles"
      ON public.vendor_marketplace_profiles
      FOR ALL
      USING (
        EXISTS (
          SELECT 1 FROM users WHERE id = auth.uid() AND user_type IN ('admin', 'broker')
        )
      );
  END IF;
END $$;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'vendor_marketplace_profiles' AND policyname = 'Vendors can view their own profile'
  ) THEN
    CREATE POLICY "Vendors can view their own profile"
      ON public.vendor_marketplace_profiles
      FOR SELECT
      USING (user_id = auth.uid());
  END IF;
END $$;

-- RLS Policies for vendor_plans
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'vendor_plans' AND policyname = 'Everyone can view active plans'
  ) THEN
    CREATE POLICY "Everyone can view active plans"
      ON public.vendor_plans
      FOR SELECT
      USING (status = 'active');
  END IF;
END $$;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'vendor_plans' AND policyname = 'Admins can manage plans'
  ) THEN
    CREATE POLICY "Admins can manage plans"
      ON public.vendor_plans
      FOR ALL
      USING (
        EXISTS (
          SELECT 1 FROM users WHERE id = auth.uid() AND user_type IN ('admin', 'broker')
        )
      );
  END IF;
END $$;

-- RLS Policies for vendor_subscriptions
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'vendor_subscriptions' AND policyname = 'Brokerages can view their subscriptions'
  ) THEN
    CREATE POLICY "Brokerages can view their subscriptions"
      ON public.vendor_subscriptions
      FOR SELECT
      USING (
        brokerage_id IN (
          SELECT CAST(brokerage_id AS uuid) FROM users WHERE id = auth.uid()
        )
        OR
        EXISTS (
          SELECT 1 FROM users WHERE id = auth.uid() AND user_type IN ('admin', 'broker')
        )
      );
  END IF;
END $$;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'vendor_subscriptions' AND policyname = 'Admins can manage all subscriptions'
  ) THEN
    CREATE POLICY "Admins can manage all subscriptions"
      ON public.vendor_subscriptions
      FOR ALL
      USING (
        EXISTS (
          SELECT 1 FROM users WHERE id = auth.uid() AND user_type IN ('admin', 'broker')
        )
      );
  END IF;
END $$;

-- RLS Policies for vendor_transactions
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'vendor_transactions' AND policyname = 'Brokerages can view their transactions'
  ) THEN
    CREATE POLICY "Brokerages can view their transactions"
      ON public.vendor_transactions
      FOR SELECT
      USING (
        brokerage_id IN (
          SELECT CAST(brokerage_id AS uuid) FROM users WHERE id = auth.uid()
        )
        OR
        EXISTS (
          SELECT 1 FROM users WHERE id = auth.uid() AND user_type IN ('admin', 'broker')
        )
      );
  END IF;
END $$;

-- RLS Policies for vendor_access_logs
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'vendor_access_logs' AND policyname = 'Admins can view access logs'
  ) THEN
    CREATE POLICY "Admins can view access logs"
      ON public.vendor_access_logs
      FOR SELECT
      USING (
        EXISTS (
          SELECT 1 FROM users WHERE id = auth.uid() AND user_type IN ('admin', 'broker')
        )
      );
  END IF;
END $$;

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_vendor_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Triggers for updated_at
DROP TRIGGER IF EXISTS update_vendor_marketplace_profiles_updated_at ON public.vendor_marketplace_profiles;
CREATE TRIGGER update_vendor_marketplace_profiles_updated_at
  BEFORE UPDATE ON public.vendor_marketplace_profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_vendor_updated_at();

DROP TRIGGER IF EXISTS update_vendor_plans_updated_at ON public.vendor_plans;
CREATE TRIGGER update_vendor_plans_updated_at
  BEFORE UPDATE ON public.vendor_plans
  FOR EACH ROW
  EXECUTE FUNCTION update_vendor_updated_at();

DROP TRIGGER IF EXISTS update_vendor_subscriptions_updated_at ON public.vendor_subscriptions;
CREATE TRIGGER update_vendor_subscriptions_updated_at
  BEFORE UPDATE ON public.vendor_subscriptions
  FOR EACH ROW
  EXECUTE FUNCTION update_vendor_updated_at();
