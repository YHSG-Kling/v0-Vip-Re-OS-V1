-- Social Publishing & Analytics System
-- Manages social media accounts, scheduled posts, and performance analytics

-- Social accounts connection
CREATE TABLE IF NOT EXISTS social_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('facebook', 'instagram', 'linkedin', 'twitter', 'tiktok')),
  account_name TEXT,
  account_id TEXT NOT NULL, -- Platform-specific account ID
  access_token TEXT NOT NULL, -- Encrypted token
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  scope TEXT[], -- Permissions granted
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
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  
  -- Content
  content TEXT NOT NULL,
  media_urls TEXT[], -- Image/video URLs
  media_types TEXT[], -- image, video, carousel
  hashtags TEXT[],
  mentions TEXT[],
  
  -- Scheduling
  scheduled_for TIMESTAMPTZ NOT NULL,
  timezone TEXT DEFAULT 'America/New_York',
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'scheduled', 'publishing', 'published', 'failed', 'cancelled')),
  
  -- Publishing targets
  platforms TEXT[] NOT NULL, -- ['facebook', 'instagram', 'linkedin']
  facebook_post_id TEXT,
  instagram_post_id TEXT,
  linkedin_post_id TEXT,
  twitter_post_id TEXT,
  tiktok_post_id TEXT,
  
  -- Metadata
  content_type TEXT, -- listing, market_update, tip, story, client_testimonial
  linked_listing_id UUID REFERENCES listings(id) ON DELETE SET NULL,
  linked_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  
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

-- Content ideas with social suggestions
CREATE TABLE IF NOT EXISTS social_content_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  
  title TEXT NOT NULL,
  description TEXT,
  suggested_content TEXT,
  suggested_hashtags TEXT[],
  best_time_to_post TIMESTAMPTZ,
  estimated_engagement_score INTEGER,
  
  -- Categorization
  content_category TEXT, -- market_stats, home_tips, local_business, client_story
  persona_target TEXT[], -- military-buyer, first-time-buyer, etc.
  
  -- Status
  status TEXT DEFAULT 'suggested' CHECK (status IN ('suggested', 'saved', 'scheduled', 'used', 'dismissed')),
  used_in_post_id UUID REFERENCES social_posts(id) ON DELETE SET NULL,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Competitor content tracking
CREATE TABLE IF NOT EXISTS competitor_social_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  
  competitor_name TEXT NOT NULL,
  platform TEXT NOT NULL,
  account_handle TEXT NOT NULL,
  account_url TEXT,
  
  -- Latest post analysis
  latest_post_content TEXT,
  latest_post_engagement INTEGER,
  latest_post_date TIMESTAMPTZ,
  
  -- Trends
  avg_engagement_rate DECIMAL(5,2),
  posting_frequency TEXT, -- daily, weekly
  top_performing_hashtags TEXT[],
  
  last_scraped_at TIMESTAMPTZ DEFAULT NOW(),
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(brokerage_id, platform, account_handle)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_social_accounts_user ON social_accounts(user_id);
CREATE INDEX IF NOT EXISTS idx_social_accounts_platform ON social_accounts(platform, is_active);
CREATE INDEX IF NOT EXISTS idx_social_posts_user ON social_posts(user_id);
CREATE INDEX IF NOT EXISTS idx_social_posts_status ON social_posts(status);
CREATE INDEX IF NOT EXISTS idx_social_posts_scheduled ON social_posts(scheduled_for) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_social_post_analytics_post ON social_post_analytics(social_post_id);
CREATE INDEX IF NOT EXISTS idx_social_suggestions_user ON social_content_suggestions(user_id, status);

-- RLS Policies
ALTER TABLE social_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_post_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE social_content_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_social_tracking ENABLE ROW LEVEL SECURITY;

-- Social accounts policies
CREATE POLICY "Users can view own social accounts" ON social_accounts FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own social accounts" ON social_accounts FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own social accounts" ON social_accounts FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own social accounts" ON social_accounts FOR DELETE USING (auth.uid() = user_id);

-- Social posts policies  
CREATE POLICY "Users can view own social posts" ON social_posts FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can insert own social posts" ON social_posts FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own social posts" ON social_posts FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own social posts" ON social_posts FOR DELETE USING (auth.uid() = user_id);

-- Analytics policies (read-only)
CREATE POLICY "Users can view analytics for own posts" ON social_post_analytics FOR SELECT 
  USING (EXISTS (SELECT 1 FROM social_posts WHERE social_posts.id = social_post_analytics.social_post_id AND social_posts.user_id = auth.uid()));

-- Content suggestions policies
CREATE POLICY "Users can view own suggestions" ON social_content_suggestions FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can manage own suggestions" ON social_content_suggestions FOR ALL USING (auth.uid() = user_id);

-- Competitor tracking policies (brokerage-wide)
CREATE POLICY "Users can view brokerage competitor tracking" ON competitor_social_tracking FOR SELECT 
  USING (EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.brokerage_id = competitor_social_tracking.brokerage_id));

-- Updated_at trigger
CREATE OR REPLACE FUNCTION update_social_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER social_accounts_updated_at BEFORE UPDATE ON social_accounts FOR EACH ROW EXECUTE FUNCTION update_social_updated_at();
CREATE TRIGGER social_posts_updated_at BEFORE UPDATE ON social_posts FOR EACH ROW EXECUTE FUNCTION update_social_updated_at();
CREATE TRIGGER social_suggestions_updated_at BEFORE UPDATE ON social_content_suggestions FOR EACH ROW EXECUTE FUNCTION update_social_updated_at();
