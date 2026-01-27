-- Marketing, Video Generation, and Content Creation Schema
-- Version: 1.0
-- This script creates tables for video generation, content creation, open houses,
-- social media, email campaigns, and listing marketing packages.

-- ============================================
-- PREREQUISITE TABLES (if not exist)
-- ============================================

-- Content Approvals (for compliance workflow)
CREATE TABLE IF NOT EXISTS content_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_type TEXT NOT NULL, -- 'video', 'email', 'social_post', 'listing_description', 'marketing_material'
  content_id UUID,
  content_text TEXT,
  submitted_by UUID,
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  status TEXT DEFAULT 'pending', -- 'pending', 'approved', 'rejected', 'revision_requested'
  rejection_reason TEXT,
  compliance_notes TEXT,
  brokerage_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Vendor Directory (for photographers, stagers, etc.)
CREATE TABLE IF NOT EXISTS vendor_directory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID,
  vendor_name TEXT NOT NULL,
  vendor_type TEXT NOT NULL, -- 'photographer', 'videographer', 'stager', 'inspector', 'title_company', 'lender', 'contractor'
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  zip TEXT,
  service_areas TEXT[],
  services_offered TEXT[],
  pricing_info JSONB,
  rating DECIMAL(3,2),
  review_count INTEGER DEFAULT 0,
  is_preferred BOOLEAN DEFAULT false,
  is_active BOOLEAN DEFAULT true,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- VIDEO GENERATION (HeyGen Integration)
-- ============================================

CREATE TABLE IF NOT EXISTS ai_video_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID,
  contact_id UUID,
  agent_id UUID,
  brokerage_id UUID,
  video_type TEXT NOT NULL, -- 'agent_introduction', 'market_update', 'listing_promo', 'buyer_guide', 'thank_you', 'memory_video', 'neighborhood_tour', 'testimonial'
  
  -- Script
  script_content TEXT NOT NULL,
  script_generated_by TEXT, -- 'ai', 'agent', 'template'
  them_first_score INTEGER,
  
  -- Video Configuration
  heygen_avatar_id TEXT,
  heygen_voice_id TEXT,
  background_setting TEXT,
  duration_seconds INTEGER,
  
  -- Personalization
  personalization_data JSONB, -- {name, city, specific_property, etc}
  target_persona TEXT,
  
  -- HeyGen API
  heygen_video_id TEXT,
  heygen_status TEXT DEFAULT 'pending', -- 'pending', 'generating', 'completed', 'failed'
  video_url TEXT,
  thumbnail_url TEXT,
  
  -- Compliance
  compliance_approved BOOLEAN DEFAULT false,
  approval_id UUID,
  
  -- Distribution
  distributed_via TEXT[], -- 'email', 'social', 'website', 'portal'
  view_count INTEGER DEFAULT 0,
  engagement_rate DECIMAL(5,2),
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- ============================================
-- CONTENT CREATION PROJECTS
-- ============================================

CREATE TABLE IF NOT EXISTS content_creation_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  brokerage_id UUID,
  
  -- Project Details
  project_name TEXT NOT NULL,
  content_type TEXT NOT NULL, -- 'blog_post', 'social_media', 'email_campaign', 'newsletter', 'listing_description', 'property_flyer', 'market_report'
  target_audience TEXT NOT NULL,
  target_personas TEXT[], -- Which client personas
  
  -- AI Generation
  ai_generated BOOLEAN DEFAULT false,
  generation_prompt TEXT,
  generated_content JSONB, -- {subject, body, images, cta}
  
  -- Customization
  brand_voice TEXT, -- 'professional', 'friendly', 'luxury', 'casual'
  tone TEXT, -- 'them_first', 'educational', 'conversational'
  
  -- Assets
  images JSONB[],
  videos JSONB[],
  documents JSONB[],
  
  -- Compliance
  compliance_status TEXT DEFAULT 'pending',
  approved_at TIMESTAMPTZ,
  
  -- Scheduling
  scheduled_publish_date TIMESTAMPTZ,
  publish_status TEXT DEFAULT 'draft', -- 'draft', 'scheduled', 'published', 'archived'
  
  -- Performance
  views INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  conversions INTEGER DEFAULT 0,
  engagement_score DECIMAL(5,2),
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- OPEN HOUSE MANAGEMENT
-- ============================================

