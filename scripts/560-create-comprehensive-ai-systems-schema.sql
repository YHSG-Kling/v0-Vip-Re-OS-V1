-- ============================================
-- COMPREHENSIVE AI SYSTEMS SCHEMA
-- Supports all AI-powered features
-- ============================================

-- Transaction Coordinator Tables
CREATE TABLE IF NOT EXISTS transaction_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
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
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES auth.users(id),
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
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  closing_date DATE,
  readiness_score INTEGER,
  checklist JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Referrals Table (create if not exists)
CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES auth.users(id),
  referrer_contact_id UUID REFERENCES contacts(id),
  referred_contact_id UUID REFERENCES contacts(id),
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

-- Referral Management Tables
CREATE TABLE IF NOT EXISTS referral_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES auth.users(id),
  channel TEXT NOT NULL,
  message_content TEXT,
  ai_generated BOOLEAN DEFAULT false,
  sent_at TIMESTAMPTZ,
  response TEXT,
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add referral columns to contacts if not exists
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contacts' AND column_name = 'referral_score') THEN
    ALTER TABLE contacts ADD COLUMN referral_score INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contacts' AND column_name = 'referral_approach') THEN
    ALTER TABLE contacts ADD COLUMN referral_approach TEXT;
  END IF;
END $$;

-- Calendar & Scheduling Tables
CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES auth.users(id),
  contact_id UUID REFERENCES contacts(id),
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
  agent_id UUID REFERENCES auth.users(id),
  schedule_date DATE NOT NULL,
  optimized_schedule JSONB,
  productivity_score INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id, schedule_date)
);

CREATE TABLE IF NOT EXISTS scheduled_touchpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES auth.users(id),
  touchpoint_type TEXT NOT NULL,
  scheduled_date TIMESTAMPTZ NOT NULL,
  purpose TEXT,
  talking_points JSONB,
  priority TEXT DEFAULT 'medium',
  ai_generated BOOLEAN DEFAULT false,
  status TEXT DEFAULT 'scheduled',
  completed_at TIMESTAMPTZ,
  outcome TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS meeting_briefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES auth.users(id),
  brief_content JSONB NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(appointment_id)
);

CREATE TABLE IF NOT EXISTS weekly_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES auth.users(id),
  week_start DATE NOT NULL,
  plan_content JSONB NOT NULL,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id, week_start)
);

-- Agent Goals Table
CREATE TABLE IF NOT EXISTS agent_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES auth.users(id),
  goal_type TEXT NOT NULL,
  period TEXT NOT NULL, -- 'daily', 'weekly', 'monthly', 'quarterly', 'yearly'
  target_value NUMERIC NOT NULL,
  current_value NUMERIC DEFAULT 0,
  start_date DATE,
  end_date DATE,
  status TEXT DEFAULT 'active',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Showing Management Tables
CREATE TABLE IF NOT EXISTS showing_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES auth.users(id),
  contact_id UUID REFERENCES contacts(id),
  route_date DATE NOT NULL,
  total_showings INTEGER DEFAULT 0,
  optimized_order JSONB,
  total_travel_time INTEGER,
  total_distance NUMERIC,
  ai_optimized BOOLEAN DEFAULT false,
  status TEXT DEFAULT 'planned',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS showing_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  showing_id UUID,
  contact_id UUID REFERENCES contacts(id),
  listing_id UUID,
  rating INTEGER,
  interest_level TEXT,
  feedback_text TEXT,
  ai_analysis JSONB,
  ai_interest_score INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Newsletter Tables
CREATE TABLE IF NOT EXISTS newsletters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES auth.users(id),
  title TEXT NOT NULL,
  subject_line TEXT,
  content JSONB,
  html_content TEXT,
  audience_segment TEXT,
  ai_generated BOOLEAN DEFAULT false,
  ai_quality_score INTEGER,
  status TEXT DEFAULT 'draft',
  scheduled_send_date TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS newsletter_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  newsletter_id UUID REFERENCES newsletters(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id),
  sent_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  unsubscribed BOOLEAN DEFAULT false,
  bounce_type TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Direct Mail Tables
CREATE TABLE IF NOT EXISTS direct_mail_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES auth.users(id),
  campaign_name TEXT NOT NULL,
  campaign_type TEXT NOT NULL,
  target_area JSONB,
  target_criteria JSONB,
  mail_piece_type TEXT,
  content JSONB,
  ai_generated BOOLEAN DEFAULT false,
  estimated_recipients INTEGER,
  cost_per_piece NUMERIC,
  total_cost NUMERIC,
  print_vendor TEXT,
  status TEXT DEFAULT 'draft',
  mail_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS direct_mail_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID REFERENCES direct_mail_campaigns(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id),
  address TEXT NOT NULL,
  personalization JSONB,
  mail_status TEXT DEFAULT 'pending',
  delivered_at TIMESTAMPTZ,
  response_type TEXT,
  response_date TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Financial Management Tables
