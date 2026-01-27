-- Past Client Touchpoint & Referral Management System
-- This schema supports lifetime client relationship management

-- Past Client Touchpoints Table
CREATE TABLE IF NOT EXISTS past_client_touchpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  touchpoint_type TEXT NOT NULL CHECK (touchpoint_type IN (
    'post_close_3_day', 'post_close_30_day', 'post_close_6_month',
    'home_anniversary', 'birthday', 'quarterly_market_report',
    'referral_request', 'holiday_greeting', 'maintenance_tips', 'custom'
  )),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'phone', 'video', 'card', 'in_person')),
  scheduled_date DATE NOT NULL,
  sent_at TIMESTAMP,
  message_template TEXT,
  personalization_data JSONB DEFAULT '{}',
  status TEXT DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'sent', 'failed', 'skipped')),
  engagement_data JSONB DEFAULT '{}', -- opened, clicked, replied
  related_transaction_id UUID REFERENCES transactions(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Referrals Table
CREATE TABLE IF NOT EXISTS referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referring_contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  referred_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  source TEXT NOT NULL DEFAULT 'past_client', -- past_client, sphere, partner, online, other
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN (
    'new', 'contacted', 'qualified', 'under_contract', 'closed', 'declined', 'lost'
  )),
  referred_name TEXT,
  referred_phone TEXT,
  referred_email TEXT,
  referral_date DATE NOT NULL DEFAULT CURRENT_DATE,
  contacted_date DATE,
  qualified_date DATE,
  contract_date DATE,
  closed_date DATE,
  transaction_id UUID REFERENCES transactions(id),
  potential_value DECIMAL(12,2),
  actual_value DECIMAL(12,2),
  reward_tier TEXT CHECK (reward_tier IN ('contacted', 'qualified', 'under_contract', 'closed')),
  reward_sent_date DATE,
  reward_description TEXT,
  thank_you_sent BOOLEAN DEFAULT false,
  thank_you_sent_date DATE,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Referral Partners Table (agents/businesses who send referrals)
CREATE TABLE IF NOT EXISTS referral_partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  partner_name TEXT NOT NULL,
  partner_type TEXT NOT NULL CHECK (partner_type IN (
    'real_estate_agent', 'mortgage_broker', 'title_company', 'home_inspector',
    'contractor', 'insurance_agent', 'attorney', 'property_manager', 'other'
  )),
  company_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  agreement_type TEXT CHECK (agreement_type IN ('reciprocal', 'one_way', 'paid', 'informal')),
  commission_split_percentage DECIMAL(5,2),
  referral_fee_flat DECIMAL(10,2),
  agreement_date DATE,
  agreement_end_date DATE,
  active BOOLEAN DEFAULT true,
  total_referrals_sent INT DEFAULT 0,
  total_referrals_received INT DEFAULT 0,
  total_value_generated DECIMAL(12,2) DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Client Engagement Scores (calculated from touchpoint engagement)
CREATE TABLE IF NOT EXISTS client_engagement_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE UNIQUE,
  agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  engagement_score INT DEFAULT 0 CHECK (engagement_score >= 0 AND engagement_score <= 100),
  referral_potential_score INT DEFAULT 0 CHECK (referral_potential_score >= 0 AND referral_potential_score <= 100),
  last_touchpoint_date DATE,
  total_touchpoints INT DEFAULT 0,
  touchpoints_responded INT DEFAULT 0,
  response_rate DECIMAL(5,2) DEFAULT 0,
  referrals_given INT DEFAULT 0,
  last_calculated_at TIMESTAMP DEFAULT NOW(),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_touchpoints_scheduled ON past_client_touchpoints(scheduled_date, status);
CREATE INDEX IF NOT EXISTS idx_touchpoints_contact ON past_client_touchpoints(contact_id);
CREATE INDEX IF NOT EXISTS idx_touchpoints_agent ON past_client_touchpoints(agent_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referring ON referrals(referring_contact_id);
CREATE INDEX IF NOT EXISTS idx_referrals_referred ON referrals(referred_contact_id);
CREATE INDEX IF NOT EXISTS idx_referrals_agent ON referrals(agent_id);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals(status);
CREATE INDEX IF NOT EXISTS idx_partners_agent ON referral_partners(agent_id);
CREATE INDEX IF NOT EXISTS idx_engagement_contact ON client_engagement_scores(contact_id);

-- RLS Policies
ALTER TABLE past_client_touchpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE referrals ENABLE ROW LEVEL SECURITY;
ALTER TABLE referral_partners ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_engagement_scores ENABLE ROW LEVEL SECURITY;

-- Agents see their own data
CREATE POLICY "Agents manage their touchpoints" ON past_client_touchpoints
  FOR ALL USING (agent_id = auth.uid());

CREATE POLICY "Agents manage their referrals" ON referrals
  FOR ALL USING (agent_id = auth.uid());

CREATE POLICY "Agents manage their partners" ON referral_partners
  FOR ALL USING (agent_id = auth.uid());

CREATE POLICY "Agents view their engagement scores" ON client_engagement_scores
  FOR SELECT USING (agent_id = auth.uid());

-- Automatic updated_at trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_touchpoints_updated_at BEFORE UPDATE ON past_client_touchpoints
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_referrals_updated_at BEFORE UPDATE ON referrals
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_partners_updated_at BEFORE UPDATE ON referral_partners
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER update_engagement_updated_at BEFORE UPDATE ON client_engagement_scores
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