CREATE TABLE IF NOT EXISTS open_house_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID,
  listing_id UUID,
  property_mls_id TEXT,
  property_address TEXT NOT NULL,
  agent_id UUID,
  brokerage_id UUID,
  
  -- Scheduling
  event_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  timezone TEXT DEFAULT 'America/New_York',
  
  -- AI Predictions
  predicted_attendance INTEGER,
  predicted_serious_buyers INTEGER,
  predicted_offers INTEGER,
  optimization_score INTEGER, -- How well optimized (timing, marketing, etc)
  
  -- Marketing
  marketing_channels JSONB, -- {email: true, social: true, mls: true, signs: true}
  invitations_sent INTEGER DEFAULT 0,
  rsvp_count INTEGER DEFAULT 0,
  
  -- Actual Results
  actual_attendance INTEGER,
  actual_serious_buyers INTEGER,
  buyer_agent_attendance INTEGER,
  feedback_collected JSONB[],
  offers_received INTEGER DEFAULT 0,
  
  -- Follow-up
  followup_tasks_created BOOLEAN DEFAULT false,
  ai_followup_recommendations JSONB,
  
  -- Status
  status TEXT DEFAULT 'scheduled', -- 'scheduled', 'in_progress', 'completed', 'cancelled'
  cancellation_reason TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- OPEN HOUSE ATTENDEE TRACKING
-- ============================================

CREATE TABLE IF NOT EXISTS open_house_attendees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  open_house_id UUID,
  contact_id UUID, -- Link to existing contact if known
  
  -- Attendee Info
  name TEXT,
  email TEXT,
  phone TEXT,
  is_preregistered BOOLEAN DEFAULT false,
  
  -- Agent Info
  brought_by_agent TEXT,
  buyer_agent_info JSONB,
  
  -- Qualification
  preapproved BOOLEAN,
  preapproval_amount DECIMAL(12,2),
  timeline TEXT,
  interest_level TEXT, -- 'high', 'medium', 'low', 'just_looking'
  
  -- Feedback
  rating INTEGER,
  comments TEXT,
  concerns TEXT[],
  likes TEXT[],
  
  -- Follow-up
  wants_followup BOOLEAN DEFAULT true,
  preferred_contact_method TEXT,
  followup_completed BOOLEAN DEFAULT false,
  followup_notes TEXT,
  
  checked_in_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- SOCIAL MEDIA SCHEDULER
-- ============================================

CREATE TABLE IF NOT EXISTS social_media_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  brokerage_id UUID,
  listing_id UUID,
  
  -- Content
  post_text TEXT NOT NULL,
  post_type TEXT NOT NULL, -- 'listing', 'market_update', 'tip', 'testimonial', 'community', 'just_sold', 'just_listed'
  media_urls TEXT[],
  hashtags TEXT[],
  
  -- AI Generation
  ai_generated BOOLEAN DEFAULT false,
  ai_optimization_score INTEGER,
  generation_prompt TEXT,
  
  -- Platforms
  platforms TEXT[], -- 'facebook', 'instagram', 'linkedin', 'twitter', 'tiktok', 'youtube'
  platform_specific_content JSONB, -- Different versions for each platform
  
  -- Scheduling
  scheduled_for TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  status TEXT DEFAULT 'draft', -- 'draft', 'scheduled', 'published', 'failed'
  failure_reason TEXT,
  
  -- Platform IDs (after posting)
  platform_post_ids JSONB, -- {facebook: 'id', instagram: 'id', ...}
  
  -- Performance
  impressions INTEGER DEFAULT 0,
  engagement INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  leads_generated INTEGER DEFAULT 0,
  
  -- Compliance
  compliance_approved BOOLEAN DEFAULT false,
  approval_id UUID,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- EMAIL CAMPAIGN BUILDER
-- ============================================

