-- AI Podcast Generation System
-- Production-ready schema for automated podcast creation from scripts/keywords

-- Podcast Episodes Table
CREATE TABLE IF NOT EXISTS podcast_episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  script TEXT NOT NULL,
  keywords TEXT[],
  
  -- Audio Generation
  audio_url TEXT, -- Vercel Blob storage URL
  duration_seconds INTEGER,
  audio_format TEXT DEFAULT 'mp3',
  
  -- Voice Settings
  primary_voice_id TEXT, -- ElevenLabs/Grok voice ID
  voice_settings JSONB DEFAULT '{"stability": 0.5, "similarity_boost": 0.75, "style": 0.0, "use_speaker_boost": true}'::jsonb,
  
  -- Content Structure
  segments JSONB, -- Array of segments with text, voice, timing
  music_background TEXT, -- Background music URL or ID
  intro_outro_config JSONB,
  
  -- Status & Processing
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'generating', 'processing', 'completed', 'failed', 'published')),
  generation_started_at TIMESTAMPTZ,
  generation_completed_at TIMESTAMPTZ,
  error_message TEXT,
  
  -- Publishing
  published_at TIMESTAMPTZ,
  publish_channels TEXT[] DEFAULT ARRAY['internal'], -- ['spotify', 'apple', 'google', 'youtube', 'internal']
  external_urls JSONB, -- Links to published podcast episodes
  
  -- Metadata
  category TEXT,
  tags TEXT[],
  thumbnail_url TEXT,
  show_notes TEXT,
  
  -- Analytics
  play_count INTEGER DEFAULT 0,
  download_count INTEGER DEFAULT 0,
  avg_listen_duration_seconds INTEGER,
  completion_rate DECIMAL(5,2),
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Podcast Templates Table
CREATE TABLE IF NOT EXISTS podcast_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  
  -- Template Configuration
  template_type TEXT NOT NULL CHECK (template_type IN ('market_update', 'listing_showcase', 'buyer_guide', 'seller_tips', 'neighborhood_spotlight', 'custom')),
  
  -- Voice & Style
  default_voice_id TEXT,
  voice_settings JSONB,
  intro_template TEXT,
  outro_template TEXT,
  
  -- Structure
  segment_structure JSONB, -- Predefined segment flow
  background_music_id TEXT,
  duration_target_seconds INTEGER,
  
  -- Branding
  show_name TEXT,
  host_name TEXT,
  tagline TEXT,
  
  is_active BOOLEAN DEFAULT true,
  use_count INTEGER DEFAULT 0,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Podcast Segments Table (for detailed segment tracking)
CREATE TABLE IF NOT EXISTS podcast_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id UUID REFERENCES podcast_episodes(id) ON DELETE CASCADE,
  
  segment_order INTEGER NOT NULL,
  segment_type TEXT CHECK (segment_type IN ('intro', 'main', 'transition', 'outro', 'ad_break')),
  
  -- Content
  text_content TEXT NOT NULL,
  voice_id TEXT,
  
  -- Timing
  start_time_seconds DECIMAL(10,2),
  duration_seconds DECIMAL(10,2),
  
  -- Audio
  audio_url TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Podcast Analytics Events Table
CREATE TABLE IF NOT EXISTS podcast_analytics_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id UUID REFERENCES podcast_episodes(id) ON DELETE CASCADE,
  
  event_type TEXT NOT NULL CHECK (event_type IN ('play', 'pause', 'complete', 'download', 'share', 'skip')),
  
  -- Listener Info
  listener_contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  listener_ip TEXT,
  listener_location TEXT,
  
  -- Playback Details
  timestamp_seconds DECIMAL(10,2), -- Where in the episode
  duration_listened_seconds INTEGER,
  
  -- Device/Platform
  platform TEXT, -- 'web', 'mobile', 'spotify', etc.
  user_agent TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_agent_id ON podcast_episodes(agent_id);
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_status ON podcast_episodes(status);
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_published_at ON podcast_episodes(published_at DESC);
CREATE INDEX IF NOT EXISTS idx_podcast_episodes_category ON podcast_episodes(category);
CREATE INDEX IF NOT EXISTS idx_podcast_templates_agent_id ON podcast_templates(agent_id);
CREATE INDEX IF NOT EXISTS idx_podcast_templates_type ON podcast_templates(template_type);
CREATE INDEX IF NOT EXISTS idx_podcast_segments_episode_id ON podcast_segments(episode_id);
CREATE INDEX IF NOT EXISTS idx_podcast_analytics_episode_id ON podcast_analytics_events(episode_id);
CREATE INDEX IF NOT EXISTS idx_podcast_analytics_event_type ON podcast_analytics_events(event_type);

-- RLS Policies
ALTER TABLE podcast_episodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE podcast_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE podcast_segments ENABLE ROW LEVEL SECURITY;
ALTER TABLE podcast_analytics_events ENABLE ROW LEVEL SECURITY;

