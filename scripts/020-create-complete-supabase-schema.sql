-- Comprehensive Supabase Schema Migration
-- Run this script in your Supabase SQL Editor to create all tables

-- Drop existing tables if needed (uncomment for clean slate)
-- DROP TABLE IF EXISTS video_engagement_events CASCADE;
-- DROP TABLE IF EXISTS credit_partner_referrals CASCADE;
-- ... (add all tables)

-- =====================================================
-- CORE ENTITIES
-- =====================================================

-- Users table (already exists, but ensuring it has all fields)
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  user_type TEXT NOT NULL CHECK (user_type IN ('broker', 'admin', 'agent', 'vendor', 'lender', 'TC', 'compliance_officer', 'contact')),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  brokerage TEXT,
  role TEXT,
  phone TEXT,
  created_by UUID REFERENCES users(id),
  is_contact BOOLEAN DEFAULT false,
  contact_type TEXT,
  contact_persona TEXT,
  username TEXT UNIQUE,
  password_hash TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  deleted_at TIMESTAMP
);

-- Contacts table (enhanced version)
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_contact_id TEXT UNIQUE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  contact_type TEXT CHECK (contact_type IN ('buyer', 'seller', 'both', 'investor', 'vendor', 'lender')),
  contact_persona TEXT,
  status TEXT DEFAULT 'new',
  timeline TEXT,
  source TEXT,
  notes TEXT,
  agent_id UUID REFERENCES users(id),
  engagement_score INTEGER DEFAULT 0,
  intent_score INTEGER DEFAULT 0,
  dnc_status BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  deleted_at TIMESTAMP
);

-- Transactions (Deals)
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_name TEXT NOT NULL,
  client_name TEXT,
  contact_id UUID REFERENCES contacts(id),
  agent_id UUID REFERENCES users(id),
  status TEXT CHECK (status IN ('lead', 'qualifying', 'active', 'under_contract', 'closing', 'closed', 'lost')),
  deal_type TEXT CHECK (deal_type IN ('buyer', 'seller', 'dual')),
  property_address TEXT,
  purchase_price DECIMAL,
  commission_percentage DECIMAL,
  estimated_commission DECIMAL,
  close_date DATE,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  deleted_at TIMESTAMP
);

-- Listings
CREATE TABLE IF NOT EXISTS listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mls_number TEXT,
  address TEXT NOT NULL,
  city TEXT,
  state TEXT,
  zip TEXT,
  agent_id UUID REFERENCES users(id),
  seller_contact_id UUID REFERENCES contacts(id),
  list_price DECIMAL,
  bedrooms INTEGER,
  bathrooms DECIMAL,
  sqft INTEGER,
  status TEXT CHECK (status IN ('coming_soon', 'active', 'pending', 'sold', 'expired', 'withdrawn')),
  listing_date DATE,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  deleted_at TIMESTAMP
);

-- Vendors
CREATE TABLE IF NOT EXISTS vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  category TEXT CHECK (category IN ('Lender', 'Inspector', 'Title Company', 'Contractor', 'Stager', 'Other')),
  email TEXT,
  phone TEXT,
  website TEXT,
  rating DECIMAL CHECK (rating >= 0 AND rating <= 5),
  notes TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- =====================================================
-- CRM & RELATIONSHIP MANAGEMENT
-- =====================================================

-- Copilot Plans (already created)
CREATE TABLE IF NOT EXISTS copilot_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  plan_name TEXT NOT NULL,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed')),
  next_action TEXT,
  next_action_date DATE,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Plan Tasks
CREATE TABLE IF NOT EXISTS plan_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id UUID REFERENCES copilot_plans(id) ON DELETE CASCADE,
  task_description TEXT NOT NULL,
  due_date DATE,
  completed BOOLEAN DEFAULT false,
  completed_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT now()
);

-- Deal Team Members
CREATE TABLE IF NOT EXISTS deal_team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  member_type TEXT CHECK (member_type IN ('agent', 'lender', 'title', 'inspector', 'other')),
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  company TEXT,
  created_at TIMESTAMP DEFAULT now()
);

-- AI ISA Activities
CREATE TABLE IF NOT EXISTS ai_isa_activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  activity_type TEXT CHECK (activity_type IN ('call', 'email', 'text', 'appointment_set', 'follow_up')),
  summary TEXT,
  outcome TEXT,
  created_at TIMESTAMP DEFAULT now()
);