CREATE TABLE IF NOT EXISTS expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES auth.users(id),
  category TEXT NOT NULL,
  description TEXT,
  amount NUMERIC NOT NULL,
  expense_date DATE NOT NULL,
  vendor TEXT,
  receipt_url TEXT,
  tax_deductible BOOLEAN DEFAULT false,
  ai_categorized BOOLEAN DEFAULT false,
  quickbooks_synced BOOLEAN DEFAULT false,
  quickbooks_id TEXT,
  transaction_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commission_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES auth.users(id),
  transaction_id UUID REFERENCES transactions(id),
  gross_commission NUMERIC NOT NULL,
  split_percentage NUMERIC,
  brokerage_amount NUMERIC,
  agent_amount NUMERIC,
  cap_contribution NUMERIC,
  referral_fee NUMERIC,
  net_commission NUMERIC,
  payment_date DATE,
  quickbooks_synced BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES auth.users(id),
  transaction_id UUID REFERENCES transactions(id),
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
  agent_id UUID REFERENCES auth.users(id),
  contact_id UUID REFERENCES contacts(id),
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
  agent_id UUID REFERENCES auth.users(id),
  contact_id UUID REFERENCES contacts(id),
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

-- Add AI columns to transactions if not exists
DO $$ 
BEGIN
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
END $$;

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_transaction_tasks_transaction ON transaction_tasks(transaction_id);
CREATE INDEX IF NOT EXISTS idx_transaction_tasks_status ON transaction_tasks(status);
CREATE INDEX IF NOT EXISTS idx_appointments_agent_date ON appointments(agent_id, start_time);
CREATE INDEX IF NOT EXISTS idx_scheduled_touchpoints_agent ON scheduled_touchpoints(agent_id, scheduled_date);
CREATE INDEX IF NOT EXISTS idx_newsletters_agent ON newsletters(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_expenses_agent_date ON expenses(agent_id, expense_date);
CREATE INDEX IF NOT EXISTS idx_commission_records_agent ON commission_records(agent_id);
CREATE INDEX IF NOT EXISTS idx_showing_routes_agent_date ON showing_routes(agent_id, route_date);

-- RLS Policies (only enable if tables have agent_id)
DO $$
BEGIN
  -- Enable RLS on tables that have agent_id
  ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
  ALTER TABLE scheduled_touchpoints ENABLE ROW LEVEL SECURITY;
  ALTER TABLE newsletters ENABLE ROW LEVEL SECURITY;
  ALTER TABLE direct_mail_campaigns ENABLE ROW LEVEL SECURITY;
  ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
  ALTER TABLE commission_records ENABLE ROW LEVEL SECURITY;
  ALTER TABLE listing_intake_sessions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE offer_sessions ENABLE ROW LEVEL SECURITY;
  ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'Some RLS enabling failed - tables may already have RLS';
END $$;

-- Create policies (simplified - agent can see their own data)
DROP POLICY IF EXISTS appointments_agent_policy ON appointments;
CREATE POLICY appointments_agent_policy ON appointments FOR ALL USING (agent_id = auth.uid());

DROP POLICY IF EXISTS scheduled_touchpoints_agent_policy ON scheduled_touchpoints;
CREATE POLICY scheduled_touchpoints_agent_policy ON scheduled_touchpoints FOR ALL USING (agent_id = auth.uid());

DROP POLICY IF EXISTS newsletters_agent_policy ON newsletters;
CREATE POLICY newsletters_agent_policy ON newsletters FOR ALL USING (agent_id = auth.uid());

DROP POLICY IF EXISTS direct_mail_agent_policy ON direct_mail_campaigns;
CREATE POLICY direct_mail_agent_policy ON direct_mail_campaigns FOR ALL USING (agent_id = auth.uid());

DROP POLICY IF EXISTS expenses_agent_policy ON expenses;
CREATE POLICY expenses_agent_policy ON expenses FOR ALL USING (agent_id = auth.uid());

DROP POLICY IF EXISTS commission_records_agent_policy ON commission_records;
CREATE POLICY commission_records_agent_policy ON commission_records FOR ALL USING (agent_id = auth.uid());

DROP POLICY IF EXISTS listing_intake_agent_policy ON listing_intake_sessions;
CREATE POLICY listing_intake_agent_policy ON listing_intake_sessions FOR ALL USING (agent_id = auth.uid());

DROP POLICY IF EXISTS offer_sessions_agent_policy ON offer_sessions;
CREATE POLICY offer_sessions_agent_policy ON offer_sessions FOR ALL USING (agent_id = auth.uid());

DROP POLICY IF EXISTS referrals_agent_policy ON referrals;
CREATE POLICY referrals_agent_policy ON referrals FOR ALL USING (agent_id = auth.uid());
