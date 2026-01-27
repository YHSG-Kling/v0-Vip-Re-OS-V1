-- ============================================
-- COMPREHENSIVE AI SYSTEMS SCHEMA (SAFE VERSION)
-- Creates tables only, no RLS until verified
-- ============================================

-- Referrals Table
CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  referrer_contact_id UUID,
  referred_contact_id UUID,
  referral_type TEXT DEFAULT 'client',
  referral_source TEXT,
  status TEXT DEFAULT 'pending',
  commission_amount NUMERIC,
  commission_paid BOOLEAN DEFAULT false,
  notes TEXT,
  ai_conversion_probability NUMERIC,
  ai_next_action TEXT,
  ai_nurture_strategy JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Transaction Coordinator Tables
CREATE TABLE IF NOT EXISTS transaction_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID,
  agent_id UUID,
  title TEXT NOT NULL,
  description TEXT,
  priority TEXT DEFAULT 'medium',
  category TEXT,
  due_date DATE,
  assigned_to TEXT,
  ai_generated BOOLEAN DEFAULT false,
  automatable BOOLEAN DEFAULT false,
  status TEXT DEFAULT 'pending',
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transaction_communications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID,
  agent_id UUID,
  recipient_role TEXT NOT NULL,
  communication_type TEXT NOT NULL,
  ai_draft TEXT,
  final_content TEXT,
  sent_at TIMESTAMPTZ,
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS transaction_closing_prep (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID,
  agent_id UUID,
  closing_date DATE,
  readiness_score INTEGER,
  checklist JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Referral Request Table
CREATE TABLE IF NOT EXISTS referral_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID,
  agent_id UUID,
  channel TEXT NOT NULL,
  message_content TEXT,
  ai_generated BOOLEAN DEFAULT false,
  sent_at TIMESTAMPTZ,
  response TEXT,
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Calendar & Scheduling Tables
CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  contact_id UUID,
  listing_id UUID,
  title TEXT NOT NULL,
  appointment_type TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  location TEXT,
  notes TEXT,
  status TEXT DEFAULT 'scheduled',
  reminder_sent BOOLEAN DEFAULT false,
  ai_scheduled BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS daily_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  schedule_date DATE NOT NULL,
  ai_optimized BOOLEAN DEFAULT false,
  productivity_score INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS scheduled_touchpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  contact_id UUID,
  touchpoint_type TEXT NOT NULL,
  scheduled_date DATE NOT NULL,
  ai_content TEXT,
  channel TEXT,
  status TEXT DEFAULT 'pending',
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS meeting_briefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID,
  agent_id UUID,
  contact_id UUID,
  brief_content JSONB,
  talking_points JSONB,
  questions_to_ask JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS weekly_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  week_start DATE NOT NULL,
  priorities JSONB,
  goals JSONB,
  ai_suggestions JSONB,
  review_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agent_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  goal_type TEXT NOT NULL,
  target_value NUMERIC,
  current_value NUMERIC DEFAULT 0,
  period TEXT NOT NULL,
  period_start DATE,
  period_end DATE,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Showing Management Tables
CREATE TABLE IF NOT EXISTS showing_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  contact_id UUID,
  route_date DATE NOT NULL,
  property_ids JSONB,
  optimized_order JSONB,
  total_drive_time INTEGER,
  total_distance NUMERIC,
  ai_optimized BOOLEAN DEFAULT false,
  status TEXT DEFAULT 'planned',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS showing_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  showing_route_id UUID,
  property_id UUID,
  agent_id UUID,
  contact_id UUID,
  rating INTEGER,
  feedback_text TEXT,
  ai_interest_score INTEGER,
  ai_analysis JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Newsletter Tables
CREATE TABLE IF NOT EXISTS newsletters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  title TEXT NOT NULL,
  subject_line TEXT,
  content JSONB,
  ai_generated BOOLEAN DEFAULT false,
  target_segments JSONB,
  scheduled_for TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  status TEXT DEFAULT 'draft',
  open_rate NUMERIC,
  click_rate NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS newsletter_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  newsletter_id UUID,
  contact_id UUID,
  sent_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ
);

