-- Multi-Persona Platform Tables
-- Creates tables for office admins, transaction coordinators, vendors, lenders, etc.

-- =============================================
-- OFFICE ADMINS
-- =============================================
CREATE TABLE IF NOT EXISTS office_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  brokerage_id UUID,
  permissions JSONB DEFAULT '{}',
  manages_agents BOOLEAN DEFAULT true,
  manages_transactions BOOLEAN DEFAULT true,
  manages_compliance BOOLEAN DEFAULT false,
  manages_billing BOOLEAN DEFAULT true,
  can_generate_reports BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_office_admins_brokerage ON office_admins(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_office_admins_user ON office_admins(user_id);

-- =============================================
-- TRANSACTION COORDINATORS
-- =============================================
CREATE TABLE IF NOT EXISTS transaction_coordinators (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  brokerage_id UUID,
  assigned_agents UUID[],
  active_transactions_count INTEGER DEFAULT 0,
  max_transactions_capacity INTEGER DEFAULT 20,
  specializes_in TEXT[],
  hourly_rate DECIMAL(10,2),
  is_accepting_new_transactions BOOLEAN DEFAULT true,
  performance_metrics JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coordinators_brokerage ON transaction_coordinators(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_coordinators_user ON transaction_coordinators(user_id);

-- =============================================
-- LENDER PORTAL USERS
-- =============================================
CREATE TABLE IF NOT EXISTS lender_portal_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lender_name TEXT NOT NULL,
  lender_company TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  nmls_number TEXT,
  license_states TEXT[],
  loan_types TEXT[],
  portal_access_token TEXT UNIQUE,
  assigned_transactions UUID[],
  preferred_underwriters JSONB,
  average_approval_days INTEGER,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lender_portal_email ON lender_portal_users(email);

-- =============================================
-- TITLE COMPANY USERS
-- =============================================
CREATE TABLE IF NOT EXISTS title_company_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name TEXT NOT NULL,
  officer_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  license_number TEXT,
  service_areas TEXT[],
  portal_access_token TEXT UNIQUE,
  assigned_transactions UUID[],
  average_turnaround_days INTEGER,
  specialties TEXT[],
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_title_company_email ON title_company_users(email);

-- =============================================
-- VENDOR DIRECTORY
-- =============================================
CREATE TABLE IF NOT EXISTS vendor_directory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_type TEXT NOT NULL,
  vendor_name TEXT NOT NULL,
  company_name TEXT,
  email TEXT,
  phone TEXT NOT NULL,
  license_number TEXT,
  insurance_info JSONB,
  service_areas TEXT[],
  specialties TEXT[],
  pricing JSONB,
  availability_calendar JSONB,
  rating DECIMAL(3,2),
  total_jobs_completed INTEGER DEFAULT 0,
  preferred_by_agents UUID[],
  portal_access BOOLEAN DEFAULT false,
  portal_access_token TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_directory_type ON vendor_directory(vendor_type, is_active);

-- =============================================
-- VENDOR BOOKINGS
-- =============================================
CREATE TABLE IF NOT EXISTS vendor_bookings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id UUID,
  transaction_id UUID,
  booked_by UUID,
  service_type TEXT NOT NULL,
  service_description TEXT,
  scheduled_date TIMESTAMPTZ,
  estimated_duration INTEGER,
  actual_start_time TIMESTAMPTZ,
  actual_end_time TIMESTAMPTZ,
  status TEXT DEFAULT 'pending',
  cost DECIMAL(10,2),
  payment_status TEXT DEFAULT 'pending',
  invoice_url TEXT,
  deliverables JSONB,
  client_rating INTEGER,
  agent_rating INTEGER,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_vendor_bookings_transaction ON vendor_bookings(transaction_id, status);
CREATE INDEX IF NOT EXISTS idx_vendor_bookings_vendor ON vendor_bookings(vendor_id);

-- =============================================
-- COMPLIANCE REVIEWS
-- =============================================
CREATE TABLE IF NOT EXISTS compliance_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reviewer_id UUID,
  review_type TEXT NOT NULL,
  related_entity_id UUID NOT NULL,
  related_entity_type TEXT NOT NULL,
  review_status TEXT DEFAULT 'pending',
  findings JSONB[],
  risk_level TEXT,
  action_required TEXT,
  deadline_date DATE,
  reviewed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_compliance_reviews_reviewer ON compliance_reviews(reviewer_id, review_status);

-- =============================================
-- COMMISSION STRUCTURES
-- =============================================
CREATE TABLE IF NOT EXISTS commission_structures (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID,
  structure_name TEXT NOT NULL,
  structure_type TEXT NOT NULL,
  agent_split_percentage DECIMAL(5,2),
  brokerage_split_percentage DECIMAL(5,2),
  annual_cap DECIMAL(12,2),
  transaction_fee DECIMAL(10,2),
  tier_thresholds JSONB,
  applies_to_agent_ids UUID[],
  is_default BOOLEAN DEFAULT false,
  effective_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_commission_structures_brokerage ON commission_structures(brokerage_id);

-- =============================================
-- AGENT BILLING
-- =============================================
CREATE TABLE IF NOT EXISTS agent_billing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  brokerage_id UUID,
  billing_period_start DATE NOT NULL,
  billing_period_end DATE NOT NULL,
  gross_commission DECIMAL(12,2) DEFAULT 0,
  brokerage_split_amount DECIMAL(12,2) DEFAULT 0,
  transaction_fees DECIMAL(10,2) DEFAULT 0,
  desk_fees DECIMAL(10,2) DEFAULT 0,
  technology_fees DECIMAL(10,2) DEFAULT 0,
  marketing_fees DECIMAL(10,2) DEFAULT 0,
  e_and_o_insurance DECIMAL(10,2) DEFAULT 0,
  other_deductions JSONB[],
  referral_fees_paid DECIMAL(10,2) DEFAULT 0,
  referral_fees_received DECIMAL(10,2) DEFAULT 0,
  net_to_agent DECIMAL(12,2),
  payment_status TEXT DEFAULT 'pending',
  payment_date DATE,
  payment_method TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_billing_agent ON agent_billing(agent_id, billing_period_start);

-- =============================================
-- AGENT TEAMS
-- =============================================
CREATE TABLE IF NOT EXISTS agent_teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_name TEXT NOT NULL,
  team_leader_id UUID,
  brokerage_id UUID,
  team_members UUID[],
  commission_split_rules JSONB,
  shared_leads BOOLEAN DEFAULT true,
  shared_transactions BOOLEAN DEFAULT true,
  team_goals JSONB,
  team_performance JSONB,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_teams_brokerage ON agent_teams(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_agent_teams_leader ON agent_teams(team_leader_id);

-- =============================================
-- CLIENT REVIEWS
-- =============================================
CREATE TABLE IF NOT EXISTS client_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID,
  transaction_id UUID,
  agent_id UUID,
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  review_text TEXT,
  review_categories JSONB,
  would_recommend BOOLEAN,
  is_public BOOLEAN DEFAULT false,
  is_approved BOOLEAN DEFAULT false,
  approved_by UUID,
  review_source TEXT,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_reviews_agent ON client_reviews(agent_id);
CREATE INDEX IF NOT EXISTS idx_client_reviews_transaction ON client_reviews(transaction_id);

-- =============================================
-- WORKFLOW AUTOMATIONS
-- =============================================
CREATE TABLE IF NOT EXISTS workflow_automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_name TEXT NOT NULL,
  workflow_type TEXT NOT NULL,
  trigger_event TEXT NOT NULL,
  trigger_conditions JSONB,
  actions JSONB[],
  assigned_to_role TEXT,
  is_active BOOLEAN DEFAULT true,
  execution_count INTEGER DEFAULT 0,
  last_executed_at TIMESTAMPTZ,
  created_by UUID,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- =============================================
-- REFERRAL PARTNERS
-- =============================================
CREATE TABLE IF NOT EXISTS referral_partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_type TEXT NOT NULL,
  partner_name TEXT NOT NULL,
  company_name TEXT,
  email TEXT,
  phone TEXT,
  service_areas TEXT[],
  specialties TEXT[],
  referral_fee_structure JSONB,
  referred_by UUID,
  total_referrals_sent INTEGER DEFAULT 0,
  total_referrals_received INTEGER DEFAULT 0,
  total_fees_paid DECIMAL(12,2) DEFAULT 0,
  total_fees_received DECIMAL(12,2) DEFAULT 0,
  rating DECIMAL(3,2),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_partners_type ON referral_partners(partner_type);

-- =============================================
-- CLIENT JOURNEY PREFERENCES
-- =============================================
CREATE TABLE IF NOT EXISTS client_journey_preferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID,
  contact_id UUID,
  journey_type TEXT NOT NULL,
  must_have_features TEXT[],
  nice_to_have_features TEXT[],
  deal_breakers TEXT[],
  preferred_neighborhoods TEXT[],
  commute_considerations JSONB,
  school_requirements JSONB,
  lifestyle_priorities TEXT[],
  selling_timeline TEXT,
  selling_motivation TEXT[],
  preferred_marketing_approach TEXT[],
  showing_preferences JSONB,
  preferred_contact_method TEXT[],
  preferred_contact_times JSONB,
  frequency_preference TEXT,
  decision_makers TEXT[],
  decision_timeline TEXT,
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_client_journey_lead ON client_journey_preferences(lead_id);
CREATE INDEX IF NOT EXISTS idx_client_journey_contact ON client_journey_preferences(contact_id);
