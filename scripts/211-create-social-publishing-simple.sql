-- Social Publishing & Analytics System (Simplified)
-- Manages social media accounts, scheduled posts, and performance analytics
-- This version removes strict brokerage_id foreign key constraints

-- Social accounts connection
CREATE TABLE IF NOT EXISTS social_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  brokerage_id UUID, -- Optional, no FK constraint
  platform TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram', 'linkedin', 'twitter', 'tiktok')),
  account_name TEXT,
  account_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  scope TEXT[],
  profile_picture_url TEXT,
  follower_count INTEGER DEFAULT 0,
  is_active BOOLEAN DEFAULT true,
  last_synced_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, platform, account_id)
);

-- Social posts (scheduled and published)
CREATE TABLE IF NOT EXISTS social_posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  brokerage_id UUID, -- Optional, no FK constraint
  
  -- Content
  content TEXT NOT NULL,
  media_urls TEXT[],
  media_types TEXT[],
  hashtags TEXT[],
  mentions TEXT[],
  
  -- Scheduling
  scheduled_for TIMESTAMPTZ NOT NULL,
  timezone TEXT DEFAULT 'America/New_York',
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled')),
  
  -- Publishing targets
  platforms TEXT[] NOT NULL,
  facebook_post_id TEXT,
  instagram_post_id TEXT,
  linkedin_post_id TEXT,
  twitter_post_id TEXT,
  tiktok_post_id TEXT,
  
  -- Metadata
  content_type TEXT,
  linked_listing_id UUID,
  linked_contact_id UUID,
  
  -- AI generation
  generated_by_ai BOOLEAN DEFAULT false,
  ai_prompt TEXT,
  them_first_score INTEGER,
  
  -- Publishing results
  published_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  error_message TEXT,
  retry_count INTEGER DEFAULT 0,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Social post analytics
CREATE TABLE IF NOT EXISTS social_post_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  social_post_id UUID NOT NULL REFERENCES social_posts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  
  -- Engagement metrics
  impressions INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  engagement INTEGER DEFAULT 0,
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  saves INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  video_views INTEGER DEFAULT 0,
  
  -- Lead generation
  leads_generated INTEGER DEFAULT 0,
  contact_form_fills INTEGER DEFAULT 0,
  
  -- Timestamps
  last_updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(social_post_id, platform)
);

-- Content suggestions
CREATE TABLE IF NOT EXISTS social_content_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  title TEXT NOT NULL,
  content_idea TEXT NOT NULL,
  suggested_platforms TEXT[],
  content_type TEXT,
  relevance_score INTEGER DEFAULT 50,
  is_used BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_social_posts_user_id ON social_posts(user_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_status ON social_posts(status);
CREATE INDEX IF NOT EXISTS idx_social_posts_scheduled_for ON social_posts(scheduled_for);
CREATE INDEX IF NOT EXISTS idx_social_accounts_user_id ON social_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_social_post_analytics_post_id ON social_post_analytics(social_post_id);

-- Enable RLS
ALTER TABLE social_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_post_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_content_suggestions ENABLE ROW LEVEL SECURITY;

-- Create policies for service role access
DO $$ 
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'social_accounts' AND policyname = 'Service role manages social_accounts') THEN
    CREATE POLICY "Service role manages social_accounts" ON social_accounts FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'social_posts' AND policyname = 'Service role manages social_posts') THEN
    CREATE POLICY "Service role manages social_posts" ON social_posts FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'social_post_analytics' AND policyname = 'Service role manages social_post_analytics') THEN
    CREATE POLICY "Service role manages social_post_analytics" ON social_post_analytics FOR ALL USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'social_content_suggestions' AND policyname = 'Service role manages social_content_suggestions') THEN
    CREATE POLICY "Service role manages social_content_suggestions" ON social_content_suggestions FOR ALL USING (true);
  END IF;
END $$;