-- Direct Mail Tables
CREATE TABLE IF NOT EXISTS direct_mail_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  campaign_name TEXT NOT NULL,
  campaign_type TEXT NOT NULL,
  target_area JSONB,
  content JSONB,
  ai_generated BOOLEAN DEFAULT false,
  print_vendor TEXT,
  cost_per_piece NUMERIC,
  total_pieces INTEGER,
  total_cost NUMERIC,
  scheduled_mail_date DATE,
  status TEXT DEFAULT 'draft',
  response_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS direct_mail_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID,
  contact_id UUID,
  address TEXT,
  personalized_content JSONB,
  sent_at TIMESTAMPTZ,
  response_type TEXT,
  response_date DATE
);

-- Financial Management Tables
CREATE TABLE IF NOT EXISTS expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  category TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  description TEXT,
  vendor TEXT,
  expense_date DATE NOT NULL,
  receipt_url TEXT,
  ai_categorized BOOLEAN DEFAULT false,
  tax_deductible BOOLEAN DEFAULT true,
  quickbooks_synced BOOLEAN DEFAULT false,
  quickbooks_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commission_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  transaction_id UUID,
  gross_commission NUMERIC NOT NULL,
  split_percentage NUMERIC,
  brokerage_fee NUMERIC,
  franchise_fee NUMERIC,
  cap_contribution NUMERIC,
  net_commission NUMERIC,
  paid_date DATE,
  quickbooks_synced BOOLEAN DEFAULT false,
  quickbooks_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  transaction_id UUID,
  deposit_type TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  deposit_date DATE NOT NULL,
  held_by TEXT,
  status TEXT DEFAULT 'pending',
  released_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Listing Intake Tables
CREATE TABLE IF NOT EXISTS listing_intake_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  contact_id UUID,
  property_address TEXT,
  state TEXT,
  intake_data JSONB,
  ai_recommendations JSONB,
  required_forms JSONB,
  dotloop_loop_id TEXT,
  compliance_status TEXT DEFAULT 'pending',
  status TEXT DEFAULT 'in_progress',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Offer Creation Tables
CREATE TABLE IF NOT EXISTS offer_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  contact_id UUID,
  property_address TEXT,
  listing_price NUMERIC,
  offer_price NUMERIC,
  state TEXT,
  ai_strategy JSONB,
  required_forms JSONB,
  dotloop_loop_id TEXT,
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_transaction_tasks_transaction ON transaction_tasks(transaction_id);
CREATE INDEX IF NOT EXISTS idx_transaction_tasks_agent ON transaction_tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_transaction_tasks_status ON transaction_tasks(status);
CREATE INDEX IF NOT EXISTS idx_appointments_agent_date ON appointments(agent_id, start_time);
CREATE INDEX IF NOT EXISTS idx_scheduled_touchpoints_agent ON scheduled_touchpoints(agent_id, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_newsletters_agent ON newsletters(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_expenses_agent_date ON expenses(agent_id, expense_date);
CREATE INDEX IF NOT EXISTS idx_commission_records_agent ON commission_records(agent_id);
CREATE INDEX IF NOT EXISTS idx_showing_routes_agent_date ON showing_routes(agent_id, route_date);
CREATE INDEX IF NOT EXISTS idx_referrals_agent ON referrals(agent_id);
CREATE INDEX IF NOT EXISTS idx_listing_intake_agent ON listing_intake_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_offer_sessions_agent ON offer_sessions(agent_id);

-- Add AI columns to transactions if the table exists
DO $$ 
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'transactions') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'ai_risk_level') THEN
      ALTER TABLE transactions ADD COLUMN ai_risk_level TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'ai_primary_risk') THEN
      ALTER TABLE transactions ADD COLUMN ai_primary_risk TEXT;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'ai_analysis') THEN
      ALTER TABLE transactions ADD COLUMN ai_analysis JSONB;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'last_ai_analysis') THEN
      ALTER TABLE transactions ADD COLUMN last_ai_analysis TIMESTAMPTZ;
    END IF;
  END IF;
END $$;

-- Add referral columns to contacts if the table exists
DO $$ 
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'contacts') THEN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contacts' AND column_name = 'referral_score') THEN
      ALTER TABLE contacts ADD COLUMN referral_score INTEGER;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contacts' AND column_name = 'referral_approach') THEN
      ALTER TABLE contacts ADD COLUMN referral_approach TEXT;
    END IF;
  END IF;
END $$;
