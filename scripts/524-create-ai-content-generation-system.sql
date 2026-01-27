-- AI Content Generation System using Vercel AI SDK (Gemini)
-- Comprehensive system for blog posts, social media, emails, listing descriptions
-- Migrated from Airtable + n8n + Softr stack

-- 1. AI Generated Content (main content storage)
CREATE TABLE IF NOT EXISTS ai_generated_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Content Classification
  content_type TEXT NOT NULL CHECK (content_type IN (
    'blog_post', 'social_post', 'email', 'listing_description', 
    'property_flyer', 'market_report', 'newsletter', 'ad_copy'
  )),
  
  -- Core Content
  generated_text TEXT NOT NULL,
  ai_model_used TEXT DEFAULT 'gemini-2.0-flash-exp',
  persona_target TEXT,
  prompt_used TEXT NOT NULL, -- Full AI prompt for reproducibility
  
  -- Foreign Keys
  agent_id UUID REFERENCES users(id) ON DELETE CASCADE,
  property_id UUID, -- References properties.id
  client_id UUID, -- References leads.id or contacts.id
  
  -- Approval Workflow
  approval_status TEXT DEFAULT 'draft' CHECK (approval_status IN (
    'draft', 'pending_review', 'approved', 'rejected', 'needs_revision', 'published'
  )),
  compliance_checked BOOLEAN DEFAULT false,
  compliance_flags JSONB DEFAULT '[]'::JSONB,
  
  -- Publishing
  published_at TIMESTAMPTZ,
  published_to TEXT[], -- Platforms where published
  
  -- Performance Metrics
  performance_score NUMERIC DEFAULT 0,
  engagement_metrics JSONB DEFAULT '{}'::JSONB, -- {opens, clicks, shares, conversions}
  
  -- Content Quality Scores
  seo_score NUMERIC,
  readability_score NUMERIC, -- Flesch reading ease
  word_count INTEGER,
  estimated_read_time INTEGER, -- minutes
  
  -- Metadata
  metadata JSONB DEFAULT '{}'::JSONB -- {subject_line, preview_text, hashtags, featured_image_url}
);

CREATE INDEX IF NOT EXISTS idx_ai_content_type ON ai_generated_content(content_type);
CREATE INDEX IF NOT EXISTS idx_ai_content_agent ON ai_generated_content(agent_id);
CREATE INDEX IF NOT EXISTS idx_ai_content_status ON ai_generated_content(approval_status);
CREATE INDEX IF NOT EXISTS idx_ai_content_persona ON ai_generated_content(persona_target);
CREATE INDEX IF NOT EXISTS idx_ai_content_performance ON ai_generated_content(performance_score DESC);
CREATE INDEX IF NOT EXISTS idx_ai_content_created ON ai_generated_content(created_at DESC);

-- 2. Content Templates (reusable prompts with variables)
CREATE TABLE IF NOT EXISTS content_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  template_name TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN (
    'blog_post', 'social_post', 'email', 'listing_description', 
    'property_flyer', 'market_report', 'newsletter', 'ad_copy'
  )),
  
  -- Template Configuration
  base_prompt TEXT NOT NULL, -- AI prompt with {{variables}}
  variables JSONB NOT NULL DEFAULT '[]'::JSONB, -- [{name, type, required, description}]
  
  -- Persona Targeting
  persona_specific BOOLEAN DEFAULT false,
  target_personas TEXT[],
  
  -- Brand Voice
  brand_voice_settings JSONB DEFAULT '{}'::JSONB, -- {tone, style, avoid_words, key_phrases}
  example_output TEXT,
  
  -- Performance Tracking
  performance_avg_score NUMERIC DEFAULT 0,
  usage_count INTEGER DEFAULT 0,
  
  -- Ownership
  created_by_agent_id UUID REFERENCES users(id) ON DELETE SET NULL,
  is_public BOOLEAN DEFAULT false, -- Share across team
  category TEXT -- "Welcome Sequences", "Nurture", "Promotional"
);

CREATE INDEX IF NOT EXISTS idx_templates_type ON content_templates(content_type);
CREATE INDEX IF NOT EXISTS idx_templates_performance ON content_templates(performance_avg_score DESC);
CREATE INDEX IF NOT EXISTS idx_templates_category ON content_templates(category);

