-- ============================================================================
-- ADVANCED AI SYSTEMS SCHEMA
-- Listing Intake, Offer Creation, Newsletter, Direct Mail, Showings, Financial
-- ============================================================================

-- ============================================================================
-- LISTING INTAKE SYSTEM
-- ============================================================================

CREATE TABLE IF NOT EXISTS listing_intake_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  property_address TEXT,
  property_city TEXT,
  property_state TEXT NOT NULL,
  property_zip TEXT,
  listing_type TEXT DEFAULT 'residential',
  status TEXT DEFAULT 'draft',
  intake_data JSONB DEFAULT '{}',
  ai_recommendations JSONB DEFAULT '{}',
  required_forms JSONB DEFAULT '[]',
  completed_forms JSONB DEFAULT '[]',
  dotloop_loop_id TEXT,
  dotloop_status TEXT,
  compliance_status TEXT DEFAULT 'pending',
  compliance_notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  submitted_at TIMESTAMPTZ,
  approved_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS state_required_forms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state_code TEXT NOT NULL,
  form_name TEXT NOT NULL,
  form_code TEXT,
  form_category TEXT,
  is_required BOOLEAN DEFAULT true,
  listing_types TEXT[] DEFAULT ARRAY['residential'],
  description TEXT,
  dotloop_template_id TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- OFFER CREATION SYSTEM
-- ============================================================================

CREATE TABLE IF NOT EXISTS offer_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  buyer_contact_id UUID REFERENCES contacts(id),
  property_address TEXT NOT NULL,
  property_mls TEXT,
  listing_price DECIMAL(12,2),
  offer_price DECIMAL(12,2),
  earnest_money DECIMAL(12,2),
  option_fee DECIMAL(10,2),
  option_days INTEGER,
  financing_type TEXT,
  down_payment_percentage DECIMAL(5,2),
  closing_date DATE,
  contingencies JSONB DEFAULT '[]',
  special_provisions TEXT,
  ai_strategy JSONB DEFAULT '{}',
  ai_recommendations JSONB DEFAULT '{}',
  required_forms JSONB DEFAULT '[]',
  completed_forms JSONB DEFAULT '[]',
  dotloop_loop_id TEXT,
  dotloop_status TEXT,
  status TEXT DEFAULT 'draft',
  submitted_at TIMESTAMPTZ,
  response_received_at TIMESTAMPTZ,
  response_type TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS offer_comparables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_session_id UUID NOT NULL REFERENCES offer_sessions(id) ON DELETE CASCADE,
  address TEXT,
  sale_price DECIMAL(12,2),
  sale_date DATE,
  days_on_market INTEGER,
  price_per_sqft DECIMAL(10,2),
  similarity_score INTEGER,
  source TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- NEWSLETTER SYSTEM
-- ============================================================================

CREATE TABLE IF NOT EXISTS newsletters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  subject_line TEXT,
  preview_text TEXT,
  content_html TEXT,
  content_json JSONB DEFAULT '{}',
  template_id TEXT,
  audience_segments JSONB DEFAULT '[]',
  ai_generated_content JSONB DEFAULT '{}',
  personalization_tokens JSONB DEFAULT '[]',
  status TEXT DEFAULT 'draft',
  scheduled_for TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id),
  email TEXT NOT NULL,
  first_name TEXT,
  last_name TEXT,
  segments JSONB DEFAULT '[]',
  subscription_status TEXT DEFAULT 'active',
  subscribed_at TIMESTAMPTZ DEFAULT NOW(),
  unsubscribed_at TIMESTAMPTZ,
  preferences JSONB DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS newsletter_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  newsletter_id UUID NOT NULL REFERENCES newsletters(id) ON DELETE CASCADE,
  subscriber_id UUID NOT NULL REFERENCES newsletter_subscribers(id) ON DELETE CASCADE,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  bounced BOOLEAN DEFAULT false,
  bounce_reason TEXT,
  unsubscribed BOOLEAN DEFAULT false
);

-- ============================================================================
-- DIRECT MAIL SYSTEM
-- ============================================================================

CREATE TABLE IF NOT EXISTS direct_mail_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  campaign_name TEXT NOT NULL,
  campaign_type TEXT NOT NULL,
  mail_piece_type TEXT DEFAULT 'postcard',
  design_template_id TEXT,
  content_front TEXT,
  content_back TEXT,
  ai_generated_content JSONB DEFAULT '{}',
  target_audience JSONB DEFAULT '{}',
  geographic_targeting JSONB DEFAULT '{}',
  estimated_recipients INTEGER DEFAULT 0,
  cost_per_piece DECIMAL(10,2),
  total_cost DECIMAL(12,2),
  print_vendor TEXT,
  print_status TEXT DEFAULT 'pending',
  mail_date DATE,
  status TEXT DEFAULT 'draft',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS direct_mail_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES direct_mail_campaigns(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id),
  address_line1 TEXT NOT NULL,
  address_line2 TEXT,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  zip TEXT NOT NULL,
  personalization_data JSONB DEFAULT '{}',
  mail_status TEXT DEFAULT 'pending',
  delivered_at TIMESTAMPTZ,
  returned BOOLEAN DEFAULT false,
  return_reason TEXT
);

