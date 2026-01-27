-- ============================================================================
-- COMPLETE DEFINITIVE SCHEMA FOR REAL ESTATE AI CRM
-- ============================================================================
-- This migration creates all tables from the specification
-- Uses CREATE TABLE IF NOT EXISTS to be idempotent
-- Run this to ensure your database has all required tables

-- Enable extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============================================================================
-- CORE ENTITIES
-- ============================================================================

-- Brokerages
CREATE TABLE IF NOT EXISTS brokerages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  logo_url TEXT,
  phone TEXT,
  email TEXT,
  address JSONB,
  license_number TEXT,
  settings JSONB,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Profiles (Agents/Users)
CREATE TABLE IF NOT EXISTS profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id),
  brokerage_id UUID REFERENCES brokerages(id),
  email TEXT UNIQUE NOT NULL,
  first_name TEXT,
  last_name TEXT,
  phone TEXT,
  avatar_url TEXT,
  role TEXT NOT NULL DEFAULT 'agent', -- super_admin, broker, team_lead, agent, coordinator
  ghl_phone_number TEXT,
  ghl_user_id TEXT,
  license_number TEXT,
  bio TEXT,
  settings JSONB,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Adding personas table before contacts since contacts references it
-- Personas
CREATE TABLE IF NOT EXISTS personas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  pain_points JSONB,
  goals JSONB,
  typical_timeline_days INTEGER,
  icon TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Contacts
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES profiles(id),
  brokerage_id UUID REFERENCES brokerages(id),
  ghl_contact_id TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  source TEXT, -- website, zillow, referral, etc.
  status TEXT DEFAULT 'lead', -- lead, nurture, active, past_client
  stage TEXT, -- pre_qualified, searching, under_contract, closed
  persona_id UUID REFERENCES personas(id),
  budget_min INTEGER,
  budget_max INTEGER,
  timeline TEXT, -- asap, 3_months, 6_months, exploring
  lead_score INTEGER DEFAULT 0,
  lead_temperature TEXT, -- hot, warm, cold
  enriched BOOLEAN DEFAULT false,
  last_enriched_at TIMESTAMPTZ,
  tags JSONB,
  custom_fields JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Listings
CREATE TABLE IF NOT EXISTS listings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES profiles(id),
  brokerage_id UUID REFERENCES brokerages(id),
  seller_id UUID REFERENCES contacts(id),
  idx_listing_id TEXT, -- if from IDX
  mls_number TEXT,
  address TEXT NOT NULL,
  city TEXT,
  state TEXT,
  zip TEXT,
  price INTEGER NOT NULL,
  bedrooms INTEGER,
  bathrooms DECIMAL(3,1),
  square_feet INTEGER,
  lot_size_acres DECIMAL(10,2),
  property_type TEXT,
  status TEXT DEFAULT 'draft', -- draft, coming_soon, active, pending, sold, cancelled
  listing_date DATE,
  sold_date DATE,
  photos JSONB,
  description TEXT,
  features JSONB,
  current_stage TEXT, -- pre_listing, coming_soon, active, under_contract, pending, closed
  stage_history JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Transactions
CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES profiles(id),
  brokerage_id UUID REFERENCES brokerages(id),
  listing_id UUID REFERENCES listings(id),
  buyer_id UUID REFERENCES contacts(id),
  seller_id UUID REFERENCES contacts(id),
  transaction_type TEXT NOT NULL, -- buyer_side, seller_side, dual
  status TEXT DEFAULT 'pending', -- pending, under_contract, contingent, pending, closed, cancelled
  property_address TEXT NOT NULL,
  purchase_price INTEGER,
  contract_date DATE,
  estimated_close_date DATE,
  actual_close_date DATE,
  commission_total INTEGER,
  commission_split JSONB,
  dotloop_loop_id TEXT,
  notes TEXT,
  custom_fields JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Tasks
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assigned_to UUID REFERENCES profiles(id),
  created_by UUID REFERENCES profiles(id),
  contact_id UUID REFERENCES contacts(id),
  transaction_id UUID REFERENCES transactions(id),
  listing_id UUID REFERENCES listings(id),
  title TEXT NOT NULL,
  description TEXT,
  due_date TIMESTAMPTZ,
  priority TEXT DEFAULT 'medium', -- low, medium, high, urgent
  status TEXT DEFAULT 'pending', -- pending, in_progress, completed, cancelled
  completed_at TIMESTAMPTZ,
  auto_generated BOOLEAN DEFAULT false,
  source_type TEXT, -- call, email, showing, ai_suggestion
  source_id UUID,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Communications