-- 3. Brand Voice Profile (agent-specific writing style)
CREATE TABLE IF NOT EXISTS brand_voice_profile (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Voice Characteristics
  tone TEXT DEFAULT 'professional' CHECK (tone IN (
    'professional', 'casual', 'luxury', 'friendly', 'authoritative', 'warm'
  )),
  formality_level INTEGER DEFAULT 3 CHECK (formality_level BETWEEN 1 AND 5), -- 1=very casual, 5=very formal
  
  -- Language Preferences
  key_phrases TEXT[] DEFAULT '{}',
  avoid_words TEXT[] DEFAULT '{}',
  writing_style_notes TEXT,
  sample_content TEXT[] DEFAULT '{}', -- 3-5 examples of agent's writing
  
  -- Writing Style
  emoji_usage TEXT DEFAULT 'minimal' CHECK (emoji_usage IN ('none', 'minimal', 'moderate', 'liberal')),
  preferred_sentence_length TEXT DEFAULT 'varied' CHECK (preferred_sentence_length IN ('short', 'medium', 'long', 'varied')),
  industry_jargon_level TEXT DEFAULT 'minimal' CHECK (industry_jargon_level IN ('avoid', 'minimal', 'moderate', 'heavy')),
  
  -- Content Approach
  storytelling_approach BOOLEAN DEFAULT true,
  data_heavy BOOLEAN DEFAULT false, -- Prefers stats/numbers
  ai_learning_enabled BOOLEAN DEFAULT true -- Learn from agent's edits
);

CREATE INDEX IF NOT EXISTS idx_brand_voice_agent ON brand_voice_profile(agent_id);

-- 4. SEO Keywords (keyword research and tracking)
CREATE TABLE IF NOT EXISTS seo_keywords (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  keyword TEXT UNIQUE NOT NULL,
  search_volume INTEGER DEFAULT 0, -- Monthly searches
  competition_level TEXT DEFAULT 'medium' CHECK (competition_level IN ('low', 'medium', 'high')),
  
  -- Location
  location_specific TEXT, -- City/region
  category TEXT, -- "buyer", "seller", "neighborhood", "general"
  
  -- Related Terms
  related_keywords TEXT[] DEFAULT '{}',
  
  -- Performance
  last_updated TIMESTAMPTZ DEFAULT NOW(),
  performance_data JSONB DEFAULT '{}'::JSONB -- {avg_ranking, click_rate}
);

CREATE INDEX IF NOT EXISTS idx_seo_keywords_location ON seo_keywords(location_specific);
CREATE INDEX IF NOT EXISTS idx_seo_keywords_volume ON seo_keywords(search_volume DESC);
CREATE INDEX IF NOT EXISTS idx_seo_keywords_category ON seo_keywords(category);

-- 5. Content Performance Tracking (detailed analytics)
CREATE TABLE IF NOT EXISTS content_performance_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id UUID REFERENCES ai_generated_content(id) ON DELETE CASCADE,
  tracked_date DATE NOT NULL DEFAULT CURRENT_DATE,
  platform TEXT NOT NULL, -- "email", "instagram", "blog", etc.
  
  -- Engagement Metrics
  impressions INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  opens INTEGER DEFAULT 0, -- For emails
  clicks INTEGER DEFAULT 0,
  engagement_rate NUMERIC DEFAULT 0,
  
  -- Social Metrics
  shares INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  saves INTEGER DEFAULT 0, -- For social
  
  -- Conversion Metrics
  conversions INTEGER DEFAULT 0, -- Led to action
  bounce_rate NUMERIC, -- For emails/blog
  time_on_page INTEGER, -- Seconds
  revenue_attributed NUMERIC DEFAULT 0,
  
  UNIQUE(content_id, tracked_date, platform)
);

CREATE INDEX IF NOT EXISTS idx_performance_content ON content_performance_tracking(content_id);
CREATE INDEX IF NOT EXISTS idx_performance_date ON content_performance_tracking(tracked_date DESC);
CREATE INDEX IF NOT EXISTS idx_performance_platform ON content_performance_tracking(platform);

-- 6. Hashtag Performance (social media optimization)
CREATE TABLE IF NOT EXISTS hashtag_performance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  hashtag TEXT NOT NULL, -- Without # symbol
  platform TEXT NOT NULL CHECK (platform IN ('instagram', 'facebook', 'linkedin', 'twitter', 'tiktok')),
  
  -- Performance Metrics
  total_uses INTEGER DEFAULT 0,
  avg_impressions NUMERIC DEFAULT 0,
  avg_engagement_rate NUMERIC DEFAULT 0,
  
  -- Competition Analysis
  competition_level TEXT DEFAULT 'medium' CHECK (competition_level IN ('low', 'medium', 'high')),
  trend_status TEXT DEFAULT 'stable' CHECK (trend_status IN ('rising', 'stable', 'declining')),
  
  -- Categorization
  category TEXT, -- "location", "property_type", "lifestyle", etc.
  last_used TIMESTAMPTZ,
  banned BOOLEAN DEFAULT false, -- Flagged by platform
  
  UNIQUE(hashtag, platform)
);

