-- =====================================================
-- CREDIT COPILOT & PERSISTENT AI SIDEKICK ENHANCEMENT
-- Migration: 060
-- =====================================================

-- Drop existing tables if we need to rebuild them with better structure
DROP TABLE IF EXISTS credit_conversation_logs CASCADE;
DROP TABLE IF EXISTS credit_partner_referrals CASCADE;
DROP TABLE IF EXISTS credit_status CASCADE;

-- =====================================================
-- 1. EXTEND CONTACTS TABLE WITH CREDIT FIELDS
-- =====================================================

-- Adding credit-specific fields to contacts table
ALTER TABLE contacts 
ADD COLUMN IF NOT EXISTS credit_status TEXT CHECK (credit_status IN ('unknown', 'good', 'fair', 'poor', 'in_program', 'target_reached')) DEFAULT 'unknown',
ADD COLUMN IF NOT EXISTS credit_score_band TEXT CHECK (credit_score_band IN ('300-579', '580-669', '670-739', '740+')) DEFAULT NULL,
ADD COLUMN IF NOT EXISTS lender_status TEXT CHECK (lender_status IN ('none', 'pre_approved', 'denied', 'in_review')) DEFAULT 'none',
ADD COLUMN IF NOT EXISTS credit_pipeline_stage TEXT CHECK (credit_pipeline_stage IN ('none', 'intake', 'referred', 'in_program', 'target_score_reached', 'dropped')) DEFAULT 'none';

-- Add indexes for credit fields
CREATE INDEX IF NOT EXISTS idx_contacts_credit_status ON contacts(credit_status);
CREATE INDEX IF NOT EXISTS idx_contacts_credit_pipeline_stage ON contacts(credit_pipeline_stage);
CREATE INDEX IF NOT EXISTS idx_contacts_lender_status ON contacts(lender_status);

-- =====================================================
-- 2. CREDIT SETTINGS (BROKERAGE CONFIG)
-- =====================================================

CREATE TABLE IF NOT EXISTS credit_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID REFERENCES users(id) ON DELETE CASCADE,
  credit_score_threshold INTEGER DEFAULT 580,
  max_outreach_per_week INTEGER DEFAULT 10,
  max_outreach_per_month INTEGER DEFAULT 40,
  disclosure_snippet TEXT DEFAULT 'We may refer you to a credit repair partner. This is not a guarantee of credit approval.',
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  UNIQUE(brokerage_id)
);

-- RLS for credit_settings
ALTER TABLE credit_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Brokers manage their own credit settings"
  ON credit_settings
  FOR ALL
  USING (
    auth.uid() = brokerage_id OR 
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND user_type = 'admin')
  );

-- =====================================================
-- 3. CREDIT PARTNER MAPPING (OFFICE/MARKET CONFIG)
-- =====================================================

CREATE TABLE IF NOT EXISTS credit_partner_mapping (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  market TEXT NOT NULL,
  office_id UUID DEFAULT NULL,
  partner_id UUID REFERENCES vendors(id) ON DELETE CASCADE,
  partner_name TEXT NOT NULL,
  partner_webhook_url TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Index for lookups by market/office
CREATE INDEX IF NOT EXISTS idx_credit_partner_market ON credit_partner_mapping(market);
CREATE INDEX IF NOT EXISTS idx_credit_partner_office ON credit_partner_mapping(office_id);

-- RLS for credit_partner_mapping
ALTER TABLE credit_partner_mapping ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins and brokers manage credit partner mapping"
  ON credit_partner_mapping
  FOR ALL
  USING (
    EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND user_type IN ('admin', 'broker'))
  );

-- =====================================================
-- 4. ENHANCED CREDIT CONVERSATION LOG
-- =====================================================

CREATE TABLE IF NOT EXISTS credit_conversation_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  channel TEXT CHECK (channel IN ('sms', 'email', 'chat', 'voice')) NOT NULL,
  direction TEXT CHECK (direction IN ('outbound', 'inbound')) NOT NULL,
  message_body TEXT,
  ai_agent_id UUID DEFAULT NULL, -- Reference to ai_agent_instances when available
  disposition TEXT CHECK (disposition IN ('interested', 'not_interested', 'referred', 'ready_to_shop', 'needs_time', 'no_response')) DEFAULT NULL,
  created_at TIMESTAMP DEFAULT now()
);

-- Indexes for credit_conversation_log
CREATE INDEX IF NOT EXISTS idx_credit_conversation_contact ON credit_conversation_log(contact_id);
CREATE INDEX IF NOT EXISTS idx_credit_conversation_created ON credit_conversation_log(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_credit_conversation_disposition ON credit_conversation_log(disposition);

-- RLS for credit_conversation_log
ALTER TABLE credit_conversation_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents see conversations for their contacts"
  ON credit_conversation_log
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM contacts 
      WHERE contacts.id = credit_conversation_log.contact_id 
      AND (contacts.agent_id = auth.uid() OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND user_type IN ('admin', 'broker')))
    )
  );

CREATE POLICY "System can insert credit conversations"
  ON credit_conversation_log
  FOR INSERT
  WITH CHECK (true);

-- =====================================================
-- 5. ENHANCED CREDIT PARTNER REFERRAL
-- =====================================================

CREATE TABLE IF NOT EXISTS credit_partner_referral (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  partner_id UUID REFERENCES credit_partner_mapping(id) ON DELETE CASCADE,
  status TEXT CHECK (status IN ('sent', 'engaged', 'plan_started', 'target_score_reached', 'no_response', 'closed_out')) DEFAULT 'sent',
  sent_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  partner_payload JSONB DEFAULT '{}'::jsonb
);