CREATE TABLE IF NOT EXISTS communications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id),
  agent_id UUID REFERENCES profiles(id),
  direction TEXT NOT NULL, -- inbound, outbound
  channel TEXT NOT NULL, -- sms, email, call, in_person
  subject TEXT,
  body TEXT,
  ghl_message_id TEXT,
  read_at TIMESTAMPTZ,
  replied_at TIMESTAMPTZ,
  sentiment_score DECIMAL(3,2),
  them_first_score DECIMAL(3,2),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- SERVICES & AI AGENTS
-- ============================================================================

-- Services Registry
CREATE TABLE IF NOT EXISTS services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_name TEXT NOT NULL,
  service_type TEXT, -- external_api, internal, workflow
  provider TEXT, -- ghl, heygen, idx_broker, dotloop
  api_endpoint TEXT,
  auth_type TEXT, -- api_key, oauth, bearer
  config JSONB,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- AI Agents
CREATE TABLE IF NOT EXISTS ai_agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_name TEXT NOT NULL,
  agent_type TEXT, -- copilot, assistant, content_creator, analyst
  system_prompt TEXT,
  model TEXT DEFAULT 'gpt-4',
  temperature DECIMAL(3,2) DEFAULT 0.7,
  capabilities JSONB,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Playbooks
CREATE TABLE IF NOT EXISTS playbooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  playbook_name TEXT NOT NULL,
  trigger_type TEXT, -- manual, stage_change, date_based, event
  steps JSONB,
  target_persona_ids JSONB,
  active BOOLEAN DEFAULT true,
  usage_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Stage Rules
CREATE TABLE IF NOT EXISTS stage_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL, -- listing, transaction, contact
  from_stage TEXT NOT NULL,
  to_stage TEXT NOT NULL,
  required_conditions JSONB,
  auto_transition BOOLEAN DEFAULT false,
  actions_on_transition JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- LISTING LIFECYCLE
-- ============================================================================

-- Listing Stages (17+ stages)
CREATE TABLE IF NOT EXISTS listing_stages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stage_name TEXT NOT NULL UNIQUE,
  stage_order INTEGER NOT NULL,
  description TEXT,
  typical_duration_days INTEGER,
  required_tasks JSONB,
  auto_actions JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Listing Stage History
CREATE TABLE IF NOT EXISTS listing_stage_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES listings(id),
  stage_name TEXT NOT NULL,
  entered_at TIMESTAMPTZ DEFAULT now(),
  exited_at TIMESTAMPTZ,
  duration_days INTEGER,
  completed_by UUID REFERENCES profiles(id),
  notes TEXT
);

-- Closing Gifts
CREATE TABLE IF NOT EXISTS closing_gifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id),
  gift_description TEXT,
  price_cents INTEGER,
  vendor TEXT,
  order_status TEXT DEFAULT 'pending', -- pending, ordered, delivered
  ordered_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  tracking_number TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Review Requests
CREATE TABLE IF NOT EXISTS review_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id),
  contact_id UUID REFERENCES contacts(id),
  request_sent_at TIMESTAMPTZ,
  reminder_sent_at TIMESTAMPTZ,
  review_received BOOLEAN DEFAULT false,
  review_platform TEXT, -- google, zillow, facebook
  review_rating INTEGER,
  review_text TEXT,
  review_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- VIDEO & CONTENT STUDIO
-- ============================================================================

-- Video Scripts
CREATE TABLE IF NOT EXISTS video_scripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id),
  agent_id UUID REFERENCES profiles(id),
  script_text TEXT NOT NULL,
  script_purpose TEXT,
  them_first_score DECIMAL(3,2),
  sentiment_score DECIMAL(3,2),
  approval_status TEXT DEFAULT 'pending', -- pending, approved, rejected
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Generated Videos
CREATE TABLE IF NOT EXISTS generated_videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  script_id UUID REFERENCES video_scripts(id),
  heygen_video_id TEXT,
  video_url TEXT,
  thumbnail_url TEXT,
  duration_seconds INTEGER,
  status TEXT DEFAULT 'processing', -- processing, ready, failed
  sent_to_contact BOOLEAN DEFAULT false,
  view_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Content Ideas
