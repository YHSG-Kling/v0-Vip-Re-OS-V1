-- HeyGen Video Generation System
-- Production-ready schema for AI video creation with cloned voices and avatars

-- Table: heygen_avatars
-- Stores available HeyGen avatar configurations
CREATE TABLE IF NOT EXISTS heygen_avatars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  avatar_id TEXT NOT NULL UNIQUE, -- HeyGen avatar ID
  avatar_name TEXT NOT NULL,
  avatar_type TEXT NOT NULL CHECK (avatar_type IN ('default', 'custom', 'photo', 'studio')),
  gender TEXT CHECK (gender IN ('male', 'female', 'neutral')),
  thumbnail_url TEXT,
  preview_video_url TEXT,
  style_tags TEXT[], -- ['professional', 'casual', 'formal']
  is_active BOOLEAN DEFAULT true,
  is_custom BOOLEAN DEFAULT false, -- Custom cloned avatar
  user_id UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table: heygen_voices
-- Stores available voice configurations including cloned voices
CREATE TABLE IF NOT EXISTS heygen_voices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  voice_id TEXT NOT NULL UNIQUE, -- HeyGen voice ID
  voice_name TEXT NOT NULL,
  voice_type TEXT NOT NULL CHECK (voice_type IN ('default', 'cloned', 'instant')),
  gender TEXT CHECK (gender IN ('male', 'female')),
  language TEXT NOT NULL DEFAULT 'en',
  accent TEXT, -- 'us', 'uk', 'au'
  preview_audio_url TEXT,
  style_tags TEXT[], -- ['warm', 'professional', 'energetic']
  is_active BOOLEAN DEFAULT true,
  is_custom BOOLEAN DEFAULT false, -- Custom cloned voice
  user_id UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table: heygen_video_templates
-- Stores video templates for different use cases
CREATE TABLE IF NOT EXISTS heygen_video_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_name TEXT NOT NULL,
  template_type TEXT NOT NULL CHECK (template_type IN ('listing_promo', 'market_update', 'testimonial', 'open_house', 'agent_intro', 'neighborhood_tour', 'custom')),
  description TEXT,
  default_avatar_id UUID REFERENCES heygen_avatars(id),
  default_voice_id UUID REFERENCES heygen_voices(id),
  default_background_type TEXT DEFAULT 'solid' CHECK (default_background_type IN ('solid', 'image', 'video', 'green_screen')),
  default_background_value TEXT, -- Color hex, image URL, or video URL
  script_template TEXT, -- Template with placeholders like {{property_address}}
  duration_seconds INTEGER DEFAULT 30,
  aspect_ratio TEXT DEFAULT '16:9' CHECK (aspect_ratio IN ('16:9', '9:16', '1:1', '4:5')),
  is_active BOOLEAN DEFAULT true,
  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table: heygen_video_projects
-- Stores video generation projects and their configurations
CREATE TABLE IF NOT EXISTS heygen_video_projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id),
  project_name TEXT NOT NULL,
  template_id UUID REFERENCES heygen_video_templates(id),
  avatar_id UUID REFERENCES heygen_avatars(id),
  voice_id UUID REFERENCES heygen_voices(id),
  script_text TEXT NOT NULL,
  background_type TEXT DEFAULT 'solid' CHECK (background_type IN ('solid', 'image', 'video', 'green_screen')),
  background_value TEXT,
  aspect_ratio TEXT DEFAULT '16:9' CHECK (aspect_ratio IN ('16:9', '9:16', '1:1', '4:5')),
  duration_seconds INTEGER,
  
  -- HeyGen API metadata
  heygen_video_id TEXT UNIQUE,
  heygen_job_id TEXT,
  
  -- Status tracking
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'queued', 'processing', 'completed', 'failed', 'cancelled')),
  progress_percentage INTEGER DEFAULT 0,
  error_message TEXT,
  
  -- Output URLs
  video_url TEXT,
  thumbnail_url TEXT,
  
  -- Usage tracking
  generation_started_at TIMESTAMPTZ,
  generation_completed_at TIMESTAMPTZ,
  duration_ms INTEGER, -- Processing time in milliseconds
  
  -- Distribution
  published_to_platforms TEXT[], -- ['youtube', 'instagram', 'facebook']
  published_at TIMESTAMPTZ,
  
  -- Metadata
  tags TEXT[],
  related_listing_id UUID,
  related_contact_id UUID,
  related_campaign_id UUID,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table: heygen_api_usage
