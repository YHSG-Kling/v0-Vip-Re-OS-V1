-- =====================================================
-- AI VIDEO ASSISTANT & CONTENT STUDIO ENHANCEMENT
-- Enhances existing video tables and adds new ones
-- =====================================================

-- Drop old keyword table and create new one
DROP TABLE IF EXISTS keywords CASCADE;

-- Create enum types for video module
CREATE TYPE audience_type AS ENUM ('buyer', 'seller');
CREATE TYPE segment_type AS ENUM ('military', 'relocation', 'first_time', 'upsizing', 'downsizing', 'investor', 'generic');
CREATE TYPE flow_context_type AS ENUM ('new_lead_welcome', 'pre_listing', 'pre_offer', 'pre_inspection', 'what_happens_next', 'lender_intro', 'seller_series_1', 'seller_series_2', 'seller_series_3', 'on_demand_session', 'masterclass');
CREATE TYPE format_type AS ENUM ('short_clip_60_120s', 'mini_webinar_10_15m', 'masterclass_20_40m');
CREATE TYPE video_status AS ENUM ('draft', 'active', 'archived');
CREATE TYPE video_event_type AS ENUM ('sent', 'opened', 'clicked', 'watched_start', 'watched_25', 'watched_50', 'watched_90', 'watched_100');
CREATE TYPE content_idea_type AS ENUM ('listing', 'market_update', 'educational', 'story', 'testimonial');
CREATE TYPE target_audience AS ENUM ('buyer', 'seller', 'investor', 'sphere');
CREATE TYPE content_status AS ENUM ('draft', 'scripted', 'filmed', 'repurposed');
CREATE TYPE source_type AS ENUM ('recorded_in_app', 'uploaded_file', 'external_link');
CREATE TYPE clip_type AS ENUM ('hook', 'tip', 'story', 'faq', 'call_to_action', 'b_roll_highlight');
CREATE TYPE aspect_ratio AS ENUM ('9:16', '1:1', '16:9');
CREATE TYPE export_status AS ENUM ('not_generated', 'generated', 'scheduled');
CREATE TYPE intent_type AS ENUM ('seller_value', 'buyer_search', 'investor', 'local_market', 'services_tools');
CREATE TYPE recommended_use AS ENUM ('title', 'hook', 'description', 'CTA');
CREATE TYPE platform_type AS ENUM ('Instagram', 'TikTok', 'YouTube', 'Facebook', 'Google_Business', 'Website');
CREATE TYPE focus_type AS ENUM ('local_agent', 'team', 'portal', 'coach');
CREATE TYPE watchlist_status AS ENUM ('active', 'paused');
CREATE TYPE post_type AS ENUM ('video', 'reel', 'short', 'story', 'blog', 'ad');
CREATE TYPE video_asset_type AS ENUM ('short_clip', 'mini_webinar', 'masterclass');

-- =====================================================
-- 1. ENHANCE video_assets table → video_asset_library
-- =====================================================
DROP TABLE IF EXISTS video_assets CASCADE;

CREATE TABLE video_asset_library (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  audience_type audience_type NOT NULL,
  segment segment_type NOT NULL,
  flow_context flow_context_type NOT NULL,
  format_type format_type NOT NULL,
  script_template TEXT,
  video_url TEXT,
  thumbnail_url TEXT,
  status video_status DEFAULT 'draft',
  title TEXT NOT NULL,
  description TEXT,
  duration_seconds INTEGER,
  tags TEXT[],
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- =====================================================
-- 2. ENHANCE video_engagement_events
-- =====================================================
DROP TABLE IF EXISTS video_engagement_events CASCADE;

CREATE TABLE video_engagement_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  asset_id UUID NOT NULL REFERENCES video_asset_library(id) ON DELETE CASCADE,
  event_type video_event_type NOT NULL,
  timestamp TIMESTAMP DEFAULT now(),
  watch_duration_seconds INTEGER,
  metadata JSONB
);

-- =====================================================
-- 3. ENHANCE content_ideas
-- =====================================================
DROP TABLE IF EXISTS content_ideas CASCADE;

CREATE TABLE content_ideas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idea_type content_idea_type NOT NULL,
  core_topic TEXT NOT NULL,
  target_audience target_audience NOT NULL,
  primary_keyword TEXT,
  secondary_keywords TEXT[],
  status content_status DEFAULT 'draft',
  notes TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- =====================================================