CREATE TABLE IF NOT EXISTS email_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID,
  brokerage_id UUID,
  
  -- Campaign Details
  campaign_name TEXT NOT NULL,
  campaign_type TEXT NOT NULL, -- 'drip', 'one_time', 'behavioral_trigger', 'anniversary', 'birthday', 'market_update', 'listing_alert'
  description TEXT,
  
  -- Targeting
  target_segment JSONB, -- Lead filters
  target_personas TEXT[],
  recipient_count INTEGER DEFAULT 0,
  
  -- Content
  email_sequence JSONB[], -- Array of emails in sequence
  ai_personalization_enabled BOOLEAN DEFAULT true,
  from_name TEXT,
  from_email TEXT,
  reply_to TEXT,
  
  -- Compliance
  compliance_approved BOOLEAN DEFAULT false,
  approval_id UUID,
  
  -- Scheduling
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  send_frequency JSONB, -- {interval: 'days', value: 3}
  send_time_preference TEXT, -- 'morning', 'afternoon', 'evening', 'ai_optimized'
  
  -- Performance
  sent_count INTEGER DEFAULT 0,
  delivered_count INTEGER DEFAULT 0,
  bounced_count INTEGER DEFAULT 0,
  open_count INTEGER DEFAULT 0,
  click_count INTEGER DEFAULT 0,
  reply_count INTEGER DEFAULT 0,
  unsubscribe_count INTEGER DEFAULT 0,
  open_rate DECIMAL(5,2),
  click_rate DECIMAL(5,2),
  response_rate DECIMAL(5,2),
  unsubscribe_rate DECIMAL(5,2),
  
  -- Status
  status TEXT DEFAULT 'draft', -- 'draft', 'active', 'paused', 'completed', 'archived'
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Email Campaign Recipients (individual sends)
CREATE TABLE IF NOT EXISTS email_campaign_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID,
  contact_id UUID,
  email_address TEXT NOT NULL,
  
  -- Send Details
  sequence_step INTEGER DEFAULT 1,
  subject_line TEXT,
  personalized_content JSONB,
  
  -- Status
  status TEXT DEFAULT 'pending', -- 'pending', 'sent', 'delivered', 'bounced', 'failed'
  sent_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  bounce_reason TEXT,
  
  -- Engagement
  opened BOOLEAN DEFAULT false,
  opened_at TIMESTAMPTZ,
  open_count INTEGER DEFAULT 0,
  clicked BOOLEAN DEFAULT false,
  clicked_at TIMESTAMPTZ,
  click_count INTEGER DEFAULT 0,
  clicked_links JSONB[],
  replied BOOLEAN DEFAULT false,
  replied_at TIMESTAMPTZ,
  unsubscribed BOOLEAN DEFAULT false,
  unsubscribed_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- LISTING MARKETING PACKAGES
-- ============================================

CREATE TABLE IF NOT EXISTS listing_marketing_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID,
  listing_id UUID,
  property_mls_id TEXT,
  property_address TEXT,
  agent_id UUID,
  brokerage_id UUID,
  package_tier TEXT NOT NULL, -- 'basic', 'premium', 'luxury', 'custom'
  
  -- Professional Services - Photography
  photography_ordered BOOLEAN DEFAULT false,
  photography_vendor_id UUID,
  photography_scheduled_date TIMESTAMPTZ,
  photography_completed_date TIMESTAMPTZ,
  photography_urls TEXT[],
  photography_cost DECIMAL(10,2),
  
  -- Drone Photography
  drone_photography BOOLEAN DEFAULT false,
  drone_vendor_id UUID,
  drone_urls TEXT[],
  drone_cost DECIMAL(10,2),
  
  -- Video Tour
  video_tour BOOLEAN DEFAULT false,
  video_tour_vendor_id UUID,
  video_tour_url TEXT,
  video_tour_cost DECIMAL(10,2),
  
  -- 3D Tour
  tour_3d BOOLEAN DEFAULT false,
  matterport_url TEXT,
  tour_3d_cost DECIMAL(10,2),
  
  -- Virtual Staging
  virtual_staging BOOLEAN DEFAULT false,
  virtual_staging_urls TEXT[],
  virtual_staging_cost DECIMAL(10,2),
  
  -- Physical Staging
  staging_ordered BOOLEAN DEFAULT false,
  staging_vendor_id UUID,
  staging_start_date DATE,
  staging_end_date DATE,
  staging_cost DECIMAL(10,2),
  
  -- AI-Generated Marketing
  ai_listing_description TEXT,
  ai_listing_headline TEXT,
  ai_social_posts JSONB[],
  ai_email_campaign_id UUID,
  ai_video_project_id UUID,
  
  -- Print Marketing
  flyers_ordered BOOLEAN DEFAULT false,
  flyer_design_url TEXT,
  flyers_quantity INTEGER,
  postcards_ordered BOOLEAN DEFAULT false,
  postcards_quantity INTEGER,
  
  -- Distribution
  mls_listed BOOLEAN DEFAULT false,
  mls_listed_date TIMESTAMPTZ,
  zillow_syndicated BOOLEAN DEFAULT false,
  realtor_com_syndicated BOOLEAN DEFAULT false,
  trulia_syndicated BOOLEAN DEFAULT false,
  redfin_syndicated BOOLEAN DEFAULT false,
  social_media_promoted BOOLEAN DEFAULT false,
  featured_on_website BOOLEAN DEFAULT false,
  
  -- Open Houses
  open_houses_scheduled INTEGER DEFAULT 0,
  
  -- Performance
  total_views INTEGER DEFAULT 0,
  unique_views INTEGER DEFAULT 0,
  showing_requests INTEGER DEFAULT 0,
  inquiries INTEGER DEFAULT 0,
  offers_received INTEGER DEFAULT 0,
  
  -- Costs
  total_marketing_cost DECIMAL(10,2),
  
  -- Status
  status TEXT DEFAULT 'planning', -- 'planning', 'in_progress', 'active', 'completed'
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- INDEXES
-- ============================================