-- =====================================================
-- JOURNEY & EXPERIENCE
-- =====================================================

-- Journey States
CREATE TABLE IF NOT EXISTS journey_states (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL UNIQUE,
  persona TEXT NOT NULL,
  contact_id UUID REFERENCES contacts(id),
  listing_id UUID REFERENCES listings(id),
  deal_id UUID REFERENCES transactions(id),
  current_stage TEXT NOT NULL,
  metadata_json TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Journey Blueprints
CREATE TABLE IF NOT EXISTS journey_blueprints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  persona TEXT NOT NULL,
  stage TEXT NOT NULL,
  cards_json TEXT,
  actions_json TEXT,
  tools_enabled TEXT[],
  transparency_videos_enabled BOOLEAN DEFAULT true,
  team_visibility_enabled BOOLEAN DEFAULT true,
  priority_order INTEGER,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT now()
);

-- Journey Tools
CREATE TABLE IF NOT EXISTS journey_tools (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name TEXT NOT NULL,
  persona TEXT[],
  stage TEXT[],
  tool_type TEXT,
  configuration_json TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT now()
);

-- Saved Properties
CREATE TABLE IF NOT EXISTS saved_properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  listing_id UUID REFERENCES listings(id),
  notes TEXT,
  saved_at TIMESTAMP DEFAULT now()
);

-- Real Estate Events
CREATE TABLE IF NOT EXISTS real_estate_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id),
  event_type TEXT,
  event_title TEXT NOT NULL,
  event_date TIMESTAMP NOT NULL,
  location TEXT,
  description TEXT,
  created_at TIMESTAMP DEFAULT now()
);

-- =====================================================
-- TRANSPARENCY & UPDATES
-- =====================================================

-- Transparency Updates
CREATE TABLE IF NOT EXISTS transparency_updates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  transaction_id UUID REFERENCES transactions(id),
  title TEXT NOT NULL,
  plain_language_summary TEXT,
  stage TEXT,
  responsible_party TEXT,
  responsible_party_name TEXT,
  communication_links_json TEXT,
  next_step TEXT,
  next_step_date DATE,
  transparency_video_id UUID,
  created_at TIMESTAMP DEFAULT now()
);

-- Transparency Videos
CREATE TABLE IF NOT EXISTS transparency_videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_url TEXT NOT NULL,
  thumbnail_url TEXT,
  duration_seconds INTEGER,
  title TEXT,
  description TEXT,
  created_at TIMESTAMP DEFAULT now()
);

-- =====================================================
-- CONTENT & MARKETING
-- =====================================================

-- Scripts
CREATE TABLE IF NOT EXISTS scripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  category TEXT,
  content TEXT NOT NULL,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'archived')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Video Assets
CREATE TABLE IF NOT EXISTS video_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  video_url TEXT NOT NULL,
  thumbnail_url TEXT,
  category TEXT,
  tags TEXT[],
  duration_seconds INTEGER,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT now()
);

-- Content Ideas
CREATE TABLE IF NOT EXISTS content_ideas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  content_type TEXT,
  status TEXT DEFAULT 'idea' CHECK (status IN ('idea', 'in_progress', 'published')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT now()
);

-- Keywords
CREATE TABLE IF NOT EXISTS keywords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword TEXT NOT NULL,
  search_volume INTEGER,
  competition TEXT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT now()
);

-- Long Form Videos
CREATE TABLE IF NOT EXISTS long_form_videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  video_url TEXT,
  script_id UUID REFERENCES scripts(id),
  status TEXT DEFAULT 'planning' CHECK (status IN ('planning', 'recording', 'editing', 'published')),
  created_at TIMESTAMP DEFAULT now(),
  published_at TIMESTAMP
);

-- Newsletter Campaigns
CREATE TABLE IF NOT EXISTS newsletter_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_name TEXT NOT NULL,
  subject_line TEXT,
  content TEXT,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'sent')),
  send_date TIMESTAMP,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT now()
);

-- Direct Mail Campaigns
CREATE TABLE IF NOT EXISTS direct_mail_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_name TEXT NOT NULL,
  target_audience TEXT,
  design_url TEXT,
  quantity INTEGER,
  status TEXT DEFAULT 'planning' CHECK (status IN ('planning', 'approved', 'printed', 'mailed')),
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT now()
);