-- 4. ENHANCE long_form_videos → long_form_video
-- =====================================================
DROP TABLE IF EXISTS long_form_videos CASCADE;

CREATE TABLE long_form_video (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idea_id UUID REFERENCES content_ideas(id) ON DELETE SET NULL,
  source_type source_type NOT NULL,
  video_url TEXT,
  duration_seconds INTEGER,
  transcript_text TEXT,
  platform_source TEXT,
  title TEXT,
  description TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- =====================================================
-- 5. CREATE short_clip
-- =====================================================
CREATE TABLE short_clip (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID NOT NULL REFERENCES long_form_video(id) ON DELETE CASCADE,
  clip_type clip_type NOT NULL,
  start_time INTEGER NOT NULL, -- seconds
  end_time INTEGER NOT NULL, -- seconds
  script_variant TEXT,
  aspect_ratio aspect_ratio DEFAULT '9:16',
  platform_targets TEXT[] DEFAULT ARRAY['TikTok', 'IG_Reels', 'YT_Shorts'],
  export_status export_status DEFAULT 'not_generated',
  export_url TEXT,
  title TEXT,
  caption TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  CONSTRAINT valid_time_range CHECK (end_time > start_time)
);

-- =====================================================
-- 6. CREATE keyword_library
-- =====================================================
CREATE TABLE keyword_library (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword TEXT NOT NULL UNIQUE,
  intent_type intent_type NOT NULL,
  recommended_use recommended_use NOT NULL,
  priority_score INTEGER DEFAULT 50 CHECK (priority_score >= 0 AND priority_score <= 100),
  search_volume INTEGER,
  notes TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

-- =====================================================
-- 7. CREATE competitor_watchlist
-- =====================================================
CREATE TABLE competitor_watchlist (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name_handle TEXT NOT NULL,
  platform platform_type NOT NULL,
  focus_type focus_type NOT NULL,
  status watchlist_status DEFAULT 'active',
  profile_url TEXT,
  notes TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now(),
  UNIQUE(owner_id, name_handle, platform)
);

-- =====================================================
-- 8. CREATE competitor_content_snapshot
-- =====================================================
CREATE TABLE competitor_content_snapshot (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  competitor_id UUID NOT NULL REFERENCES competitor_watchlist(id) ON DELETE CASCADE,
  fetched_at TIMESTAMP DEFAULT now(),
  post_type post_type NOT NULL,
  post_caption TEXT,
  post_url TEXT,
  engagement_metrics JSONB, -- {likes: 100, comments: 20, views: 1000, shares: 5}
  ai_summary TEXT,
  keywords_detected TEXT[],
  created_at TIMESTAMP DEFAULT now()
);

-- =====================================================
-- 9. EXTEND contacts table with video engagement fields
-- =====================================================
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS video_engagement_score INTEGER DEFAULT 0 CHECK (video_engagement_score >= 0 AND video_engagement_score <= 100);
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS video_last_watched_at TIMESTAMP;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS video_last_asset_type video_asset_type;

-- =====================================================
-- INDEXES for query performance
-- =====================================================
CREATE INDEX idx_video_asset_library_owner ON video_asset_library(owner_id);
CREATE INDEX idx_video_asset_library_audience ON video_asset_library(audience_type, segment);
CREATE INDEX idx_video_asset_library_status ON video_asset_library(status);

CREATE INDEX idx_video_engagement_contact ON video_engagement_events(contact_id);
CREATE INDEX idx_video_engagement_asset ON video_engagement_events(asset_id);
CREATE INDEX idx_video_engagement_timestamp ON video_engagement_events(timestamp DESC);

CREATE INDEX idx_content_ideas_owner ON content_ideas(owner_id);
CREATE INDEX idx_content_ideas_status ON content_ideas(status);
CREATE INDEX idx_content_ideas_type ON content_ideas(idea_type);

CREATE INDEX idx_long_form_video_owner ON long_form_video(owner_id);
CREATE INDEX idx_long_form_video_idea ON long_form_video(idea_id);

CREATE INDEX idx_short_clip_video ON short_clip(video_id);
CREATE INDEX idx_short_clip_status ON short_clip(export_status);

CREATE INDEX idx_keyword_library_intent ON keyword_library(intent_type);
CREATE INDEX idx_keyword_library_priority ON keyword_library(priority_score DESC);

CREATE INDEX idx_competitor_watchlist_owner ON competitor_watchlist(owner_id);
CREATE INDEX idx_competitor_watchlist_status ON competitor_watchlist(status);

CREATE INDEX idx_competitor_snapshot_competitor ON competitor_content_snapshot(competitor_id);
CREATE INDEX idx_competitor_snapshot_fetched ON competitor_content_snapshot(fetched_at DESC);

CREATE INDEX idx_contacts_video_engagement ON contacts(video_engagement_score DESC);
CREATE INDEX idx_contacts_video_last_watched ON contacts(video_last_watched_at DESC);

-- =====================================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- =====================================================

ALTER TABLE video_asset_library ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_engagement_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_ideas ENABLE ROW LEVEL SECURITY;
ALTER TABLE long_form_video ENABLE ROW LEVEL SECURITY;
ALTER TABLE short_clip ENABLE ROW LEVEL SECURITY;
ALTER TABLE keyword_library ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_watchlist ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_content_snapshot ENABLE ROW LEVEL SECURITY;

-- video_asset_library: Agents see their own, Admins/Brokers see org
CREATE POLICY "video_asset_library_select" ON video_asset_library FOR SELECT USING (
  owner_id = auth.uid() OR
  EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.user_type IN ('admin', 'broker'))
);

CREATE POLICY "video_asset_library_insert" ON video_asset_library FOR INSERT WITH CHECK (
  owner_id = auth.uid()
);

CREATE POLICY "video_asset_library_update" ON video_asset_library FOR UPDATE USING (
  owner_id = auth.uid() OR
  EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.user_type IN ('admin', 'broker'))
);