-- Content Approvals
CREATE INDEX IF NOT EXISTS idx_content_approvals_status ON content_approvals(status);
CREATE INDEX IF NOT EXISTS idx_content_approvals_submitted_by ON content_approvals(submitted_by);

-- Vendor Directory
CREATE INDEX IF NOT EXISTS idx_vendor_directory_type ON vendor_directory(vendor_type, is_active);
CREATE INDEX IF NOT EXISTS idx_vendor_directory_brokerage ON vendor_directory(brokerage_id);

-- Video Projects
CREATE INDEX IF NOT EXISTS idx_video_projects_lead ON ai_video_projects(lead_id);
CREATE INDEX IF NOT EXISTS idx_video_projects_contact ON ai_video_projects(contact_id);
CREATE INDEX IF NOT EXISTS idx_video_projects_agent ON ai_video_projects(agent_id);
CREATE INDEX IF NOT EXISTS idx_video_projects_status ON ai_video_projects(heygen_status);

-- Content Creation Projects
CREATE INDEX IF NOT EXISTS idx_content_projects_agent ON content_creation_projects(agent_id, publish_status);
CREATE INDEX IF NOT EXISTS idx_content_projects_type ON content_creation_projects(content_type);

-- Open House Events
CREATE INDEX IF NOT EXISTS idx_open_house_date ON open_house_events(event_date, status);
CREATE INDEX IF NOT EXISTS idx_open_house_agent ON open_house_events(agent_id);
CREATE INDEX IF NOT EXISTS idx_open_house_listing ON open_house_events(listing_id);

-- Open House Attendees
CREATE INDEX IF NOT EXISTS idx_open_house_attendees_event ON open_house_attendees(open_house_id);
CREATE INDEX IF NOT EXISTS idx_open_house_attendees_email ON open_house_attendees(email);

-- Social Media Posts
CREATE INDEX IF NOT EXISTS idx_social_posts_scheduled ON social_media_posts(scheduled_for, status);
CREATE INDEX IF NOT EXISTS idx_social_posts_agent ON social_media_posts(agent_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_listing ON social_media_posts(listing_id);

-- Email Campaigns
CREATE INDEX IF NOT EXISTS idx_email_campaigns_agent ON email_campaigns(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_email_campaigns_type ON email_campaigns(campaign_type);

-- Email Campaign Sends
CREATE INDEX IF NOT EXISTS idx_email_sends_campaign ON email_campaign_sends(campaign_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_contact ON email_campaign_sends(contact_id);
CREATE INDEX IF NOT EXISTS idx_email_sends_status ON email_campaign_sends(status);

-- Listing Marketing Packages
CREATE INDEX IF NOT EXISTS idx_listing_marketing_transaction ON listing_marketing_packages(transaction_id);
CREATE INDEX IF NOT EXISTS idx_listing_marketing_listing ON listing_marketing_packages(listing_id);
CREATE INDEX IF NOT EXISTS idx_listing_marketing_agent ON listing_marketing_packages(agent_id);

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================

ALTER TABLE content_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE vendor_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_video_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_creation_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_house_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_house_attendees ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_media_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_campaign_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_marketing_packages ENABLE ROW LEVEL SECURITY;

-- Drop existing policies first
DROP POLICY IF EXISTS "content_approvals_all" ON content_approvals;
DROP POLICY IF EXISTS "vendor_directory_all" ON vendor_directory;
DROP POLICY IF EXISTS "ai_video_projects_all" ON ai_video_projects;
DROP POLICY IF EXISTS "content_creation_projects_all" ON content_creation_projects;
DROP POLICY IF EXISTS "open_house_events_all" ON open_house_events;
DROP POLICY IF EXISTS "open_house_attendees_all" ON open_house_attendees;
DROP POLICY IF EXISTS "social_media_posts_all" ON social_media_posts;
DROP POLICY IF EXISTS "email_campaigns_all" ON email_campaigns;
DROP POLICY IF EXISTS "email_campaign_sends_all" ON email_campaign_sends;
DROP POLICY IF EXISTS "listing_marketing_packages_all" ON listing_marketing_packages;

-- Create permissive policies for authenticated users
CREATE POLICY "content_approvals_all" ON content_approvals FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "vendor_directory_all" ON vendor_directory FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "ai_video_projects_all" ON ai_video_projects FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "content_creation_projects_all" ON content_creation_projects FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "open_house_events_all" ON open_house_events FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "open_house_attendees_all" ON open_house_attendees FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "social_media_posts_all" ON social_media_posts FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "email_campaigns_all" ON email_campaigns FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "email_campaign_sends_all" ON email_campaign_sends FOR ALL TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "listing_marketing_packages_all" ON listing_marketing_packages FOR ALL TO authenticated USING (true) WITH CHECK (true);