-- Podcast Episodes Policies
CREATE POLICY "Users can view their own podcast episodes"
  ON podcast_episodes FOR SELECT
  USING (auth.uid() = agent_id OR EXISTS (
    SELECT 1 FROM auth.users WHERE auth.users.id = auth.uid() AND auth.users.raw_user_meta_data->>'role' IN ('admin', 'broker')
  ));

CREATE POLICY "Users can create their own podcast episodes"
  ON podcast_episodes FOR INSERT
  WITH CHECK (auth.uid() = agent_id);

CREATE POLICY "Users can update their own podcast episodes"
  ON podcast_episodes FOR UPDATE
  USING (auth.uid() = agent_id OR EXISTS (
    SELECT 1 FROM auth.users WHERE auth.users.id = auth.uid() AND auth.users.raw_user_meta_data->>'role' IN ('admin', 'broker')
  ));

CREATE POLICY "Users can delete their own podcast episodes"
  ON podcast_episodes FOR DELETE
  USING (auth.uid() = agent_id);

-- Podcast Templates Policies
CREATE POLICY "Users can view their own podcast templates"
  ON podcast_templates FOR SELECT
  USING (auth.uid() = agent_id OR EXISTS (
    SELECT 1 FROM auth.users WHERE auth.users.id = auth.uid() AND auth.users.raw_user_meta_data->>'role' IN ('admin', 'broker')
  ));

CREATE POLICY "Users can create their own podcast templates"
  ON podcast_templates FOR INSERT
  WITH CHECK (auth.uid() = agent_id);

CREATE POLICY "Users can update their own podcast templates"
  ON podcast_templates FOR UPDATE
  USING (auth.uid() = agent_id);

CREATE POLICY "Users can delete their own podcast templates"
  ON podcast_templates FOR DELETE
  USING (auth.uid() = agent_id);

-- Podcast Segments Policies
CREATE POLICY "Users can view segments of their episodes"
  ON podcast_segments FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM podcast_episodes 
    WHERE podcast_episodes.id = podcast_segments.episode_id 
    AND (podcast_episodes.agent_id = auth.uid() OR EXISTS (
      SELECT 1 FROM auth.users WHERE auth.users.id = auth.uid() AND auth.users.raw_user_meta_data->>'role' IN ('admin', 'broker')
    ))
  ));

CREATE POLICY "Users can create segments for their episodes"
  ON podcast_segments FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM podcast_episodes 
    WHERE podcast_episodes.id = podcast_segments.episode_id 
    AND podcast_episodes.agent_id = auth.uid()
  ));

-- Podcast Analytics Policies
CREATE POLICY "Users can view analytics for their episodes"
  ON podcast_analytics_events FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM podcast_episodes 
    WHERE podcast_episodes.id = podcast_analytics_events.episode_id 
    AND (podcast_episodes.agent_id = auth.uid() OR EXISTS (
      SELECT 1 FROM auth.users WHERE auth.users.id = auth.uid() AND auth.users.raw_user_meta_data->>'role' IN ('admin', 'broker')
    ))
  ));

CREATE POLICY "Anyone can create analytics events"
  ON podcast_analytics_events FOR INSERT
  WITH CHECK (true); -- Allow public tracking

-- Triggers for updated_at
CREATE OR REPLACE FUNCTION update_podcast_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER podcast_episodes_updated_at
  BEFORE UPDATE ON podcast_episodes
  FOR EACH ROW
  EXECUTE FUNCTION update_podcast_updated_at();

CREATE TRIGGER podcast_templates_updated_at
  BEFORE UPDATE ON podcast_templates
  FOR EACH ROW
  EXECUTE FUNCTION update_podcast_updated_at();

-- Trigger to update analytics aggregates
CREATE OR REPLACE FUNCTION update_podcast_analytics_aggregates()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.event_type = 'play' THEN
    UPDATE podcast_episodes 
    SET play_count = play_count + 1 
    WHERE id = NEW.episode_id;
  ELSIF NEW.event_type = 'download' THEN
    UPDATE podcast_episodes 
    SET download_count = download_count + 1 
    WHERE id = NEW.episode_id;
  ELSIF NEW.event_type = 'complete' THEN
    -- Update completion rate
    UPDATE podcast_episodes 
    SET completion_rate = (
      SELECT ROUND(
        (COUNT(*) FILTER (WHERE event_type = 'complete')::DECIMAL / 
        NULLIF(COUNT(*) FILTER (WHERE event_type = 'play'), 0)) * 100, 
        2
      )
      FROM podcast_analytics_events 
      WHERE episode_id = NEW.episode_id
    )
    WHERE id = NEW.episode_id;
  END IF;
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER podcast_analytics_aggregates
  AFTER INSERT ON podcast_analytics_events
  FOR EACH ROW
  EXECUTE FUNCTION update_podcast_analytics_aggregates();