CREATE POLICY "video_asset_library_delete" ON video_asset_library FOR DELETE USING (
  owner_id = auth.uid() OR
  EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.user_type = 'admin')
);

-- video_engagement_events: Agents see their contacts' events
CREATE POLICY "video_engagement_events_select" ON video_engagement_events FOR SELECT USING (
  EXISTS (SELECT 1 FROM contacts WHERE contacts.id = video_engagement_events.contact_id AND contacts.agent_id = auth.uid()) OR
  EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.user_type IN ('admin', 'broker'))
);

CREATE POLICY "video_engagement_events_insert" ON video_engagement_events FOR INSERT WITH CHECK (true);

-- content_ideas: Agents own their content ideas
CREATE POLICY "content_ideas_select" ON content_ideas FOR SELECT USING (
  owner_id = auth.uid() OR
  EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.user_type IN ('admin', 'broker'))
);

CREATE POLICY "content_ideas_all" ON content_ideas FOR ALL USING (owner_id = auth.uid());

-- long_form_video: Agents own their videos
CREATE POLICY "long_form_video_select" ON long_form_video FOR SELECT USING (
  owner_id = auth.uid() OR
  EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.user_type IN ('admin', 'broker'))
);

CREATE POLICY "long_form_video_all" ON long_form_video FOR ALL USING (owner_id = auth.uid());

-- short_clip: Inherit ownership from parent video
CREATE POLICY "short_clip_select" ON short_clip FOR SELECT USING (
  EXISTS (SELECT 1 FROM long_form_video WHERE long_form_video.id = short_clip.video_id AND long_form_video.owner_id = auth.uid()) OR
  EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.user_type IN ('admin', 'broker'))
);

CREATE POLICY "short_clip_all" ON short_clip FOR ALL USING (
  EXISTS (SELECT 1 FROM long_form_video WHERE long_form_video.id = short_clip.video_id AND long_form_video.owner_id = auth.uid())
);

-- keyword_library: Public read, admin write
CREATE POLICY "keyword_library_select" ON keyword_library FOR SELECT USING (true);

CREATE POLICY "keyword_library_modify" ON keyword_library FOR ALL USING (
  EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.user_type IN ('admin', 'broker'))
);

-- competitor_watchlist: Agents own their watchlists
CREATE POLICY "competitor_watchlist_select" ON competitor_watchlist FOR SELECT USING (
  owner_id = auth.uid() OR
  EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.user_type IN ('admin', 'broker'))
);

CREATE POLICY "competitor_watchlist_all" ON competitor_watchlist FOR ALL USING (owner_id = auth.uid());

