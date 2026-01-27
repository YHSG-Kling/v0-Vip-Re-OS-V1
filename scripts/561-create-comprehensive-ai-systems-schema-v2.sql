-- =====================================================
-- COMPREHENSIVE AI SYSTEMS SCHEMA v2
-- Fixed version that creates missing tables first
-- =====================================================

-- =====================================================
-- 1. REFERRALS TABLE (if not exists)
-- =====================================================
CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  referrer_contact_id UUID REFERENCES contacts(id),
  referred_contact_id UUID REFERENCES contacts(id),
  referral_type TEXT DEFAULT 'client',
  status TEXT DEFAULT 'pending',
  referral_date TIMESTAMPTZ DEFAULT NOW(),
  notes TEXT,
  reward_type TEXT,
  reward_amount DECIMAL(10,2),
  reward_paid BOOLEAN DEFAULT FALSE,
  ai_quality_score INTEGER,
  ai_conversion_probability DECIMAL(5,2),
  ai_recommended_followup TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 2. TRANSACTION TASKS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS transaction_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  task_name TEXT NOT NULL,
  task_type TEXT NOT NULL,
  description TEXT,
  due_date TIMESTAMPTZ,
  status TEXT DEFAULT 'pending',
  priority TEXT DEFAULT 'medium',
  assigned_to UUID REFERENCES auth.users(id),
  ai_generated BOOLEAN DEFAULT FALSE,
  ai_priority_score INTEGER,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 3. TRANSACTION COMMUNICATIONS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS transaction_communications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id),
  communication_type TEXT NOT NULL,
  subject TEXT,
  content TEXT,
  ai_generated BOOLEAN DEFAULT FALSE,
  ai_tone TEXT,
  sent_at TIMESTAMPTZ,
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 4. CLOSING PREPARATION TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS transaction_closing_prep (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  closing_date DATE,
  closing_time TIME,
  location TEXT,
  title_company TEXT,
  escrow_officer TEXT,
  escrow_phone TEXT,
  escrow_email TEXT,
  documents_checklist JSONB DEFAULT '[]',
  utilities_transfer JSONB DEFAULT '{}',
  walkthrough_scheduled BOOLEAN DEFAULT FALSE,
  walkthrough_date TIMESTAMPTZ,
  ai_checklist_generated BOOLEAN DEFAULT FALSE,
  ai_risk_assessment JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 5. REFERRAL REQUESTS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS referral_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id),
  request_type TEXT NOT NULL,
  message TEXT,
  ai_generated_message TEXT,
  ai_personalization_score INTEGER,
  status TEXT DEFAULT 'pending',
  sent_at TIMESTAMPTZ,
  response TEXT,
  responded_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 6. APPOINTMENTS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS appointments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id),
  title TEXT NOT NULL,
  description TEXT,
  appointment_type TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  end_time TIMESTAMPTZ NOT NULL,
  location TEXT,
  virtual_link TEXT,
  status TEXT DEFAULT 'scheduled',
  ai_suggested BOOLEAN DEFAULT FALSE,
  ai_priority_score INTEGER,
  ai_prep_notes TEXT,
  google_calendar_id TEXT,
  reminder_sent BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 7. DAILY SCHEDULES TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS daily_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  schedule_date DATE NOT NULL,
  ai_generated BOOLEAN DEFAULT FALSE,
  schedule_items JSONB DEFAULT '[]',
  focus_areas JSONB DEFAULT '[]',
  energy_level TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id, schedule_date)
);

-- =====================================================
-- 8. SCHEDULED TOUCHPOINTS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS scheduled_touchpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  touchpoint_type TEXT NOT NULL,
  scheduled_date DATE NOT NULL,
  message_template TEXT,
  ai_personalized_message TEXT,
  status TEXT DEFAULT 'scheduled',
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 9. MEETING BRIEFS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS meeting_briefs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id UUID REFERENCES appointments(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id),
  brief_content JSONB NOT NULL,
  talking_points JSONB DEFAULT '[]',
  property_insights JSONB,
  market_data JSONB,
  ai_generated BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 10. WEEKLY PLANS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS weekly_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  week_start DATE NOT NULL,
  goals JSONB DEFAULT '[]',
  priorities JSONB DEFAULT '[]',
  time_blocks JSONB DEFAULT '[]',
  ai_suggestions JSONB DEFAULT '[]',
  review_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id, week_start)
);

