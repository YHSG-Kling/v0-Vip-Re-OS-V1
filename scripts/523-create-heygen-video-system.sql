-- Enhanced AI Video Generation System with HeyGen Integration
-- Version: 1.0
-- Adds missing tables for video scripts library, performance tracking, and generation queue

-- ============================================
-- VIDEO SCRIPTS LIBRARY (Templates)
-- ============================================

CREATE TABLE IF NOT EXISTS video_scripts_library (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_name TEXT NOT NULL,
  template_type TEXT NOT NULL, -- 'listing_tour', 'agent_intro', 'market_update', 'testimonial', 'memory_video', 'personalized_buyer', 'open_house_promo'
  base_prompt TEXT NOT NULL, -- The AI prompt template with {{variables}}
  variables JSONB NOT NULL DEFAULT '[]', -- [{name, type, description, required}]
  ai_enhancement_notes TEXT,
  created_by_agent_id UUID,
  brokerage_id UUID,
  is_public BOOLEAN DEFAULT false,
  performance_avg_score DECIMAL(5,2),
  usage_count INTEGER DEFAULT 0,
  tags TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_scripts_library_type ON video_scripts_library(template_type);
CREATE INDEX IF NOT EXISTS idx_video_scripts_library_agent ON video_scripts_library(created_by_agent_id);
CREATE INDEX IF NOT EXISTS idx_video_scripts_library_brokerage ON video_scripts_library(brokerage_id);

-- ============================================
-- VIDEO PERFORMANCE TRACKING
-- ============================================

CREATE TABLE IF NOT EXISTS video_performance_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_id UUID NOT NULL,
  tracked_date DATE NOT NULL DEFAULT CURRENT_DATE,
  views INTEGER DEFAULT 0,
  unique_viewers INTEGER DEFAULT 0,
  avg_watch_percentage DECIMAL(5,2) DEFAULT 0,
  completion_rate DECIMAL(5,2) DEFAULT 0,
  engagement_score DECIMAL(5,2) DEFAULT 0, -- calculated: (completion_rate * 0.5) + (views * 0.3) + (shares * 0.2)
  shares INTEGER DEFAULT 0,
  clicks_to_action INTEGER DEFAULT 0,
  led_to_conversion BOOLEAN DEFAULT false,
  conversion_type TEXT, -- 'appointment', 'offer', 'showing', 'call'
  client_feedback_rating INTEGER CHECK (client_feedback_rating BETWEEN 1 AND 5),
  client_feedback_comment TEXT,
  device_breakdown JSONB DEFAULT '{"mobile": 0, "desktop": 0, "tablet": 0}',
  geographic_distribution JSONB DEFAULT '{}',
  drop_off_timestamps JSONB DEFAULT '[]', -- [{timestamp_seconds: 45, viewer_count: 12}]
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_performance_video ON video_performance_tracking(video_id);
CREATE INDEX IF NOT EXISTS idx_video_performance_date ON video_performance_tracking(tracked_date);
CREATE UNIQUE INDEX IF NOT EXISTS idx_video_performance_video_date ON video_performance_tracking(video_id, tracked_date);

-- ============================================
-- VIDEO GENERATION QUEUE
-- ============================================

CREATE TABLE IF NOT EXISTS video_generation_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_project_id UUID NOT NULL,
  priority INTEGER DEFAULT 5 CHECK (priority BETWEEN 1 AND 10), -- 1=highest, 10=lowest
  queued_at TIMESTAMPTZ DEFAULT NOW(),
  started_processing_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  failed_at TIMESTAMPTZ,
  status TEXT DEFAULT 'queued', -- 'queued', 'processing', 'completed', 'failed'
  retry_count INTEGER DEFAULT 0,
  error_message TEXT,
  heygen_job_id TEXT,
  estimated_completion_minutes INTEGER,
  actual_processing_seconds INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_queue_status ON video_generation_queue(status);
CREATE INDEX IF NOT EXISTS idx_video_queue_project ON video_generation_queue(video_project_id);
CREATE INDEX IF NOT EXISTS idx_video_queue_priority ON video_generation_queue(priority, queued_at);

-- ============================================
-- MEMORY VIDEO RESPONSES (Seller Interviews)
-- ============================================

CREATE TABLE IF NOT EXISTS memory_video_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_project_id UUID,
  seller_id UUID, -- contact_id or lead_id
  property_address TEXT NOT NULL,
  years_lived INTEGER,
  favorite_memories TEXT,
  will_miss_most TEXT,
  life_events JSONB DEFAULT '[]', -- [{type: 'raised_children', details: '...'}]
  special_features TEXT,
  moving_destination TEXT,
  moving_reason TEXT,
  message_to_new_owners TEXT,
  additional_notes TEXT,
  agent_id UUID,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_video_seller ON memory_video_responses(seller_id);
CREATE INDEX IF NOT EXISTS idx_memory_video_project ON memory_video_responses(video_project_id);

-- ============================================
-- VIDEO RECOMMENDATIONS (AI-Generated)
-- ============================================

CREATE TABLE IF NOT EXISTS video_recommendations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  recommendation_type TEXT NOT NULL, -- 'high_priority', 'upcoming_opportunity', 'listing_opportunity', 'engagement_drop'
  video_type_suggested TEXT NOT NULL,
  target_client_id UUID, -- lead_id or contact_id
  target_property_id UUID,
  reason TEXT NOT NULL,
  ai_confidence_score DECIMAL(5,2),
  is_dismissed BOOLEAN DEFAULT false,
  is_actioned BOOLEAN DEFAULT false,
  actioned_video_id UUID,
  priority_score INTEGER DEFAULT 50, -- 1-100
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_video_recommendations_agent ON video_recommendations(agent_id);
CREATE INDEX IF NOT EXISTS idx_video_recommendations_type ON video_recommendations(recommendation_type);

-- ============================================
-- BULK VIDEO JOBS
-- ============================================

CREATE TABLE IF NOT EXISTS bulk_video_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  job_name TEXT NOT NULL,
  video_type TEXT NOT NULL,
  target_criteria JSONB NOT NULL, -- {personas: [], price_range: {}, locations: []}
  personalization_level TEXT DEFAULT 'medium', -- 'high', 'medium', 'low'
  base_script TEXT,
  status TEXT DEFAULT 'draft', -- 'draft', 'approved', 'processing', 'completed', 'cancelled'
  total_videos_planned INTEGER DEFAULT 0,
  videos_completed INTEGER DEFAULT 0,
  videos_failed INTEGER DEFAULT 0,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bulk_video_jobs_agent ON bulk_video_jobs(agent_id);
CREATE INDEX IF NOT EXISTS idx_bulk_video_jobs_status ON bulk_video_jobs(status);

-- ============================================
-- HEYGEN AVATARS CATALOG
-- ============================================

CREATE TABLE IF NOT EXISTS heygen_avatars (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  heygen_avatar_id TEXT UNIQUE NOT NULL,
  avatar_name TEXT NOT NULL,
  avatar_type TEXT DEFAULT 'professional', -- 'professional', 'casual', 'luxury'
  gender TEXT,
  age_range TEXT, -- '25-35', '35-45', '45-55', '55+'
  ethnicity TEXT,
  preview_image_url TEXT,
  preview_video_url TEXT,
  is_active BOOLEAN DEFAULT true,
  is_premium BOOLEAN DEFAULT false,
  tags TEXT[],
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_heygen_avatars_type ON heygen_avatars(avatar_type);

-- ============================================
-- HEYGEN VOICES CATALOG
-- ============================================

CREATE TABLE IF NOT EXISTS heygen_voices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  heygen_voice_id TEXT UNIQUE NOT NULL,
  voice_name TEXT NOT NULL,
  language TEXT DEFAULT 'en-US',
  accent TEXT,
  gender TEXT,
  age_range TEXT,
  tone TEXT, -- 'professional', 'friendly', 'warm', 'authoritative'
  sample_audio_url TEXT,
  is_active BOOLEAN DEFAULT true,
  is_premium BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_heygen_voices_language ON heygen_voices(language);

-- ============================================
-- ADD MISSING COLUMNS TO AI_VIDEO_PROJECTS
-- ============================================

DO $$
BEGIN
  -- Add project_type column if it doesn't exist
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_video_projects' AND column_name = 'project_type') THEN
    ALTER TABLE ai_video_projects ADD COLUMN project_type TEXT;
  END IF;

  -- Add script_edited_by_agent column
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_video_projects' AND column_name = 'script_edited_by_agent') THEN
    ALTER TABLE ai_video_projects ADD COLUMN script_edited_by_agent TEXT;
  END IF;

  -- Add persona_used column
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_video_projects' AND column_name = 'persona_used') THEN
    ALTER TABLE ai_video_projects ADD COLUMN persona_used JSONB;
  END IF;

  -- Add video_metadata column
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_video_projects' AND column_name = 'video_metadata') THEN
    ALTER TABLE ai_video_projects ADD COLUMN video_metadata JSONB DEFAULT '{}';
  END IF;

  -- Add retry_count column
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_video_projects' AND column_name = 'retry_count') THEN
    ALTER TABLE ai_video_projects ADD COLUMN retry_count INTEGER DEFAULT 0;
  END IF;

  -- Add sent_to_client_at column
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_video_projects' AND column_name = 'sent_to_client_at') THEN
    ALTER TABLE ai_video_projects ADD COLUMN sent_to_client_at TIMESTAMPTZ;
  END IF;

  -- Add delivery_channel column
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_video_projects' AND column_name = 'delivery_channel') THEN
    ALTER TABLE ai_video_projects ADD COLUMN delivery_channel TEXT; -- 'email', 'sms', 'portal', 'all'
  END IF;

  -- Add error_message column
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_video_projects' AND column_name = 'error_message') THEN
    ALTER TABLE ai_video_projects ADD COLUMN error_message TEXT;
  END IF;

  -- Add template_id column
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_video_projects' AND column_name = 'template_id') THEN
    ALTER TABLE ai_video_projects ADD COLUMN template_id UUID;
  END IF;
END $$;

-- ============================================
-- SEED DEFAULT SCRIPT TEMPLATES
-- ============================================

INSERT INTO video_scripts_library (template_name, template_type, base_prompt, variables, ai_enhancement_notes, is_public) VALUES
(
  'Luxury Listing Tour',
  'listing_tour',
  'Generate a 90-second video script for a listing tour of the property at {{property_address}}.

PROPERTY DETAILS:
- Address: {{address}}
- Bedrooms: {{beds}} | Bathrooms: {{baths}}
- Square Feet: {{sqft}}
- Key Features: {{features_array}}
- Price: {{listing_price}}

TARGET BUYER PERSONA: {{persona_type}}
- Pain Points: {{pain_points}}
- Priorities: {{buying_priorities}}

SCRIPT REQUIREMENTS:
1. Opening hook (5 seconds) - grab attention immediately
2. Lifestyle vision (15 seconds) - paint picture of living here
3. Feature walkthrough (50 seconds) - highlight 5-7 key features that matter to THIS persona
4. Neighborhood benefits (15 seconds)
5. Call-to-action (5 seconds)

TONE: {{tone_based_on_persona}}
DO NOT use clichés. Be specific and vivid.
FOCUS on benefits, not just features.
SPEAK directly to the target buyer needs.',
  '[{"name": "property_address", "type": "text", "required": true}, {"name": "beds", "type": "number", "required": true}, {"name": "baths", "type": "number", "required": true}, {"name": "sqft", "type": "number", "required": true}, {"name": "features_array", "type": "array", "required": true}, {"name": "listing_price", "type": "number", "required": true}, {"name": "persona_type", "type": "text", "required": true}]',
  'Works best with high-quality property photos. Emphasize lifestyle over specs.',
  true
),
(
  'Memory Video for Sellers',
  'memory_video',
  'Create a heartfelt, respectful 2-minute video script helping a senior seller say goodbye to their long-time home.

SELLER INFORMATION:
- Name: {{seller_name}}
- Years in home: {{years_lived}}
- Address: {{address}}
- Moving to: {{moving_to}}
- Memories shared: {{memory_responses}}

SCRIPT STRUCTURE:
1. Warm opening (10 seconds) - acknowledge significance
2. Celebrate their time (60 seconds) - weave in their specific memories
3. Transition message (30 seconds) - this is a new chapter
4. Gratitude (15 seconds) - honor the home
5. Forward-looking close (5 seconds)

TONE: Warm, respectful, celebratory (not sad)
Use their actual words where possible.
Make it personal and specific to THEIR story.',
  '[{"name": "seller_name", "type": "text", "required": true}, {"name": "years_lived", "type": "number", "required": true}, {"name": "address", "type": "text", "required": true}, {"name": "moving_to", "type": "text", "required": true}, {"name": "memory_responses", "type": "text", "required": true}]',
  'Collect detailed memories through interview form first. Position agent as caring partner.',
  true
),
(
  'Personalized Buyer Message',
  'personalized_buyer',
  'Write a personalized video message script for {{client_name}} about properties matching their search.

CLIENT PROFILE:
- Name: {{client_name}}
- Persona Type: {{persona_type}}
- Search Criteria: {{preferences_json}}
- Price Range: {{min_price}} - {{max_price}}
- Must-haves: {{must_have_features}}
- Days since last contact: {{days_since_contact}}

MATCHING PROPERTIES (2-3 max):
{{matching_properties}}

SCRIPT STRUCTURE:
1. Personal greeting (5 seconds) - use their name, reference recent activity
2. "I was thinking of you..." (10 seconds) - why these properties came to mind
3. Property highlights (40 seconds per property) - explain WHY this fits THEIR needs
4. Next steps (10 seconds) - "Want to see any of these?"

TONE: Personal (like leaving a voicemail for a friend), helpful (not pushy)
Reference their specific preferences and concerns.',
  '[{"name": "client_name", "type": "text", "required": true}, {"name": "persona_type", "type": "text", "required": true}, {"name": "preferences_json", "type": "json", "required": true}, {"name": "min_price", "type": "number", "required": true}, {"name": "max_price", "type": "number", "required": true}, {"name": "matching_properties", "type": "array", "required": true}]',
  'Use for leads who have viewed 5+ properties but not responded in 7+ days.',
  true
),
(
  'Market Update Video',
  'market_update',
  'Create a data-driven yet accessible 2-minute market update video script for {{area_name}}.

MARKET DATA:
- Area: {{area}}
- Average Sale Price: {{avg_price}} ({{price_change_percentage}} vs last month)
- Days on Market: {{avg_dom}}
- Inventory Levels: {{inventory_count}} homes
- Absorption Rate: {{months_of_inventory}} months

TARGET AUDIENCE: {{persona_type}}

SCRIPT STRUCTURE:
1. Opening (10 seconds) - what is happening in the market RIGHT NOW
2. The numbers (40 seconds) - explain key stats in plain English
3. What it means for THEM (50 seconds) - buyer vs seller implications
4. Predictions (15 seconds) - where is market headed
5. Actionable advice (5 seconds) - what should they do about it

TONE: Informative but not boring, data-driven but conversational
AVOID: Realtor jargon, make it objective
PERSONA FOCUS: Adjust insights for {{persona_type}} priorities.',
  '[{"name": "area_name", "type": "text", "required": true}, {"name": "avg_price", "type": "number", "required": true}, {"name": "price_change_percentage", "type": "number", "required": true}, {"name": "avg_dom", "type": "number", "required": true}, {"name": "inventory_count", "type": "number", "required": true}, {"name": "persona_type", "type": "text", "required": true}]',
  'Pull fresh data from market_stats table. Personalize for different personas.',
  true
)
ON CONFLICT DO NOTHING;
