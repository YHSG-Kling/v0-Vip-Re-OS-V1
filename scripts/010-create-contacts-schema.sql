-- Complete Supabase Schema for Real Estate CRM
-- Run this in Supabase SQL Editor

-- Create contacts table
CREATE TABLE IF NOT EXISTS contacts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ghl_contact_id TEXT UNIQUE,
  
  -- Basic Info
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  
  -- Contact Classification
  contact_type TEXT CHECK (contact_type IN ('buyer', 'seller', 'both', 'investor', 'vendor', 'lender')),
  contact_persona TEXT CHECK (contact_persona IN ('first-time-buyer', 'move-up-buyer', 'downsizer', 'relocating', 'investor', 'luxury-buyer', 'motivated-seller', 'fsbo', 'expired', 'inherited', 'divorce', 'probate')),
  status TEXT DEFAULT 'new' CHECK (status IN ('new', 'contacted', 'nurturing', 'qualified', 'active', 'under-contract', 'closed', 'lost')),
  
  -- Timeline & Source
  timeline TEXT CHECK (timeline IN ('immediate', '1-3 months', '3-6 months', '6-12 months', '12+ months')),
  source TEXT,
  
  -- Agent Assignment
  agent_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id),
  
  -- Engagement Metrics
  engagement_score INTEGER DEFAULT 0,
  intent_score INTEGER DEFAULT 0,
  last_contact_date TIMESTAMP,
  next_followup_date TIMESTAMP,
  
  -- Notes & AI
  notes TEXT,
  ai_summary TEXT,
  ai_personality_tips TEXT,
  
  -- Authentication (for contact portal)
  has_login BOOLEAN DEFAULT false,
  contact_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  login_created_at TIMESTAMP,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  deleted_at TIMESTAMP
);

-- Create copilot plans table
CREATE TABLE IF NOT EXISTS copilot_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  
  -- Plan Details
  plan_type TEXT CHECK (plan_type IN ('nurture', 'conversion', 'retention', 'reactivation')),
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
  
  -- Timeline
  start_date TIMESTAMP DEFAULT now(),
  end_date TIMESTAMP,
  next_action_date TIMESTAMP,
  
  -- AI Generated Content
  recommended_actions JSONB,
  touchpoint_schedule JSONB,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Create video engagement table
CREATE TABLE IF NOT EXISTS video_engagement (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  
  -- Video Details
  video_id TEXT NOT NULL,
  video_title TEXT,
  video_url TEXT,
  thumbnail_url TEXT,
  
  -- Engagement Metrics
  views INTEGER DEFAULT 0,
  watch_time_seconds INTEGER DEFAULT 0,
  completion_rate DECIMAL(5,2),
  last_viewed_at TIMESTAMP,
  
  -- Heatmap Data
  engagement_heatmap JSONB,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Create property interests table
CREATE TABLE IF NOT EXISTS property_interests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  
  -- Property Preferences
  property_type TEXT,
  min_price DECIMAL(12,2),
  max_price DECIMAL(12,2),
  min_bedrooms INTEGER,
  max_bedrooms INTEGER,
  min_bathrooms DECIMAL(3,1),
  preferred_locations TEXT[],
  
  -- Search Criteria
  must_have_features TEXT[],
  nice_to_have_features TEXT[],
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Create credit status table
CREATE TABLE IF NOT EXISTS credit_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  
  -- Credit Information
  credit_score INTEGER,
  credit_range TEXT CHECK (credit_range IN ('excellent', 'good', 'fair', 'poor', 'unknown')),
  pre_approved BOOLEAN DEFAULT false,
  pre_approval_amount DECIMAL(12,2),
  lender_name TEXT,
  
  -- Timeline
  approval_date TIMESTAMP,
  expiration_date TIMESTAMP,
  
  -- Timestamps
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- Create interaction history table
CREATE TABLE IF NOT EXISTS interaction_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES users(id),
  
  -- Interaction Details
  interaction_type TEXT CHECK (interaction_type IN ('call', 'email', 'text', 'meeting', 'property-showing', 'video-call', 'note')),
  subject TEXT,
  notes TEXT,
  outcome TEXT,
  
  -- AI Analysis
  sentiment TEXT CHECK (sentiment IN ('positive', 'neutral', 'negative')),
  ai_summary TEXT,
  
  -- Timestamps
  interaction_date TIMESTAMP DEFAULT now(),
  created_at TIMESTAMP DEFAULT now()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_contacts_agent_id ON contacts(agent_id);
CREATE INDEX IF NOT EXISTS idx_contacts_status ON contacts(status);
CREATE INDEX IF NOT EXISTS idx_contacts_email ON contacts(email);
CREATE INDEX IF NOT EXISTS idx_contacts_deleted_at ON contacts(deleted_at);
CREATE INDEX IF NOT EXISTS idx_copilot_plans_contact_id ON copilot_plans(contact_id);
CREATE INDEX IF NOT EXISTS idx_video_engagement_contact_id ON video_engagement(contact_id);
CREATE INDEX IF NOT EXISTS idx_property_interests_contact_id ON property_interests(contact_id);
CREATE INDEX IF NOT EXISTS idx_credit_status_contact_id ON credit_status(contact_id);
CREATE INDEX IF NOT EXISTS idx_interaction_history_contact_id ON interaction_history(contact_id);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at triggers
CREATE TRIGGER update_contacts_updated_at BEFORE UPDATE ON contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_copilot_plans_updated_at BEFORE UPDATE ON copilot_plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_video_engagement_updated_at BEFORE UPDATE ON video_engagement
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_property_interests_updated_at BEFORE UPDATE ON property_interests
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_credit_status_updated_at BEFORE UPDATE ON credit_status
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Enable Row Level Security
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE copilot_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_engagement ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_interests ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_status ENABLE ROW LEVEL SECURITY;
ALTER TABLE interaction_history ENABLE ROW LEVEL SECURITY;

-- RLS Policies for contacts
CREATE POLICY "Agents can view their own contacts"
  ON contacts FOR SELECT
  USING (agent_id = auth.uid() OR created_by = auth.uid());

CREATE POLICY "Agents can insert contacts"
  ON contacts FOR INSERT
  WITH CHECK (true);

CREATE POLICY "Agents can update their own contacts"
  ON contacts FOR UPDATE
  USING (agent_id = auth.uid() OR created_by = auth.uid());

CREATE POLICY "Agents can delete their own contacts"
  ON contacts FOR DELETE
  USING (agent_id = auth.uid() OR created_by = auth.uid());

-- RLS Policies for related tables (copilot plans, video engagement, etc.)
CREATE POLICY "Users can view plans for their contacts"
  ON copilot_plans FOR SELECT
  USING (contact_id IN (SELECT id FROM contacts WHERE agent_id = auth.uid()));

CREATE POLICY "Users can view video engagement for their contacts"
  ON video_engagement FOR SELECT
  USING (contact_id IN (SELECT id FROM contacts WHERE agent_id = auth.uid()));

CREATE POLICY "Users can view property interests for their contacts"
  ON property_interests FOR SELECT
  USING (contact_id IN (SELECT id FROM contacts WHERE agent_id = auth.uid()));

CREATE POLICY "Users can view credit status for their contacts"
  ON credit_status FOR SELECT
  USING (contact_id IN (SELECT id FROM contacts WHERE agent_id = auth.uid()));

CREATE POLICY "Users can view interaction history for their contacts"
  ON interaction_history FOR SELECT
  USING (contact_id IN (SELECT id FROM contacts WHERE agent_id = auth.uid()));