-- =====================================================
-- 11. AGENT GOALS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS agent_goals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  goal_type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  target_value DECIMAL(12,2),
  current_value DECIMAL(12,2) DEFAULT 0,
  target_date DATE,
  status TEXT DEFAULT 'active',
  ai_recommendations JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 12. SHOWING ROUTES TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS showing_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id),
  route_date DATE NOT NULL,
  start_location TEXT,
  properties JSONB NOT NULL DEFAULT '[]',
  optimized_order JSONB,
  total_distance_miles DECIMAL(8,2),
  total_duration_minutes INTEGER,
  ai_optimized BOOLEAN DEFAULT FALSE,
  status TEXT DEFAULT 'planned',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 13. SHOWING FEEDBACK TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS showing_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  showing_route_id UUID REFERENCES showing_routes(id) ON DELETE CASCADE,
  property_id UUID,
  listing_id UUID REFERENCES listings(id),
  contact_id UUID REFERENCES contacts(id),
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  interest_level TEXT,
  likes TEXT,
  dislikes TEXT,
  questions TEXT,
  ai_analysis JSONB,
  ai_followup_recommendations TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 14. NEWSLETTERS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS newsletters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  subject_line TEXT NOT NULL,
  preview_text TEXT,
  content_html TEXT,
  content_json JSONB,
  template_id TEXT,
  status TEXT DEFAULT 'draft',
  ai_generated BOOLEAN DEFAULT FALSE,
  ai_personalization_level TEXT,
  scheduled_send_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 15. NEWSLETTER SENDS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS newsletter_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  newsletter_id UUID NOT NULL REFERENCES newsletters(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  personalized_content TEXT,
  sent_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  unsubscribed_at TIMESTAMPTZ,
  bounce_type TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 16. DIRECT MAIL CAMPAIGNS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS direct_mail_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  campaign_name TEXT NOT NULL,
  campaign_type TEXT NOT NULL,
  mail_piece_type TEXT NOT NULL,
  target_audience JSONB,
  geographic_targeting JSONB,
  content_template TEXT,
  ai_generated_content TEXT,
  print_vendor TEXT,
  cost_per_piece DECIMAL(8,2),
  total_pieces INTEGER,
  total_cost DECIMAL(10,2),
  status TEXT DEFAULT 'draft',
  scheduled_mail_date DATE,
  mailed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 17. DIRECT MAIL RECIPIENTS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS direct_mail_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES direct_mail_campaigns(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id),
  name TEXT,
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip_code TEXT NOT NULL,
  personalized_message TEXT,
  status TEXT DEFAULT 'pending',
  tracking_code TEXT,
  response_received BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 18. EXPENSES TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transaction_id UUID REFERENCES transactions(id),
  category TEXT NOT NULL,
  subcategory TEXT,
  description TEXT NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  expense_date DATE NOT NULL,
  vendor TEXT,
  receipt_url TEXT,
  tax_deductible BOOLEAN DEFAULT FALSE,
  ai_categorized BOOLEAN DEFAULT FALSE,
  ai_category_confidence DECIMAL(5,2),
  quickbooks_id TEXT,
  synced_to_quickbooks BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 19. COMMISSION RECORDS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS commission_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transaction_id UUID REFERENCES transactions(id),
  gross_commission DECIMAL(12,2) NOT NULL,
  broker_split_percentage DECIMAL(5,2),
  broker_split_amount DECIMAL(12,2),
  team_split_percentage DECIMAL(5,2),
  team_split_amount DECIMAL(12,2),
  referral_fee_percentage DECIMAL(5,2),
  referral_fee_amount DECIMAL(12,2),
  franchise_fee DECIMAL(12,2),
  other_deductions DECIMAL(12,2),
  net_commission DECIMAL(12,2),
  cap_contribution DECIMAL(12,2),
  cap_reached BOOLEAN DEFAULT FALSE,
  payment_status TEXT DEFAULT 'pending',
  paid_date DATE,
  quickbooks_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 20. DEPOSITS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  deposit_type TEXT NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  deposit_date DATE NOT NULL,
  due_date DATE,
  received_by TEXT,
  held_by TEXT,
  status TEXT DEFAULT 'pending',
  receipt_number TEXT,
  notes TEXT,
  quickbooks_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 21. LISTING INTAKE SESSIONS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS listing_intake_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id),
  listing_id UUID REFERENCES listings(id),
  property_address TEXT NOT NULL,
  property_city TEXT,
  property_state TEXT,
  property_zip TEXT,
  session_status TEXT DEFAULT 'in_progress',
  intake_data JSONB DEFAULT '{}',
  required_forms JSONB DEFAULT '[]',
  completed_forms JSONB DEFAULT '[]',
  missing_signatures JSONB DEFAULT '[]',
  dotloop_loop_id TEXT,
  dotloop_status TEXT,
  ai_description TEXT,
  ai_pricing_suggestion JSONB,
  ai_marketing_recommendations JSONB,
  compliance_status TEXT DEFAULT 'pending',
  compliance_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- 22. OFFER SESSIONS TABLE