-- Tracks API usage for billing and analytics
CREATE TABLE IF NOT EXISTS heygen_api_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id),
  project_id UUID REFERENCES heygen_video_projects(id),
  action_type TEXT NOT NULL CHECK (action_type IN ('video_generation', 'avatar_training', 'voice_cloning', 'template_render')),
  credits_used INTEGER DEFAULT 1,
  duration_seconds INTEGER,
  api_response JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Table: heygen_webhooks
-- Stores webhook events from HeyGen for status updates
CREATE TABLE IF NOT EXISTS heygen_webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  heygen_video_id TEXT,
  heygen_job_id TEXT,
  payload JSONB NOT NULL,
  processed BOOLEAN DEFAULT false,
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_heygen_avatars_user ON heygen_avatars(user_id) WHERE is_custom = true;
CREATE INDEX IF NOT EXISTS idx_heygen_avatars_active ON heygen_avatars(is_active);
CREATE INDEX IF NOT EXISTS idx_heygen_voices_user ON heygen_voices(user_id) WHERE is_custom = true;
CREATE INDEX IF NOT EXISTS idx_heygen_voices_active ON heygen_voices(is_active);
CREATE INDEX IF NOT EXISTS idx_heygen_templates_type ON heygen_video_templates(template_type);
CREATE INDEX IF NOT EXISTS idx_heygen_projects_agent ON heygen_video_projects(agent_id);
CREATE INDEX IF NOT EXISTS idx_heygen_projects_status ON heygen_video_projects(status);
CREATE INDEX IF NOT EXISTS idx_heygen_projects_heygen_id ON heygen_video_projects(heygen_video_id);
CREATE INDEX IF NOT EXISTS idx_heygen_usage_agent ON heygen_api_usage(agent_id);
CREATE INDEX IF NOT EXISTS idx_heygen_webhooks_processed ON heygen_webhooks(processed, created_at);

-- RLS Policies
ALTER TABLE heygen_avatars ENABLE ROW LEVEL SECURITY;
ALTER TABLE heygen_voices ENABLE ROW LEVEL SECURITY;
ALTER TABLE heygen_video_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE heygen_video_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE heygen_api_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE heygen_webhooks ENABLE ROW LEVEL SECURITY;

-- Avatars: Users can view all active avatars, manage their own custom avatars
CREATE POLICY heygen_avatars_select ON heygen_avatars FOR SELECT TO authenticated USING (is_active = true OR user_id = auth.uid());
CREATE POLICY heygen_avatars_insert ON heygen_avatars FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY heygen_avatars_update ON heygen_avatars FOR UPDATE TO authenticated USING (user_id = auth.uid());

-- Voices: Users can view all active voices, manage their own cloned voices
CREATE POLICY heygen_voices_select ON heygen_voices FOR SELECT TO authenticated USING (is_active = true OR user_id = auth.uid());
CREATE POLICY heygen_voices_insert ON heygen_voices FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
CREATE POLICY heygen_voices_update ON heygen_voices FOR UPDATE TO authenticated USING (user_id = auth.uid());

-- Templates: Users can view all active templates, create their own
CREATE POLICY heygen_templates_select ON heygen_video_templates FOR SELECT TO authenticated USING (is_active = true);
CREATE POLICY heygen_templates_insert ON heygen_video_templates FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
CREATE POLICY heygen_templates_update ON heygen_video_templates FOR UPDATE TO authenticated USING (created_by = auth.uid());

-- Projects: Users can only access their own projects
CREATE POLICY heygen_projects_select ON heygen_video_projects FOR SELECT TO authenticated USING (agent_id = auth.uid());
CREATE POLICY heygen_projects_insert ON heygen_video_projects FOR INSERT TO authenticated WITH CHECK (agent_id = auth.uid());
CREATE POLICY heygen_projects_update ON heygen_video_projects FOR UPDATE TO authenticated USING (agent_id = auth.uid());
CREATE POLICY heygen_projects_delete ON heygen_video_projects FOR DELETE TO authenticated USING (agent_id = auth.uid());

-- API Usage: Users can view their own usage
CREATE POLICY heygen_usage_select ON heygen_api_usage FOR SELECT TO authenticated USING (agent_id = auth.uid());