-- ============================================================================
-- SHOWING MANAGEMENT SYSTEM
-- ============================================================================

CREATE TABLE IF NOT EXISTS showings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  property_id UUID REFERENCES listings(id),
  contact_id UUID REFERENCES contacts(id),
  showing_date DATE NOT NULL,
  showing_time TIME NOT NULL,
  duration_minutes INTEGER DEFAULT 30,
  status TEXT DEFAULT 'scheduled',
  notes TEXT,
  ai_recommendations JSONB DEFAULT '{}',
  buyer_match_score INTEGER,
  route_id UUID,
  route_order INTEGER,
  confirmed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancellation_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS showing_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  route_date DATE NOT NULL,
  showings UUID[] DEFAULT '{}',
  optimized_order JSONB DEFAULT '[]',
  total_duration INTEGER,
  estimated_miles DECIMAL(10,2),
  optimization_score INTEGER,
  route_notes JSONB DEFAULT '[]',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS showing_feedback_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  showing_id UUID NOT NULL REFERENCES showings(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id),
  property_id UUID REFERENCES listings(id),
  feedback_form JSONB DEFAULT '{}',
  responses JSONB,
  interest_score INTEGER,
  ai_analysis JSONB,
  sent_at TIMESTAMPTZ,
  responded_at TIMESTAMPTZ,
  analyzed_at TIMESTAMPTZ,
  status TEXT DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS showing_communications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  showing_id UUID NOT NULL REFERENCES showings(id) ON DELETE CASCADE,
  communication_type TEXT NOT NULL,
  email_content JSONB,
  sms_content TEXT,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  status TEXT DEFAULT 'sent'
);

-- ============================================================================
-- FINANCIAL MANAGEMENT SYSTEM
-- ============================================================================

CREATE TABLE IF NOT EXISTS expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transaction_id UUID REFERENCES transactions(id),
  amount DECIMAL(12,2) NOT NULL,
  category TEXT NOT NULL,
  subcategory TEXT,
  description TEXT,
  vendor TEXT,
  receipt_url TEXT,
  expense_date DATE NOT NULL,
  is_deductible BOOLEAN DEFAULT true,
  deduction_percentage INTEGER DEFAULT 100,
  ai_categorization JSONB DEFAULT '{}',
  tags TEXT[] DEFAULT '{}',
  quickbooks_id TEXT,
  quickbooks_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  gross_commission DECIMAL(12,2) NOT NULL,
  agent_split_percentage DECIMAL(5,2),
  brokerage_share DECIMAL(12,2),
  agent_gross DECIMAL(12,2),
  fees_total DECIMAL(12,2) DEFAULT 0,
  fee_breakdown JSONB DEFAULT '[]',
  capped_amount DECIMAL(12,2) DEFAULT 0,
  agent_net DECIMAL(12,2),
  tax_estimate JSONB DEFAULT '{}',
  status TEXT DEFAULT 'pending',
  paid_at TIMESTAMPTZ,
  quickbooks_id TEXT,
  quickbooks_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deposits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transaction_id UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  amount DECIMAL(12,2) NOT NULL,
  deposit_type TEXT NOT NULL,
  received_date DATE NOT NULL,
  due_date DATE,
  delivered_date DATE,
  escrow_company TEXT,
  check_number TEXT,
  notes TEXT,
  status TEXT DEFAULT 'received',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS budgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  year INTEGER NOT NULL,
  income_goal DECIMAL(12,2),
  budget_data JSONB NOT NULL,
  actual_vs_budget JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id, year)
);

CREATE TABLE IF NOT EXISTS financial_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  report_type TEXT NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  total_income DECIMAL(12,2),
  total_expenses DECIMAL(12,2),
  net_profit DECIMAL(12,2),
  expenses_by_category JSONB DEFAULT '{}',
  deductible_expenses DECIMAL(12,2),
  ai_analysis JSONB DEFAULT '{}',
  generated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS quickbooks_sync_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  qb_data JSONB NOT NULL,
  qb_id TEXT,
  status TEXT DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  synced_at TIMESTAMPTZ
);

-- ============================================================================
-- COMPLIANCE TASKS
-- ============================================================================

