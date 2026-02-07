-- Create video_templates table
CREATE TABLE IF NOT EXISTS video_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  template_name text NOT NULL,
  category text NOT NULL,
  description text,
  thumbnail_url text,
  default_script text,
  duration_seconds integer,
  recommended_for text[],
  tags text[],
  sort_order integer DEFAULT 0,
  is_active boolean DEFAULT true,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Create video_branding_presets table
CREATE TABLE IF NOT EXISTS video_branding_presets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
  preset_name text NOT NULL,
  logo_url text,
  primary_color text,
  secondary_color text,
  font_family text,
  intro_animation text,
  outro_animation text,
  watermark_position text,
  social_handles jsonb,
  is_default boolean DEFAULT false,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_video_templates_category ON video_templates(category);
CREATE INDEX IF NOT EXISTS idx_video_templates_active ON video_templates(is_active);
CREATE INDEX IF NOT EXISTS idx_video_branding_presets_agent ON video_branding_presets(agent_id);

-- Enable RLS
ALTER TABLE video_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE video_branding_presets ENABLE ROW LEVEL SECURITY;

-- RLS Policies for video_templates (public read)
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'video_templates' AND policyname = 'Anyone can view active templates'
  ) THEN
    CREATE POLICY "Anyone can view active templates"
      ON video_templates
      FOR SELECT
      USING (is_active = true);
  END IF;
END $$;

-- RLS Policies for video_branding_presets
DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'video_branding_presets' AND policyname = 'Agents can view their presets'
  ) THEN
    CREATE POLICY "Agents can view their presets"
      ON video_branding_presets
      FOR SELECT
      USING (
        agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid())
        OR is_default = true
      );
  END IF;
END $$;

DO $$ 
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'video_branding_presets' AND policyname = 'Agents can manage their presets'
  ) THEN
    CREATE POLICY "Agents can manage their presets"
      ON video_branding_presets
      FOR ALL
      USING (agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid()))
      WITH CHECK (agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid()));
  END IF;
END $$;

-- Insert default video templates
INSERT INTO video_templates (template_name, category, description, default_script, duration_seconds, recommended_for, tags, sort_order, is_active) 
VALUES 
  ('Agent Introduction', 'personal_brand', 'Professional agent introduction video', 'Hi, I''m your dedicated real estate professional...', 60, ARRAY['new_agents', 'personal_branding'], ARRAY['intro', 'personal', 'brand'], 1, true),
  ('Listing Tour', 'property_marketing', 'Property walkthrough template', 'Welcome to this stunning property...', 90, ARRAY['listings', 'sellers'], ARRAY['property', 'tour', 'listing'], 2, true),
  ('Market Update', 'market_insights', 'Monthly market analysis template', 'Let''s talk about what''s happening in the market...', 75, ARRAY['buyers', 'sellers', 'investors'], ARRAY['market', 'stats', 'trends'], 3, true),
  ('Buyer Message', 'client_engagement', 'Personalized buyer outreach', 'I was thinking of you today...', 45, ARRAY['buyers', 'leads'], ARRAY['personalized', 'buyer', 'outreach'], 4, true),
  ('Open House Promo', 'event_promotion', 'Open house invitation video', 'Join me this weekend for an exclusive open house...', 30, ARRAY['open_house', 'listings'], ARRAY['event', 'open_house', 'invite'], 5, true)
ON CONFLICT DO NOTHING;