-- =====================================================
CREATE TABLE IF NOT EXISTS offer_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  buyer_contact_id UUID REFERENCES contacts(id),
  listing_id UUID REFERENCES listings(id),
  property_address TEXT NOT NULL,
  property_mls_number TEXT,
  session_status TEXT DEFAULT 'in_progress',
  offer_data JSONB DEFAULT '{}',
  required_forms JSONB DEFAULT '[]',
  completed_forms JSONB DEFAULT '[]',
  missing_signatures JSONB DEFAULT '[]',
  dotloop_loop_id TEXT,
  dotloop_status TEXT,
  ai_offer_strategy JSONB,
  ai_competitive_analysis JSONB,
  ai_negotiation_tips TEXT,
  submitted_at TIMESTAMPTZ,
  response_deadline TIMESTAMPTZ,
  seller_response TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- =====================================================
-- ADD AI COLUMNS TO EXISTING TABLES (safe additions)
-- =====================================================

-- Add AI columns to transactions if they don't exist
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'ai_health_score') THEN
    ALTER TABLE transactions ADD COLUMN ai_health_score INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'ai_risk_factors') THEN
    ALTER TABLE transactions ADD COLUMN ai_risk_factors JSONB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'transactions' AND column_name = 'ai_next_actions') THEN
    ALTER TABLE transactions ADD COLUMN ai_next_actions JSONB;
  END IF;
END $$;

-- Add AI columns to contacts if they don't exist
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contacts' AND column_name = 'ai_engagement_score') THEN
    ALTER TABLE contacts ADD COLUMN ai_engagement_score INTEGER;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contacts' AND column_name = 'ai_best_contact_time') THEN
    ALTER TABLE contacts ADD COLUMN ai_best_contact_time TEXT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contacts' AND column_name = 'ai_communication_preferences') THEN
    ALTER TABLE contacts ADD COLUMN ai_communication_preferences JSONB;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'contacts' AND column_name = 'ai_referral_likelihood') THEN
    ALTER TABLE contacts ADD COLUMN ai_referral_likelihood DECIMAL(5,2);
  END IF;
END $$;

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_transaction_tasks_transaction ON transaction_tasks(transaction_id);
CREATE INDEX IF NOT EXISTS idx_transaction_tasks_status ON transaction_tasks(status);
CREATE INDEX IF NOT EXISTS idx_appointments_agent_date ON appointments(agent_id, start_time);
CREATE INDEX IF NOT EXISTS idx_daily_schedules_agent_date ON daily_schedules(agent_id, schedule_date);
CREATE INDEX IF NOT EXISTS idx_showing_routes_agent_date ON showing_routes(agent_id, route_date);
CREATE INDEX IF NOT EXISTS idx_newsletters_agent_status ON newsletters(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_expenses_agent_date ON expenses(agent_id, expense_date);
CREATE INDEX IF NOT EXISTS idx_commission_records_agent ON commission_records(agent_id);
CREATE INDEX IF NOT EXISTS idx_listing_intake_agent ON listing_intake_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_offer_sessions_agent ON offer_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_referrals_agent ON referrals(agent_id);

-- =====================================================
-- ROW LEVEL SECURITY POLICIES
-- =====================================================
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_communications ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_closing_prep ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE daily_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE scheduled_touchpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE meeting_briefs ENABLE ROW LEVEL SECURITY;
ALTER TABLE weekly_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE showing_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE showing_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletters ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE direct_mail_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE direct_mail_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE commission_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_intake_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE offer_sessions ENABLE ROW LEVEL SECURITY;

-- Create RLS policies for agent-owned tables
DO $$
DECLARE
  tbl TEXT;
BEGIN
  FOR tbl IN SELECT unnest(ARRAY[
    'referrals', 'transaction_tasks', 'referral_requests', 'appointments', 
    'daily_schedules', 'scheduled_touchpoints', 'meeting_briefs', 'weekly_plans',
    'agent_goals', 'showing_routes', 'newsletters', 'direct_mail_campaigns',
    'expenses', 'commission_records', 'listing_intake_sessions', 'offer_sessions'
  ])
  LOOP
    EXECUTE format('
      DROP POLICY IF EXISTS %I_agent_policy ON %I;
      CREATE POLICY %I_agent_policy ON %I
        FOR ALL USING (agent_id = auth.uid());
    ', tbl, tbl, tbl, tbl);
  END LOOP;
END $$;

-- Success message
DO $$ BEGIN RAISE NOTICE 'Comprehensive AI Systems Schema v2 created successfully!'; END $$;
