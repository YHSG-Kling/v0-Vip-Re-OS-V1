-- Enhance Content Studio with additional tables for calendar, keywords, and scheduling
-- This builds on existing content_ideas and competitor_content tables

-- Content Keywords table for SEO research
CREATE TABLE IF NOT EXISTS content_keywords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword TEXT NOT NULL,
  search_volume INTEGER DEFAULT 0,
  competition TEXT CHECK (competition IN ('low', 'medium', 'high')) DEFAULT 'medium',
  relevance_score INTEGER DEFAULT 0,
  monthly_trend JSONB, -- Array of monthly volumes
  related_keywords TEXT[],
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Content Calendar for scheduling
CREATE TABLE IF NOT EXISTS content_calendar (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  content_type TEXT CHECK (content_type IN ('video', 'social_post', 'blog', 'email')) NOT NULL,
  scheduled_date TIMESTAMPTZ NOT NULL,
  scheduled_time TIME,
  platform TEXT, -- YouTube, Instagram, Facebook, etc.
  status TEXT CHECK (status IN ('draft', 'scheduled', 'published', 'cancelled')) DEFAULT 'draft',
  content_id UUID, -- Reference to video, blog post, etc.
  notes TEXT,
  agent_id UUID REFERENCES users(id) ON DELETE CASCADE,
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  published_at TIMESTAMPTZ,
  engagement_stats JSONB, -- {views: 123, likes: 45, shares: 12}
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Saved Content Ideas
CREATE TABLE IF NOT EXISTS saved_content_ideas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idea_text TEXT NOT NULL,
  content_type TEXT CHECK (content_type IN ('video', 'social_post', 'blog', 'tool', 'email')) NOT NULL,
  target_persona TEXT,
  status TEXT CHECK (status IN ('saved', 'draft', 'scheduled', 'published')) DEFAULT 'saved',
  scheduled_date DATE,
  notes TEXT,
  agent_id UUID REFERENCES users(id) ON DELETE CASCADE,
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Publishing Stats tracking
CREATE TABLE IF NOT EXISTS publishing_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES users(id) ON DELETE CASCADE,
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  week_start_date DATE NOT NULL,
  week_goal INTEGER DEFAULT 7,
  week_posted INTEGER DEFAULT 0,
  month_start_date DATE NOT NULL,
  month_goal INTEGER DEFAULT 24,
  month_posted INTEGER DEFAULT 0,
  top_performing_content_id UUID,
  top_performing_views INTEGER DEFAULT 0,
  top_performing_shares INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id, week_start_date)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_content_calendar_scheduled ON content_calendar(scheduled_date, agent_id);
CREATE INDEX IF NOT EXISTS idx_content_calendar_status ON content_calendar(status, agent_id);
CREATE INDEX IF NOT EXISTS idx_content_keywords_relevance ON content_keywords(relevance_score DESC);
CREATE INDEX IF NOT EXISTS idx_saved_ideas_status ON saved_content_ideas(status, agent_id);
CREATE INDEX IF NOT EXISTS idx_publishing_stats_agent ON publishing_stats(agent_id, week_start_date DESC);

-- RLS Policies
ALTER TABLE content_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_calendar ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_content_ideas ENABLE ROW LEVEL SECURITY;
ALTER TABLE publishing_stats ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own brokerage keywords" ON content_keywords FOR SELECT USING (
  brokerage_id IN (SELECT brokerage_id FROM users WHERE id = auth.uid())
);

CREATE POLICY "Users can view own calendar" ON content_calendar FOR SELECT USING (
  agent_id = auth.uid() OR brokerage_id IN (SELECT brokerage_id FROM users WHERE id = auth.uid() AND role IN ('admin', 'broker'))
);

CREATE POLICY "Users can manage own calendar" ON content_calendar FOR ALL USING (
  agent_id = auth.uid()
);

CREATE POLICY "Users can view own saved ideas" ON saved_content_ideas FOR ALL USING (
  agent_id = auth.uid()
);

CREATE POLICY "Users can view own publishing stats" ON publishing_stats FOR ALL USING (
  agent_id = auth.uid()
);

-- Triggers for updated_at
CREATE TRIGGER update_content_keywords_updated_at BEFORE UPDATE ON content_keywords
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_content_calendar_updated_at BEFORE UPDATE ON content_calendar
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_saved_content_ideas_updated_at BEFORE UPDATE ON saved_content_ideas
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_publishing_stats_updated_at BEFORE UPDATE ON publishing_stats
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