CREATE TABLE IF NOT EXISTS content_ideas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES profiles(id),
  idea_text TEXT NOT NULL,
  content_type TEXT, -- video, social_post, email, blog
  target_persona_ids JSONB,
  ai_generated BOOLEAN DEFAULT false,
  used BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Keywords
CREATE TABLE IF NOT EXISTS keywords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword TEXT NOT NULL,
  search_volume INTEGER,
  competition TEXT, -- low, medium, high
  relevance_score DECIMAL(3,2),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Competitor Content
CREATE TABLE IF NOT EXISTS competitor_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competitor_name TEXT,
  content_url TEXT,
  content_type TEXT,
  content_summary TEXT,
  engagement_metrics JSONB,
  ai_analysis TEXT,
  scraped_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- CREDIT COPILOT
-- ============================================================================

-- Credit Accounts
CREATE TABLE IF NOT EXISTS credit_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id),
  partner_name TEXT,
  account_status TEXT, -- lead, application, approved, funded, closed
  credit_amount INTEGER,
  current_stage TEXT, -- flow_a, flow_b, flow_c, flow_d, flow_e
  stage_history JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Credit Partners
CREATE TABLE IF NOT EXISTS credit_partners (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partner_name TEXT NOT NULL,
  partner_type TEXT, -- lender, credit_repair, etc.
  api_endpoint TEXT,
  webhook_url TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- ACADEMY & MARKETPLACE
-- ============================================================================

-- Learning Resources
CREATE TABLE IF NOT EXISTS learning_resources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  resource_type TEXT, -- video, guide, sop, template
  content_url TEXT,
  thumbnail_url TEXT,
  author_id UUID REFERENCES profiles(id),
  upvotes INTEGER DEFAULT 0,
  downloads INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Template Marketplace
CREATE TABLE IF NOT EXISTS template_marketplace (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_name TEXT NOT NULL,
  template_type TEXT, -- playbook, email_sequence, script
  template_data JSONB,
  price_cents INTEGER DEFAULT 0,
  author_id UUID REFERENCES profiles(id),
  purchases INTEGER DEFAULT 0,
  rating DECIMAL(3,2),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- OFFER MANAGEMENT
-- ============================================================================

-- Adding offers, offer_counters, and offer_analysis tables
-- Offers
CREATE TABLE IF NOT EXISTS offers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id),
  listing_id UUID REFERENCES listings(id),
  buyer_id UUID REFERENCES contacts(id),
  offer_amount INTEGER NOT NULL,
  earnest_money INTEGER,
  down_payment_percent DECIMAL(5,2),
  financing_type TEXT, -- conventional, fha, va, cash
  contingencies JSONB,
  close_date DATE,
  status TEXT DEFAULT 'pending', -- pending, accepted, countered, rejected, expired
  submitted_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Offer Counters
CREATE TABLE IF NOT EXISTS offer_counters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id UUID REFERENCES offers(id),
  counter_number INTEGER NOT NULL,
  countered_by TEXT, -- buyer, seller
  counter_amount INTEGER,
  counter_terms JSONB,
  status TEXT DEFAULT 'pending',
  submitted_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Offer Analysis (AI)
CREATE TABLE IF NOT EXISTS offer_analysis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  offer_id UUID REFERENCES offers(id),
  analysis_type TEXT, -- single, multiple_comparison
  ai_recommendation TEXT,
  net_to_seller INTEGER,
  strength_score INTEGER, -- 0-100
  risk_factors JSONB,
  advantages JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- SEED DATA
-- ============================================================================

-- Seed persona data if not already exists
INSERT INTO personas (name, description, pain_points, goals, typical_timeline_days, icon)
SELECT * FROM (VALUES
  ('First-Time Buyer', 'New to homeownership', '["Mortgage confusion", "Fear of overpaying", "Down payment concerns"]'::jsonb, '["Find affordable home", "Navigate process", "Build equity"]'::jsonb, 90, '🏠'),
  ('Military Buyer/Seller', 'Active duty or veteran', '["PCS timeline pressure", "VA loan questions", "Frequent relocations"]'::jsonb, '["Quick transaction", "Base proximity", "VA benefits usage"]'::jsonb, 60, '🎖️'),
  ('Move-Up Buyer', 'Upgrading from starter home', '["Selling current home", "Timing coordination", "Budget stretching"]'::jsonb, '["More space", "Better location", "Equity growth"]'::jsonb, 120, '📈'),
  ('Downsizer', 'Empty nesters or retirees', '["Decluttering stress", "Emotional attachment", "Right-sizing"]'::jsonb, '["Less maintenance", "Unlock equity", "Simplify life"]'::jsonb, 150, '🏡'),
  ('Investor', 'Real estate investor', '["ROI uncertainty", "Cash flow analysis", "Market timing"]'::jsonb, '["Positive cash flow", "Appreciation", "Portfolio growth"]'::jsonb, 45, '💰'),
  ('Luxury Buyer', 'High-end market', '["Privacy concerns", "Quality expectations", "Customization needs"]'::jsonb, '["Exclusive property", "Premium amenities", "Status"]'::jsonb, 180, '💎'),
  ('Relocation', 'Moving for work', '["Unfamiliar market", "Timeline pressure", "Virtual touring"]'::jsonb, '["Fast close", "Learn area", "Smooth transition"]'::jsonb, 60, '📦'),
  ('Divorce/Estate Sale', 'Court-ordered or estate', '["Emotional stress", "Legal complexity", "Family coordination"]'::jsonb, '["Fair process", "Quick resolution", "Move forward"]'::jsonb, 120, '⚖️'),
  ('FSBO Conversion', 'For Sale By Owner', '["Skeptical of agents", "Cost concerns", "DIY mindset"]'::jsonb, '["Maximize profit", "Avoid hassles", "Professional guidance"]'::jsonb, 90, '🤝')
) AS v(name, description, pain_points, goals, typical_timeline_days, icon)
WHERE NOT EXISTS (SELECT 1 FROM personas WHERE personas.name = v.name);

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE brokerages ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications ENABLE ROW LEVEL SECURITY;
ALTER TABLE offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE offer_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE offer_analysis ENABLE ROW LEVEL SECURITY;

-- Basic RLS policy for contacts (users see own brokerage data)
CREATE POLICY IF NOT EXISTS "Users see own brokerage data"
ON contacts FOR SELECT
USING (brokerage_id = (SELECT brokerage_id FROM profiles WHERE id = auth.uid()));

-- Basic RLS policy for transactions
CREATE POLICY IF NOT EXISTS "Users see own brokerage transactions"
ON transactions FOR SELECT
USING (brokerage_id = (SELECT brokerage_id FROM profiles WHERE id = auth.uid()));

-- Basic RLS policy for listings
CREATE POLICY IF NOT EXISTS "Users see own brokerage listings"
ON listings FOR SELECT
USING (brokerage_id = (SELECT brokerage_id FROM profiles WHERE id = auth.uid()));

-- Basic RLS policy for offers
CREATE POLICY IF NOT EXISTS "Users see offers for their listings/transactions"
ON offers FOR SELECT
USING (
  listing_id IN (SELECT id FROM listings WHERE brokerage_id = (SELECT brokerage_id FROM profiles WHERE id = auth.uid()))
  OR
  transaction_id IN (SELECT id FROM transactions WHERE brokerage_id = (SELECT brokerage_id FROM profiles WHERE id = auth.uid()))
);

-- ============================================================================
-- INDEXES FOR COMMON QUERIES
-- ============================================================================

-- Contacts indexes
CREATE INDEX IF NOT EXISTS idx_contacts_brokerage_id ON contacts(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_contacts_agent_id ON contacts(agent_id);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_lead_temperature ON contacts(lead_temperature);

-- Listings indexes
CREATE INDEX IF NOT EXISTS idx_listings_brokerage_id ON listings(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_listings_agent_id ON listings(agent_id);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status);
CREATE INDEX IF NOT EXISTS idx_listings_current_stage ON listings(current_stage);

-- Transactions indexes
CREATE INDEX IF NOT EXISTS idx_transactions_brokerage_id ON transactions(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_transactions_agent_id ON transactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);

-- Offers indexes
CREATE INDEX IF NOT EXISTS idx_offers_listing_id ON offers(listing_id);
CREATE INDEX IF NOT EXISTS idx_offers_transaction_id ON offers(transaction_id);
CREATE INDEX IF NOT EXISTS idx_offers_status ON offers(status);

-- Tasks indexes
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);

-- Communications indexes
CREATE INDEX IF NOT EXISTS idx_communications_contact_id ON communications(contact_id);
CREATE INDEX IF NOT EXISTS idx_communications_agent_id ON communications(agent_id);
CREATE INDEX IF NOT EXISTS idx_communications_created_at ON communications(created_at DESC);