-- Indexes for credit_partner_referral
CREATE INDEX IF NOT EXISTS idx_credit_referral_contact ON credit_partner_referral(contact_id);
CREATE INDEX IF NOT EXISTS idx_credit_referral_partner ON credit_partner_referral(partner_id);
CREATE INDEX IF NOT EXISTS idx_credit_referral_status ON credit_partner_referral(status);

-- RLS for credit_partner_referral
ALTER TABLE credit_partner_referral ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents see referrals for their contacts"
  ON credit_partner_referral
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM contacts 
      WHERE contacts.id = credit_partner_referral.contact_id 
      AND (contacts.agent_id = auth.uid() OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND user_type IN ('admin', 'broker')))
    )
  );

CREATE POLICY "System can insert credit referrals"
  ON credit_partner_referral
  FOR INSERT
  WITH CHECK (true);

-- =====================================================
-- 6. ENHANCE SMART ASSISTANT SUGGESTIONS
-- =====================================================

-- Drop and recreate with enhanced schema
DROP TABLE IF EXISTS smart_assistant_suggestions CASCADE;

CREATE TABLE IF NOT EXISTS smart_assistant_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES users(id) ON DELETE CASCADE,
  context_type TEXT CHECK (context_type IN ('lead', 'listing', 'transaction', 'calendar', 'inbox', 'dashboard', 'content')) NOT NULL,
  context_id UUID DEFAULT NULL,
  suggestion_type TEXT CHECK (suggestion_type IN ('explain', 'next_step', 'draft_message', 'create_task', 'launch_playbook', 'repurpose_content')) NOT NULL,
  label TEXT NOT NULL,
  description TEXT,
  action_payload JSONB DEFAULT '{}'::jsonb,
  status TEXT CHECK (status IN ('new', 'accepted', 'ignored', 'executed')) DEFAULT 'new',
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Indexes for smart_assistant_suggestions
CREATE INDEX IF NOT EXISTS idx_smart_suggestions_agent ON smart_assistant_suggestions(agent_id);
CREATE INDEX IF NOT EXISTS idx_smart_suggestions_status ON smart_assistant_suggestions(status);
CREATE INDEX IF NOT EXISTS idx_smart_suggestions_context ON smart_assistant_suggestions(context_type, context_id);
CREATE INDEX IF NOT EXISTS idx_smart_suggestions_created ON smart_assistant_suggestions(created_at DESC);

-- RLS for smart_assistant_suggestions
ALTER TABLE smart_assistant_suggestions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents see their own AI suggestions"
  ON smart_assistant_suggestions
  FOR ALL
  USING (agent_id = auth.uid() OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND user_type IN ('admin', 'broker')));

-- =====================================================
-- 7. ENHANCE TRANSACTION MILESTONES
-- =====================================================

-- Drop and recreate with enhanced schema
DROP TABLE IF EXISTS transaction_milestones CASCADE;

CREATE TABLE IF NOT EXISTS transaction_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
  buyer_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  milestone_type TEXT CHECK (milestone_type IN ('inspection', 'appraisal', 'loan_approval', 'title_clear', 'cd_out', 'closing')) NOT NULL,
  due_date DATE,
  status TEXT CHECK (status IN ('not_started', 'pending', 'completed', 'overdue')) DEFAULT 'not_started',
  responsible_party TEXT CHECK (responsible_party IN ('agent', 'tc', 'lender', 'title', 'buyer', 'seller')) DEFAULT 'agent',
  notes TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Indexes for transaction_milestones
CREATE INDEX IF NOT EXISTS idx_milestones_transaction ON transaction_milestones(transaction_id);
CREATE INDEX IF NOT EXISTS idx_milestones_listing ON transaction_milestones(listing_id);
CREATE INDEX IF NOT EXISTS idx_milestones_status ON transaction_milestones(status);
CREATE INDEX IF NOT EXISTS idx_milestones_due_date ON transaction_milestones(due_date);

-- RLS for transaction_milestones
ALTER TABLE transaction_milestones ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents see milestones for their transactions"
  ON transaction_milestones
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM transactions 
      WHERE transactions.id = transaction_milestones.transaction_id 
      AND (transactions.agent_id = auth.uid() OR EXISTS (SELECT 1 FROM users WHERE id = auth.uid() AND user_type IN ('admin', 'broker', 'TC')))
    )
  );

-- =====================================================
-- 8. TRIGGER FOR UPDATED_AT
-- =====================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at triggers to all relevant tables
CREATE TRIGGER update_credit_settings_updated_at BEFORE UPDATE ON credit_settings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_credit_partner_mapping_updated_at BEFORE UPDATE ON credit_partner_mapping FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_credit_partner_referral_updated_at BEFORE UPDATE ON credit_partner_referral FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_smart_assistant_suggestions_updated_at BEFORE UPDATE ON smart_assistant_suggestions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_transaction_milestones_updated_at BEFORE UPDATE ON transaction_milestones FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- 9. SEED DATA
-- =====================================================

-- Seed default credit settings (if user has a broker role)
-- INSERT INTO credit_settings (brokerage_id, credit_score_threshold, max_outreach_per_week, max_outreach_per_month, disclosure_snippet)
-- SELECT id, 580, 10, 40, 'We may refer you to a credit repair partner. CROA/TSR compliance notice...'
-- FROM users WHERE user_type = 'broker' LIMIT 1
-- ON CONFLICT (brokerage_id) DO NOTHING;

-- =====================================================
-- END OF MIGRATION
-- =====================================================
