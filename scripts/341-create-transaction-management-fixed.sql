-- Transaction Management System Schema (Fixed - no agents reference)
-- Comprehensive tables for managing real estate transactions from offer to close

-- Update existing transactions table with new columns if not present
-- Removed REFERENCES agents(id) - using UUID without FK constraint
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transaction_coordinator_id UUID;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS property_mls_id TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transaction_type TEXT DEFAULT 'purchase';
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS transaction_side TEXT DEFAULT 'buy_side';
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS earnest_money DECIMAL(12,2);
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS contract_date DATE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS possession_date DATE;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS current_milestone TEXT;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS milestones_completed INTEGER DEFAULT 0;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS total_milestones INTEGER DEFAULT 0;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS progress_percentage INTEGER DEFAULT 0;
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';

-- Transaction Milestones
CREATE TABLE IF NOT EXISTS transaction_milestones (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  milestone_name TEXT NOT NULL,
  milestone_type TEXT NOT NULL,
  due_date DATE,
  completed_date DATE,
  status TEXT DEFAULT 'pending',
  assigned_to_type TEXT,
  assigned_to_id UUID,
  dependencies JSONB DEFAULT '[]',
  required_documents TEXT[],
  checklist_items JSONB DEFAULT '[]',
  notes TEXT,
  display_order INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Transaction Participants
CREATE TABLE IF NOT EXISTS transaction_participants (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  participant_type TEXT NOT NULL,
  participant_role TEXT NOT NULL,
  contact_name TEXT NOT NULL,
  contact_email TEXT,
  contact_phone TEXT,
  company_name TEXT,
  license_number TEXT,
  portal_access BOOLEAN DEFAULT false,
  notification_preferences JSONB DEFAULT '{}',
  metadata JSONB DEFAULT '{}',
  added_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Lender Information
CREATE TABLE IF NOT EXISTS transaction_lenders (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  lender_name TEXT NOT NULL,
  lender_contact TEXT NOT NULL,
  lender_email TEXT NOT NULL,
  lender_phone TEXT,
  loan_type TEXT,
  loan_amount DECIMAL(12,2),
  down_payment_amount DECIMAL(12,2),
  interest_rate DECIMAL(5,3),
  pre_approval_date DATE,
  pre_approval_amount DECIMAL(12,2),
  underwriting_status TEXT DEFAULT 'pre_approval',
  conditions_list JSONB DEFAULT '[]',
  conditions_cleared INTEGER DEFAULT 0,
  estimated_closing_costs DECIMAL(12,2),
  appraisal_ordered BOOLEAN DEFAULT false,
  appraisal_date DATE,
  appraisal_value DECIMAL(12,2),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Title/Escrow Company
CREATE TABLE IF NOT EXISTS transaction_title_escrow (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  company_name TEXT NOT NULL,
  escrow_officer_name TEXT,
  escrow_officer_email TEXT,
  escrow_officer_phone TEXT,
  escrow_number TEXT,
  title_commitment_date DATE,
  title_policy_amount DECIMAL(12,2),
  title_issues JSONB DEFAULT '[]',
  earnest_money_deposited BOOLEAN DEFAULT false,
  earnest_money_deposit_date DATE,
  closing_disclosure_sent DATE,
  wire_instructions_sent BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Inspection Orders
CREATE TABLE IF NOT EXISTS transaction_inspections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  inspection_type TEXT NOT NULL,
  inspector_name TEXT NOT NULL,
  inspector_company TEXT,
  inspector_email TEXT,
  inspector_phone TEXT,
  scheduled_date TIMESTAMPTZ,
  completed_date DATE,
  report_url TEXT,
  cost DECIMAL(10,2),
  paid BOOLEAN DEFAULT false,
  issues_found JSONB DEFAULT '[]',
  repairs_requested JSONB DEFAULT '[]',
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Vendor Services
CREATE TABLE IF NOT EXISTS transaction_vendor_services (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  service_type TEXT NOT NULL,
  vendor_name TEXT NOT NULL,
  vendor_company TEXT,
  vendor_email TEXT,
  vendor_phone TEXT,
  service_description TEXT,
  scheduled_date DATE,
  completed_date DATE,
  cost DECIMAL(10,2),
  paid BOOLEAN DEFAULT false,
  payment_responsibility TEXT,
  invoice_url TEXT,
  deliverables JSONB DEFAULT '[]',
  status TEXT DEFAULT 'pending',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Transaction Documents
CREATE TABLE IF NOT EXISTS transaction_documents (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL,
  document_name TEXT NOT NULL,
  document_url TEXT NOT NULL,
  uploaded_by_type TEXT,
  uploaded_by_id UUID,
  requires_signature BOOLEAN DEFAULT false,
  signature_status JSONB DEFAULT '{}',
  is_compliance_approved BOOLEAN DEFAULT false,
  version INTEGER DEFAULT 1,
  uploaded_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Transaction Timeline/Activity
CREATE TABLE IF NOT EXISTS transaction_timeline (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  event_title TEXT NOT NULL,
  event_description TEXT,
  event_data JSONB DEFAULT '{}',
  created_by_type TEXT,
  created_by_id UUID,
  is_visible_to_client BOOLEAN DEFAULT true,
  occurred_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Deadlines and Reminders
CREATE TABLE IF NOT EXISTS transaction_deadlines (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  deadline_name TEXT NOT NULL,
  deadline_type TEXT NOT NULL,
  due_date DATE NOT NULL,
  responsible_party_type TEXT,
  responsible_party_id UUID,
  status TEXT DEFAULT 'pending',
  reminder_sent BOOLEAN DEFAULT false,
  reminder_dates DATE[],
  completed_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Commission Splits
CREATE TABLE IF NOT EXISTS transaction_commissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  total_commission DECIMAL(12,2),
  commission_percentage DECIMAL(5,3),
  agent_split_percentage DECIMAL(5,3),
  agent_commission DECIMAL(12,2),
  brokerage_split_percentage DECIMAL(5,3),
  brokerage_commission DECIMAL(12,2),
  team_split JSONB DEFAULT '[]',
  referral_fees JSONB DEFAULT '[]',
  other_deductions JSONB DEFAULT '[]',
  net_to_agent DECIMAL(12,2),
  payment_status TEXT DEFAULT 'pending',
  paid_date DATE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Repair Negotiations
CREATE TABLE IF NOT EXISTS transaction_repair_negotiations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  negotiation_round INTEGER DEFAULT 1,
  requested_repairs JSONB NOT NULL DEFAULT '[]',
  seller_response JSONB,
  agreed_repairs JSONB DEFAULT '[]',
  repair_credit_amount DECIMAL(10,2),
  status TEXT DEFAULT 'pending',
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_milestones_transaction ON transaction_milestones(transaction_id, status);
CREATE INDEX IF NOT EXISTS idx_participants_transaction ON transaction_participants(transaction_id);
CREATE INDEX IF NOT EXISTS idx_timeline_transaction ON transaction_timeline(transaction_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_deadlines_transaction ON transaction_deadlines(transaction_id, due_date);
CREATE INDEX IF NOT EXISTS idx_inspections_transaction ON transaction_inspections(transaction_id);
CREATE INDEX IF NOT EXISTS idx_documents_transaction ON transaction_documents(transaction_id);
CREATE INDEX IF NOT EXISTS idx_lenders_transaction ON transaction_lenders(transaction_id);

-- Enable RLS
ALTER TABLE transaction_milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_lenders ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_title_escrow ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_inspections ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_vendor_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_timeline ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_deadlines ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_commissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transaction_repair_negotiations ENABLE ROW LEVEL SECURITY;

-- Create policies (drop existing first to avoid conflicts)
DROP POLICY IF EXISTS "Service role manages transaction_milestones" ON transaction_milestones;
DROP POLICY IF EXISTS "Service role manages transaction_participants" ON transaction_participants;
DROP POLICY IF EXISTS "Service role manages transaction_lenders" ON transaction_lenders;
DROP POLICY IF EXISTS "Service role manages transaction_title_escrow" ON transaction_title_escrow;
DROP POLICY IF EXISTS "Service role manages transaction_inspections" ON transaction_inspections;
DROP POLICY IF EXISTS "Service role manages transaction_vendor_services" ON transaction_vendor_services;
DROP POLICY IF EXISTS "Service role manages transaction_documents" ON transaction_documents;
DROP POLICY IF EXISTS "Service role manages transaction_timeline" ON transaction_timeline;
DROP POLICY IF EXISTS "Service role manages transaction_deadlines" ON transaction_deadlines;
DROP POLICY IF EXISTS "Service role manages transaction_commissions" ON transaction_commissions;
DROP POLICY IF EXISTS "Service role manages transaction_repair_negotiations" ON transaction_repair_negotiations;

CREATE POLICY "Service role manages transaction_milestones" ON transaction_milestones FOR ALL USING (true);
CREATE POLICY "Service role manages transaction_participants" ON transaction_participants FOR ALL USING (true);
CREATE POLICY "Service role manages transaction_lenders" ON transaction_lenders FOR ALL USING (true);
CREATE POLICY "Service role manages transaction_title_escrow" ON transaction_title_escrow FOR ALL USING (true);
CREATE POLICY "Service role manages transaction_inspections" ON transaction_inspections FOR ALL USING (true);
CREATE POLICY "Service role manages transaction_vendor_services" ON transaction_vendor_services FOR ALL USING (true);
CREATE POLICY "Service role manages transaction_documents" ON transaction_documents FOR ALL USING (true);
CREATE POLICY "Service role manages transaction_timeline" ON transaction_timeline FOR ALL USING (true);
CREATE POLICY "Service role manages transaction_deadlines" ON transaction_deadlines FOR ALL USING (true);
CREATE POLICY "Service role manages transaction_commissions" ON transaction_commissions FOR ALL USING (true);
CREATE POLICY "Service role manages transaction_repair_negotiations" ON transaction_repair_negotiations FOR ALL USING (true);