-- competitor_content_snapshot: Inherit from watchlist
CREATE POLICY "competitor_content_snapshot_select" ON competitor_content_snapshot FOR SELECT USING (
  EXISTS (SELECT 1 FROM competitor_watchlist WHERE competitor_watchlist.id = competitor_content_snapshot.competitor_id AND competitor_watchlist.owner_id = auth.uid()) OR
  EXISTS (SELECT 1 FROM users WHERE users.id = auth.uid() AND users.user_type IN ('admin', 'broker'))
);

CREATE POLICY "competitor_content_snapshot_insert" ON competitor_content_snapshot FOR INSERT WITH CHECK (
  EXISTS (SELECT 1 FROM competitor_watchlist WHERE competitor_watchlist.id = competitor_content_snapshot.competitor_id AND competitor_watchlist.owner_id = auth.uid())
);

-- =====================================================
-- TRIGGERS for updated_at
-- =====================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_video_asset_library_updated_at BEFORE UPDATE ON video_asset_library FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_content_ideas_updated_at BEFORE UPDATE ON content_ideas FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_long_form_video_updated_at BEFORE UPDATE ON long_form_video FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_short_clip_updated_at BEFORE UPDATE ON short_clip FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_keyword_library_updated_at BEFORE UPDATE ON keyword_library FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_competitor_watchlist_updated_at BEFORE UPDATE ON competitor_watchlist FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- SEED DATA
-- =====================================================

-- Seed keyword library with common real estate keywords
INSERT INTO keyword_library (keyword, intent_type, recommended_use, priority_score, search_volume) VALUES
  ('homes for sale', 'buyer_search', 'title', 90, 50000),
  ('selling your home', 'seller_value', 'title', 85, 30000),
  ('first time home buyer', 'buyer_search', 'hook', 80, 25000),
  ('how to sell your house fast', 'seller_value', 'title', 85, 20000),
  ('real estate agent near me', 'services_tools', 'description', 75, 40000),
  ('home value estimate', 'seller_value', 'CTA', 90, 35000),
  ('investment properties', 'investor', 'title', 70, 15000),
  ('local market trends', 'local_market', 'hook', 80, 10000),
  ('home staging tips', 'seller_value', 'hook', 75, 8000),
  ('mortgage pre-approval', 'buyer_search', 'CTA', 85, 18000),
  ('open house', 'local_market', 'description', 70, 12000),
  ('luxury homes', 'buyer_search', 'title', 75, 22000),
  ('downsizing tips', 'seller_value', 'hook', 70, 6000),
  ('military relocation', 'buyer_search', 'title', 75, 5000),
  ('seller closing costs', 'seller_value', 'description', 80, 7000)
ON CONFLICT (keyword) DO NOTHING;

-- Seed sample video asset templates for common flows
INSERT INTO video_asset_library (owner_id, audience_type, segment, flow_context, format_type, title, script_template, status) 
SELECT 
  (SELECT id FROM users WHERE user_type = 'agent' LIMIT 1),
  'buyer',
  'first_time',
  'new_lead_welcome',
  'short_clip_60_120s',
  'Welcome First-Time Buyer',
  'Hi [NAME]! I'm so excited to help you find your first home. In this quick video, I'll show you the 3 simple steps we'll take together...',
  'active'
WHERE EXISTS (SELECT 1 FROM users WHERE user_type = 'agent');

INSERT INTO video_asset_library (owner_id, audience_type, segment, flow_context, format_type, title, script_template, status) 
SELECT 
  (SELECT id FROM users WHERE user_type = 'agent' LIMIT 1),
  'seller',
  'generic',
  'pre_listing',
  'mini_webinar_10_15m',
  'Pre-Listing Preparation Guide',
  'Welcome [NAME]! Before we list your home, let me walk you through our proven process that helps homes sell faster and for more money...',
  'active'
WHERE EXISTS (SELECT 1 FROM users WHERE user_type = 'agent');

INSERT INTO video_asset_library (owner_id, audience_type, segment, flow_context, format_type, title, script_template, status) 
SELECT 
  (SELECT id FROM users WHERE user_type = 'agent' LIMIT 1),
  'seller',
  'generic',
  'what_happens_next',
  'short_clip_60_120s',
  'What Happens After We Go Under Contract',
  'Congratulations [NAME]! Now that we have an accepted offer, here's exactly what to expect in the next 30 days...',
  'active'
WHERE EXISTS (SELECT 1 FROM users WHERE user_type = 'agent');