CREATE INDEX IF NOT EXISTS idx_hashtag_platform ON hashtag_performance(platform);
CREATE INDEX IF NOT EXISTS idx_hashtag_performance ON hashtag_performance(avg_engagement_rate DESC);
CREATE INDEX IF NOT EXISTS idx_hashtag_category ON hashtag_performance(category);

-- 7. Content A/B Tests (experimentation framework)
CREATE TABLE IF NOT EXISTS content_ab_tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  
  -- Variants
  variant_a_id UUID REFERENCES ai_generated_content(id) ON DELETE CASCADE,
  variant_b_id UUID REFERENCES ai_generated_content(id) ON DELETE CASCADE,
  
  -- Test Configuration
  test_variable TEXT NOT NULL, -- "subject_line", "opening_hook", "cta_placement", etc.
  started_at TIMESTAMPTZ DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  sample_size_per_variant INTEGER,
  
  -- Results
  winner_variant CHAR(1) CHECK (winner_variant IN ('A', 'B')),
  confidence_level NUMERIC, -- Statistical confidence
  results_summary JSONB DEFAULT '{}'::JSONB, -- {variant_a_rate, variant_b_rate, improvement_percentage}
  declared_winner_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_ab_test_type ON content_ab_tests(content_type);
CREATE INDEX IF NOT EXISTS idx_ab_test_active ON content_ab_tests(ended_at) WHERE ended_at IS NULL;

-- 8. Content Generation Logs (AI usage tracking and costs)
CREATE TABLE IF NOT EXISTS content_generation_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  content_id UUID REFERENCES ai_generated_content(id) ON DELETE SET NULL,
  generated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- AI Configuration
  model_used TEXT NOT NULL,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  cost_usd NUMERIC(10, 6) DEFAULT 0,
  
  -- Performance
  generation_time_ms INTEGER,
  temperature NUMERIC DEFAULT 0.7,
  max_tokens INTEGER,
  
  -- Status
  success BOOLEAN DEFAULT true,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_generation_logs_content ON content_generation_logs(content_id);
CREATE INDEX IF NOT EXISTS idx_generation_logs_date ON content_generation_logs(generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_generation_logs_model ON content_generation_logs(model_used);

-- Enable Row Level Security
ALTER TABLE ai_generated_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE brand_voice_profile ENABLE ROW LEVEL SECURITY;
ALTER TABLE seo_keywords ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_performance_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE hashtag_performance ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_ab_tests ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_generation_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policies for ai_generated_content
CREATE POLICY "Users can view their own content" ON ai_generated_content
  FOR SELECT USING (agent_id = auth.uid() OR agent_id IS NULL);

CREATE POLICY "Users can create their own content" ON ai_generated_content
  FOR INSERT WITH CHECK (agent_id = auth.uid() OR agent_id IS NULL);

CREATE POLICY "Users can update their own content" ON ai_generated_content
  FOR UPDATE USING (agent_id = auth.uid());

CREATE POLICY "Users can delete their own content" ON ai_generated_content
  FOR DELETE USING (agent_id = auth.uid());

-- RLS Policies for content_templates
CREATE POLICY "Users can view public templates or their own" ON content_templates
  FOR SELECT USING (is_public = true OR created_by_agent_id = auth.uid());

CREATE POLICY "Users can create templates" ON content_templates
  FOR INSERT WITH CHECK (created_by_agent_id = auth.uid());

CREATE POLICY "Users can update their own templates" ON content_templates
  FOR UPDATE USING (created_by_agent_id = auth.uid());

-- RLS Policies for brand_voice_profile
CREATE POLICY "Users can view their own brand voice" ON brand_voice_profile
  FOR SELECT USING (agent_id = auth.uid());

CREATE POLICY "Users can create their brand voice" ON brand_voice_profile
  FOR INSERT WITH CHECK (agent_id = auth.uid());

CREATE POLICY "Users can update their brand voice" ON brand_voice_profile
  FOR UPDATE USING (agent_id = auth.uid());

-- Public read for SEO keywords and hashtags
CREATE POLICY "Anyone can view seo keywords" ON seo_keywords FOR SELECT USING (true);
CREATE POLICY "Anyone can view hashtag performance" ON hashtag_performance FOR SELECT USING (true);

COMMIT;