CREATE TABLE IF NOT EXISTS compliance_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  transaction_id UUID REFERENCES transactions(id),
  task_type TEXT NOT NULL,
  description TEXT NOT NULL,
  due_date DATE,
  completed_at TIMESTAMPTZ,
  status TEXT DEFAULT 'pending',
  priority TEXT DEFAULT 'medium',
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_listing_intake_agent ON listing_intake_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_listing_intake_status ON listing_intake_sessions(status);
CREATE INDEX IF NOT EXISTS idx_offer_sessions_agent ON offer_sessions(agent_id);
CREATE INDEX IF NOT EXISTS idx_offer_sessions_buyer ON offer_sessions(buyer_contact_id);
CREATE INDEX IF NOT EXISTS idx_newsletters_agent ON newsletters(agent_id);
CREATE INDEX IF NOT EXISTS idx_newsletters_status ON newsletters(status);
CREATE INDEX IF NOT EXISTS idx_direct_mail_agent ON direct_mail_campaigns(agent_id);
CREATE INDEX IF NOT EXISTS idx_showings_agent_date ON showings(agent_id, showing_date);
CREATE INDEX IF NOT EXISTS idx_showings_property ON showings(property_id);
CREATE INDEX IF NOT EXISTS idx_showings_contact ON showings(contact_id);
CREATE INDEX IF NOT EXISTS idx_expenses_agent_date ON expenses(agent_id, expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_category ON expenses(category);
CREATE INDEX IF NOT EXISTS idx_commissions_agent ON commissions(agent_id);
CREATE INDEX IF NOT EXISTS idx_commissions_transaction ON commissions(transaction_id);
CREATE INDEX IF NOT EXISTS idx_deposits_transaction ON deposits(transaction_id);
CREATE INDEX IF NOT EXISTS idx_compliance_tasks_agent ON compliance_tasks(agent_id);
CREATE INDEX IF NOT EXISTS idx_compliance_tasks_due ON compliance_tasks(due_date);

-- ============================================================================
-- RLS POLICIES
-- ============================================================================

ALTER TABLE listing_intake_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE offer_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletters ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE direct_mail_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE showings ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE deposits ENABLE ROW LEVEL SECURITY;
ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE financial_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_tasks ENABLE ROW LEVEL SECURITY;

-- Agent access policies
CREATE POLICY "agents_own_listing_intake" ON listing_intake_sessions
  FOR ALL USING (auth.uid() = agent_id);

CREATE POLICY "agents_own_offer_sessions" ON offer_sessions
  FOR ALL USING (auth.uid() = agent_id);

CREATE POLICY "agents_own_newsletters" ON newsletters
  FOR ALL USING (auth.uid() = agent_id);

CREATE POLICY "agents_own_subscribers" ON newsletter_subscribers
  FOR ALL USING (auth.uid() = agent_id);

CREATE POLICY "agents_own_direct_mail" ON direct_mail_campaigns
  FOR ALL USING (auth.uid() = agent_id);

CREATE POLICY "agents_own_showings" ON showings
  FOR ALL USING (auth.uid() = agent_id);

CREATE POLICY "agents_own_expenses" ON expenses
  FOR ALL USING (auth.uid() = agent_id);

CREATE POLICY "agents_own_commissions" ON commissions
  FOR ALL USING (auth.uid() = agent_id);

CREATE POLICY "agents_own_deposits" ON deposits
  FOR ALL USING (auth.uid() = agent_id);

CREATE POLICY "agents_own_budgets" ON budgets
  FOR ALL USING (auth.uid() = agent_id);

CREATE POLICY "agents_own_financial_reports" ON financial_reports
  FOR ALL USING (auth.uid() = agent_id);

CREATE POLICY "agents_own_compliance_tasks" ON compliance_tasks
  FOR ALL USING (auth.uid() = agent_id);

-- ============================================================================
-- HELPER FUNCTIONS
-- ============================================================================

CREATE OR REPLACE FUNCTION adjust_lead_score(
  p_contact_id UUID,
  p_adjustment INTEGER,
  p_reason TEXT
) RETURNS VOID AS $$
BEGIN
  UPDATE contacts
  SET 
    lead_score = GREATEST(0, LEAST(100, COALESCE(lead_score, 50) + p_adjustment)),
    updated_at = NOW()
  WHERE id = p_contact_id;
  
  INSERT INTO contact_score_history (contact_id, score_change, reason, created_at)
  VALUES (p_contact_id, p_adjustment, p_reason, NOW());
END;
$$ LANGUAGE plpgsql;

-- Score history table
CREATE TABLE IF NOT EXISTS contact_score_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  score_change INTEGER NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_score_history_contact ON contact_score_history(contact_id);
