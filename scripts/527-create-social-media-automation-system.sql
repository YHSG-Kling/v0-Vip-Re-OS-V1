-- =====================================================
-- SOCIAL MEDIA AUTOMATION SYSTEM
-- Multi-platform publishing, scheduling, and analytics
-- =====================================================

-- Drop existing tables if they exist
DROP TABLE IF EXISTS social_media_performance CASCADE;
DROP TABLE IF EXISTS content_approval_queue CASCADE;
DROP TABLE IF EXISTS posting_schedule_calendar CASCADE;
DROP TABLE IF EXISTS social_media_posts CASCADE;
DROP TABLE IF EXISTS social_media_accounts CASCADE;

-- =====================================================
-- 1. SOCIAL MEDIA ACCOUNTS
-- =====================================================

CREATE TABLE social_media_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Agent relationship
  agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Platform details
  platform TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram', 'linkedin', 'twitter', 'tiktok')),
  account_name TEXT NOT NULL,
  account_id TEXT, -- Platform-specific account ID
  
  -- OAuth tokens (encrypted)
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  
  -- Status
  is_active BOOLEAN DEFAULT true,
  connected_at TIMESTAMPTZ DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ,
  
  -- Metadata
  account_metadata JSONB DEFAULT '{}',
  
  UNIQUE(agent_id, platform, account_id)
);

-- =====================================================
-- 2. SOCIAL MEDIA POSTS
-- =====================================================

CREATE TABLE social_media_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Agent relationship
  agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Post type and content
  post_type TEXT NOT NULL CHECK (post_type IN (
    'listing', 'just_sold', 'market_update', 'educational', 
    'open_house', 'testimonial', 'community', 'personal_brand'
  )),
  content_text TEXT NOT NULL,
  media_urls TEXT[] DEFAULT '{}',
  
  -- Platform targeting
  platform TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram', 'linkedin', 'twitter', 'tiktok')),
  platform_optimized_content JSONB DEFAULT '{}', -- Variations per platform
  hashtags TEXT[] DEFAULT '{}',
  
  -- Scheduling
  scheduled_for TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'published', 'failed')),
  
  -- AI and compliance
  ai_generated BOOLEAN DEFAULT false,
  compliance_approved BOOLEAN DEFAULT false,
  compliance_flags JSONB DEFAULT '[]',
  
  -- Relationships
  property_id UUID REFERENCES listings(id) ON DELETE SET NULL,
  transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  open_house_event_id UUID REFERENCES open_house_events(id) ON DELETE SET NULL,
  
  -- Platform response
  platform_post_id TEXT, -- ID returned by platform after publishing
  platform_response JSONB DEFAULT '{}',
  
  -- A/B Testing
  is_ab_test BOOLEAN DEFAULT false,
  ab_test_group CHAR(1) CHECK (ab_test_group IN ('A', 'B')),
  ab_test_parent_id UUID REFERENCES social_media_posts(id) ON DELETE SET NULL,
  
  -- Error tracking
  error_message TEXT,
  retry_count INTEGER DEFAULT 0
);

-- =====================================================
-- 3. SOCIAL MEDIA PERFORMANCE
-- =====================================================

CREATE TABLE social_media_performance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Post relationship
  post_id UUID NOT NULL REFERENCES social_media_posts(id) ON DELETE CASCADE,
  
  -- Metrics
  impressions INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  engagement_count INTEGER DEFAULT 0, -- likes + comments + shares
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  saves INTEGER DEFAULT 0,
  
  -- Calculated metrics
  engagement_rate NUMERIC(5,2) DEFAULT 0, -- (engagement_count / impressions) * 100
  click_through_rate NUMERIC(5,2) DEFAULT 0,
  
  -- Performance insights
  best_performing_time TIME,
  audience_demographics JSONB DEFAULT '{}',
  
  -- Sync tracking
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(post_id, synced_at)
);

-- =====================================================
-- 4. POSTING SCHEDULE CALENDAR
-- =====================================================