-- =====================================================
-- ENGAGEMENT & ANALYTICS
-- =====================================================

-- Video Engagement Events (already created)
CREATE TABLE IF NOT EXISTS video_engagement_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  video_asset_id UUID REFERENCES video_assets(id),
  event_type TEXT CHECK (event_type IN ('view', 'pause', 'complete')),
  timestamp TIMESTAMP DEFAULT now(),
  watch_duration_seconds INTEGER
);

-- Listing Metrics
CREATE TABLE IF NOT EXISTS listing_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  views INTEGER DEFAULT 0,
  saves INTEGER DEFAULT 0,
  inquiries INTEGER DEFAULT 0,
  showings INTEGER DEFAULT 0,
  created_at TIMESTAMP DEFAULT now()
);

-- Listing Engagement
CREATE TABLE IF NOT EXISTS listing_engagement (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id),
  engagement_type TEXT CHECK (engagement_type IN ('view', 'save', 'inquiry', 'showing')),
  created_at TIMESTAMP DEFAULT now()
);

-- =====================================================
-- FINANCIAL
-- =====================================================

-- Commissions
CREATE TABLE IF NOT EXISTS commissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES users(id),
  gross_commission DECIMAL NOT NULL,
  split_percentage DECIMAL,
  agent_commission DECIMAL,
  brokerage_split DECIMAL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'disputed')),
  paid_date DATE,
  created_at TIMESTAMP DEFAULT now()
);

-- Commission Calculations
CREATE TABLE IF NOT EXISTS commission_calculations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id),
  calculation_details_json TEXT,
  total_commission DECIMAL,
  calculated_at TIMESTAMP DEFAULT now()
);

-- Business Expenses
CREATE TABLE IF NOT EXISTS business_expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES users(id),
  category TEXT,
  description TEXT NOT NULL,
  amount DECIMAL NOT NULL,
  expense_date DATE NOT NULL,
  receipt_url TEXT,
  created_at TIMESTAMP DEFAULT now()
);

-- Marketing Stats
CREATE TABLE IF NOT EXISTS marketing_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel TEXT NOT NULL,
  date DATE NOT NULL,
  impressions INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  spend DECIMAL DEFAULT 0,
  created_at TIMESTAMP DEFAULT now()
);

-- =====================================================
-- CREDIT & COMPLIANCE
-- =====================================================

-- Credit Status (already created)
CREATE TABLE IF NOT EXISTS credit_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  credit_score INTEGER,
  debt_to_income DECIMAL,
  notes TEXT,
  last_updated TIMESTAMP DEFAULT now()
);

-- Credit Conversation Logs
CREATE TABLE IF NOT EXISTS credit_conversation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  log_entry TEXT NOT NULL,
  sentiment TEXT,
  created_at TIMESTAMP DEFAULT now()
);

-- Credit Partner Referrals
CREATE TABLE IF NOT EXISTS credit_partner_referrals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id),
  partner_name TEXT,
  referral_date DATE,
  status TEXT CHECK (status IN ('referred', 'in_progress', 'completed', 'declined')),
  notes TEXT,
  created_at TIMESTAMP DEFAULT now()
);

-- Compliance Flags
CREATE TABLE IF NOT EXISTS compliance_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  content_type TEXT,
  flagged_content TEXT,
  violation_type TEXT,
  severity TEXT,
  status TEXT DEFAULT 'flagged' CHECK (status IN ('flagged', 'reviewed', 'resolved', 'overridden')),
  resolution_notes TEXT,
  created_at TIMESTAMP DEFAULT now(),
  resolved_at TIMESTAMP
);

-- =====================================================
-- AI & AUTOMATION
-- =====================================================

-- AI Tool Usage
CREATE TABLE IF NOT EXISTS ai_tool_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  tool_name TEXT NOT NULL,
  input_text TEXT,
  output_text TEXT,
  context_json TEXT,
  tokens_used INTEGER,
  model_used TEXT,
  created_at TIMESTAMP DEFAULT now()
);

-- Saved AI Output
CREATE TABLE IF NOT EXISTS saved_ai_outputs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  tool_name TEXT,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  tags TEXT[],
  created_at TIMESTAMP DEFAULT now()
);

-- AI Prompt Templates
CREATE TABLE IF NOT EXISTS ai_prompt_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_name TEXT NOT NULL,
  category TEXT,
  prompt_text TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT now()
);