-- Webhooks: System only (no user access)
CREATE POLICY heygen_webhooks_system ON heygen_webhooks FOR ALL TO service_role USING (true);

-- Trigger: Update updated_at timestamp
CREATE OR REPLACE FUNCTION update_heygen_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_heygen_avatars_updated_at BEFORE UPDATE ON heygen_avatars FOR EACH ROW EXECUTE FUNCTION update_heygen_updated_at();
CREATE TRIGGER update_heygen_voices_updated_at BEFORE UPDATE ON heygen_voices FOR EACH ROW EXECUTE FUNCTION update_heygen_updated_at();
CREATE TRIGGER update_heygen_templates_updated_at BEFORE UPDATE ON heygen_video_templates FOR EACH ROW EXECUTE FUNCTION update_heygen_updated_at();
CREATE TRIGGER update_heygen_projects_updated_at BEFORE UPDATE ON heygen_video_projects FOR EACH ROW EXECUTE FUNCTION update_heygen_updated_at();

-- Insert default avatars (these should match your HeyGen account avatars)
INSERT INTO heygen_avatars (avatar_id, avatar_name, avatar_type, gender, style_tags, is_active) VALUES
  ('josh_lite3_20230714', 'Josh - Professional', 'default', 'male', ARRAY['professional', 'business', 'friendly'], true),
  ('anna_costume1_cameraA_20220818', 'Anna - Business', 'default', 'female', ARRAY['professional', 'corporate', 'confident'], true),
  ('tyler_front_20220721', 'Tyler - Casual', 'default', 'male', ARRAY['casual', 'approachable', 'energetic'], true),
  ('monica_costume1_cameraA_20220818', 'Monica - Modern', 'default', 'female', ARRAY['modern', 'professional', 'warm'], true)
ON CONFLICT (avatar_id) DO NOTHING;

-- Insert default voices
INSERT INTO heygen_voices (voice_id, voice_name, voice_type, gender, language, accent, style_tags, is_active) VALUES
  ('1bd001e7e50f421d891986aad5158bc8', 'Michael - US Professional', 'default', 'male', 'en', 'us', ARRAY['professional', 'clear', 'authoritative'], true),
  ('2d5b0e6cf36f44b9bb5b74d6eb5d35c9', 'Jennifer - US Friendly', 'default', 'female', 'en', 'us', ARRAY['friendly', 'warm', 'conversational'], true),
  ('3c7d1f2a8e4b4c6f9a1d3e5b7c9a2f4e', 'David - UK Professional', 'default', 'male', 'en', 'uk', ARRAY['professional', 'refined', 'trustworthy'], true),
  ('4f8e2b3c9d5a6e7f8b1c2d3e4a5b6c7d', 'Sarah - US Energetic', 'default', 'female', 'en', 'us', ARRAY['energetic', 'enthusiastic', 'dynamic'], true)
ON CONFLICT (voice_id) DO NOTHING;

-- Insert default templates
INSERT INTO heygen_video_templates (template_name, template_type, description, script_template, duration_seconds, aspect_ratio) VALUES
  ('Listing Promo - Standard', 'listing_promo', 'Professional listing promotion video', 'Hi, I''m here to tell you about an amazing property at {{property_address}}. This {{bedrooms}} bedroom, {{bathrooms}} bathroom home features {{highlights}}. Priced at {{price}}, this won''t last long. Contact me today to schedule a showing!', 30, '16:9'),
  ('Market Update - Monthly', 'market_update', 'Monthly market update for social media', 'Welcome to your {{month}} market update! In {{city}}, we''re seeing {{trend}}. Average home prices are {{price_trend}}, and inventory is {{inventory_status}}. If you''re thinking of buying or selling, now is {{timing_message}}. Let''s connect!', 45, '9:16'),
  ('Open House Announcement', 'open_house', 'Exciting open house invitation', 'Join me this {{day}} at {{time}} for an exclusive open house at {{property_address}}! This stunning {{property_type}} offers {{highlights}}. Don''t miss this opportunity to see it in person. See you there!', 25, '1:1'),
  ('Agent Introduction', 'agent_intro', 'Professional agent introduction', 'Hi! I''m {{agent_name}}, your local real estate expert in {{area}}. With {{years}} years of experience, I specialize in {{specialties}}. Whether you''re buying or selling, I''m here to guide you every step of the way. Let''s make your real estate dreams a reality!', 35, '16:9')
ON CONFLICT DO NOTHING;