CREATE TABLE posting_schedule_calendar (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Agent relationship
  agent_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Schedule definition
  day_of_week INTEGER NOT NULL CHECK (day_of_week BETWEEN 0 AND 6), -- 0 = Sunday
  time_slot TIME NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram', 'linkedin', 'twitter', 'tiktok')),
  content_type TEXT CHECK (content_type IN (
    'listing', 'just_sold', 'market_update', 'educational', 
    'open_house', 'testimonial', 'community', 'personal_brand'
  )),
  
  -- Settings
  is_active BOOLEAN DEFAULT true,
  ai_optimized BOOLEAN DEFAULT false,
  
  -- Performance tracking
  avg_engagement_rate NUMERIC(5,2),
  
  UNIQUE(agent_id, day_of_week, time_slot, platform)
);

-- =====================================================
-- 5. CONTENT APPROVAL QUEUE
-- =====================================================

CREATE TABLE content_approval_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Post relationship
  post_id UUID NOT NULL REFERENCES social_media_posts(id) ON DELETE CASCADE,
  
  -- Submission
  submitted_at TIMESTAMPTZ DEFAULT NOW(),
  submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
  
  -- Review
  reviewed_at TIMESTAMPTZ,
  reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
  approval_status TEXT DEFAULT 'pending' CHECK (approval_status IN ('pending', 'approved', 'rejected', 'needs_revision')),
  rejection_reason TEXT,
  
  -- Compliance
  compliance_flags JSONB DEFAULT '[]',
  auto_approved BOOLEAN DEFAULT false,
  
  UNIQUE(post_id)
);

-- =====================================================
-- INDEXES
-- =====================================================

-- Social media accounts
CREATE INDEX idx_accounts_agent_id ON social_media_accounts(agent_id);
CREATE INDEX idx_accounts_platform ON social_media_accounts(platform);
CREATE INDEX idx_accounts_active ON social_media_accounts(is_active);

-- Social media posts
CREATE INDEX idx_posts_agent_id ON social_media_posts(agent_id);
CREATE INDEX idx_posts_platform ON social_media_posts(platform);
CREATE INDEX idx_posts_status ON social_media_posts(status);
CREATE INDEX idx_posts_scheduled_for ON social_media_posts(scheduled_for);
CREATE INDEX idx_posts_published_at ON social_media_posts(published_at);
CREATE INDEX idx_posts_post_type ON social_media_posts(post_type);
CREATE INDEX idx_posts_property_id ON social_media_posts(property_id);
CREATE INDEX idx_posts_ab_test ON social_media_posts(is_ab_test, ab_test_group);

-- Performance
CREATE INDEX idx_performance_post_id ON social_media_performance(post_id);
CREATE INDEX idx_performance_synced_at ON social_media_performance(synced_at);

-- Schedule
CREATE INDEX idx_schedule_agent_id ON posting_schedule_calendar(agent_id);
CREATE INDEX idx_schedule_active ON posting_schedule_calendar(is_active);

-- Approval queue
CREATE INDEX idx_approval_status ON content_approval_queue(approval_status);
CREATE INDEX idx_approval_submitted_at ON content_approval_queue(submitted_at);

-- =====================================================
-- ROW LEVEL SECURITY
-- =====================================================

ALTER TABLE social_media_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_media_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_media_performance ENABLE ROW LEVEL SECURITY;
ALTER TABLE posting_schedule_calendar ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_approval_queue ENABLE ROW LEVEL SECURITY;

-- Accounts policies
CREATE POLICY "Agents manage own social accounts" ON social_media_accounts
  FOR ALL USING (agent_id = auth.uid()::uuid);

-- Posts policies
CREATE POLICY "Agents manage own posts" ON social_media_posts
  FOR ALL USING (agent_id = auth.uid()::uuid);

-- Performance policies
CREATE POLICY "Agents view own performance" ON social_media_performance
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM social_media_posts 
      WHERE social_media_posts.id = social_media_performance.post_id 
      AND social_media_posts.agent_id = auth.uid()::uuid
    )
  );

-- Schedule policies
CREATE POLICY "Agents manage own schedule" ON posting_schedule_calendar
  FOR ALL USING (agent_id = auth.uid()::uuid);

-- Approval queue policies
CREATE POLICY "Users view relevant approvals" ON content_approval_queue
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM social_media_posts 
      WHERE social_media_posts.id = content_approval_queue.post_id 
      AND social_media_posts.agent_id = auth.uid()::uuid
    )
  );

CREATE POLICY "Reviewers can approve" ON content_approval_queue
  FOR UPDATE USING (reviewed_by = auth.uid()::uuid OR auth.uid()::uuid IN (
    SELECT id FROM users WHERE role = 'admin' OR role = 'broker'
  ));