-- Smart Assistant Suggestions
CREATE TABLE IF NOT EXISTS smart_assistant_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT,
  context_type TEXT,
  action_type TEXT,
  action_payload_json TEXT,
  priority TEXT CHECK (priority IN ('low', 'medium', 'high')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'executed', 'ignored')),
  created_at TIMESTAMP DEFAULT now()
);

-- Automation Errors
CREATE TABLE IF NOT EXISTS automation_errors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_name TEXT NOT NULL,
  error_message TEXT,
  context_json TEXT,
  severity TEXT,
  status TEXT DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved')),
  created_at TIMESTAMP DEFAULT now(),
  resolved_at TIMESTAMP
);

-- =====================================================
-- DOCUMENTS & MILESTONES
-- =====================================================

-- Client Documents
CREATE TABLE IF NOT EXISTS client_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id),
  transaction_id UUID REFERENCES transactions(id),
  document_name TEXT NOT NULL,
  document_url TEXT NOT NULL,
  document_type TEXT,
  uploaded_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT now()
);

-- Transaction Milestones
CREATE TABLE IF NOT EXISTS transaction_milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  milestone_name TEXT NOT NULL,
  milestone_date DATE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'overdue')),
  notes TEXT,
  created_at TIMESTAMP DEFAULT now()
);

-- Property Upgrades
CREATE TABLE IF NOT EXISTS property_upgrades (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  upgrade_description TEXT NOT NULL,
  estimated_cost DECIMAL,
  roi_estimate DECIMAL,
  status TEXT DEFAULT 'suggested' CHECK (status IN ('suggested', 'approved', 'completed', 'declined')),
  created_at TIMESTAMP DEFAULT now()
);

-- Property Interests
CREATE TABLE IF NOT EXISTS property_interests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  property_type TEXT,
  min_price DECIMAL,
  max_price DECIMAL,
  preferred_locations TEXT[],
  bedrooms INTEGER,
  bathrooms DECIMAL,
  notes TEXT,
  created_at TIMESTAMP DEFAULT now()
);

-- =====================================================
-- ADMIN & ACTIVITY
-- =====================================================

-- User Activity
CREATE TABLE IF NOT EXISTS user_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  activity_type TEXT NOT NULL,
  description TEXT,
  metadata_json TEXT,
  created_at TIMESTAMP DEFAULT now()
);

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_contacts_agent_id ON contacts(agent_id);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_transactions_agent_id ON transactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
CREATE INDEX IF NOT EXISTS idx_listings_agent_id ON listings(agent_id);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_journey_states_user_id ON journey_states(user_id);
CREATE INDEX IF NOT EXISTS idx_video_engagement_contact_id ON video_engagement_events(contact_id);
CREATE INDEX IF NOT EXISTS idx_commissions_agent_id ON commissions(agent_id);

-- =====================================================
-- TRIGGERS FOR UPDATED_AT
-- =====================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ language 'plpgsql';

CREATE TRIGGER update_contacts_updated_at BEFORE UPDATE ON contacts FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_transactions_updated_at BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_listings_updated_at BEFORE UPDATE ON listings FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_journey_states_updated_at BEFORE UPDATE ON journey_states FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- ROW LEVEL SECURITY (RLS)
-- =====================================================

ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE commissions ENABLE ROW LEVEL SECURITY;

-- Agents can only see their own contacts
CREATE POLICY agent_contacts_policy ON contacts
  FOR ALL
  USING (agent_id = auth.uid() OR auth.uid() IN (SELECT id FROM users WHERE user_type IN ('admin', 'broker')));

-- Agents can only see their own transactions
CREATE POLICY agent_transactions_policy ON transactions
  FOR ALL
  USING (agent_id = auth.uid() OR auth.uid() IN (SELECT id FROM users WHERE user_type IN ('admin', 'broker')));

-- Agents can only see their own listings
CREATE POLICY agent_listings_policy ON listings
  FOR ALL
  USING (agent_id = auth.uid() OR auth.uid() IN (SELECT id FROM users WHERE user_type IN ('admin', 'broker')));

-- Agents can only see their own commissions
CREATE POLICY agent_commissions_policy ON commissions
  FOR ALL
  USING (agent_id = auth.uid() OR auth.uid() IN (SELECT id FROM users WHERE user_type IN ('admin', 'broker')));
