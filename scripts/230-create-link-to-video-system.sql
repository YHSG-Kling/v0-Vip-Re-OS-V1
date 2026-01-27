-- Link-to-Video Automation System
-- Transforms any URL into social-ready videos with AI voiceovers and subtitles

-- Video Content Queue
CREATE TABLE IF NOT EXISTS video_content_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL,
  organization_type TEXT NOT NULL CHECK (organization_type IN ('brokerage', 'team')),
  
  -- Source and Content
  source_url TEXT NOT NULL,
  content_category TEXT NOT NULL CHECK (content_category IN ('property_listing', 'market_update', 'general_social', 'team_announcement', 'educational', 'other')),
  
  -- Script Management
  ai_generated_script TEXT,
  edited_script TEXT,
  script_status TEXT NOT NULL DEFAULT 'pending' CHECK (script_status IN ('pending', 'approved', 'needs_revision')),
  
  -- Compliance
  compliance_check_passed BOOLEAN DEFAULT false,
  compliance_flags JSONB DEFAULT '[]'::jsonb,
  
  -- Processing Status
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'generating_audio', 'creating_video', 'adding_subtitles', 'completed', 'failed')),
  error_message TEXT,
  
  -- Publishing
  publish_to_socials BOOLEAN DEFAULT false,
  selected_platforms JSONB DEFAULT '[]'::jsonb,
  scheduled_publish_time TIMESTAMPTZ,
  
  -- Generated Assets
  elevenlabs_audio_url TEXT,
  audio_duration_seconds NUMERIC,
  scrolling_video_url TEXT,
  video_with_audio_url TEXT,
  final_video_with_subtitles_url TEXT,
  
  -- Social Media
  social_caption TEXT,
  is_published BOOLEAN DEFAULT false,
  published_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Organizations Branding (extend existing brokerages table)
ALTER TABLE brokerages ADD COLUMN IF NOT EXISTS branding_settings JSONB DEFAULT '{
  "logo_url": null,
  "primary_color": "#3b82f6",
  "secondary_color": "#1e40af",
  "font_family": "Inter"
}'::jsonb;

ALTER TABLE brokerages ADD COLUMN IF NOT EXISTS video_templates JSONB DEFAULT '{
  "subtitle_style": {
    "font_size": "medium",
    "font_family": "Inter",
    "text_color": "#ffffff",
    "background_color": "#000000",
    "position": "bottom"
  },
  "default_voiceover_voice_id": "21m00Tcm4TlvDq8ikWAM",
  "scroll_speed": "medium",
  "brand_overlay_position": "bottom_right"
}'::jsonb;

ALTER TABLE brokerages ADD COLUMN IF NOT EXISTS compliance_rules JSONB DEFAULT '{
  "restricted_keywords": ["perfect for families", "church nearby", "young professionals", "great schools", "safe neighborhood"],
  "required_disclaimers": ["Licensed Real Estate Agent", "Equal Housing Opportunity"],
  "auto_approval_enabled": false,
  "requires_broker_approval": true
}'::jsonb;

-- Teams Branding Override
CREATE TABLE IF NOT EXISTS teams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  parent_brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  team_lead_id UUID REFERENCES auth.users(id),
  branding_override JSONB,
  video_template_override JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Video Processing Log
CREATE TABLE IF NOT EXISTS video_processing_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_queue_id UUID NOT NULL REFERENCES video_content_queue(id) ON DELETE CASCADE,
  step TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  error_details TEXT,
  processing_time_seconds NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Social Publishing Results
CREATE TABLE IF NOT EXISTS video_social_publishes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_queue_id UUID NOT NULL REFERENCES video_content_queue(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  platform_post_id TEXT,
  publish_status TEXT NOT NULL CHECK (publish_status IN ('success', 'failed', 'pending')),
  error_message TEXT,
  post_url TEXT,
  engagement_metrics JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_video_queue_user ON video_content_queue(user_id);
CREATE INDEX IF NOT EXISTS idx_video_queue_org ON video_content_queue(organization_id);
CREATE INDEX IF NOT EXISTS idx_video_queue_status ON video_content_queue(status);
CREATE INDEX IF NOT EXISTS idx_video_queue_created ON video_content_queue(created_at DESC);

-- RLS Policies
ALTER TABLE video_content_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_processing_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_social_publishes ENABLE ROW LEVEL SECURITY;
ALTER TABLE teams ENABLE ROW LEVEL SECURITY;

-- Agents see their own videos
CREATE POLICY video_queue_agent_policy ON video_content_queue
  FOR ALL USING (auth.uid() = user_id);

-- Brokers see all videos in their brokerage
CREATE POLICY video_queue_broker_policy ON video_content_queue
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM auth.users u
      WHERE u.id = auth.uid()
      AND u.role IN ('broker', 'admin')
      AND u.brokerage_id::text = video_content_queue.organization_id::text
    )
  );

CREATE POLICY video_processing_log_policy ON video_processing_log
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM video_content_queue vq
      WHERE vq.id = video_processing_log.video_queue_id
      AND vq.user_id = auth.uid()
    )
  );

CREATE POLICY video_social_publishes_policy ON video_social_publishes
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM video_content_queue vq
      WHERE vq.id = video_social_publishes.video_queue_id
      AND vq.user_id = auth.uid()
    )
  );

CREATE POLICY teams_policy ON teams
  FOR ALL USING (
    auth.uid() = team_lead_id OR
    EXISTS (
      SELECT 1 FROM auth.users u
      WHERE u.id = auth.uid()
      AND u.role IN ('broker', 'admin')
    )
  );

-- Trigger for updated_at
CREATE OR REPLACE FUNCTION update_video_queue_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER video_queue_updated_at
  BEFORE UPDATE ON video_content_queue
  FOR EACH ROW
  EXECUTE FUNCTION update_video_queue_updated_at();
