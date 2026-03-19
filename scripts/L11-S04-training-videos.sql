-- ═══════════════════════════════════════════════════════════════════════════
-- L11-S04: Training Video Library Tables
-- VIP Real Estate AI OS — Layer 11: Agent Onboarding & Education
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── training_videos ─────────────────────────────────────────────────────────
-- Stores platform-wide and brokerage-specific training videos
-- brokerage_id NULL = platform default (visible to ALL brokerages)
-- brokerage_id NOT NULL = brokerage-specific content

CREATE TABLE IF NOT EXISTS training_videos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL CHECK (category IN (
    'platform_tour',
    'lead_management',
    'listing_workflow',
    'transaction',
    'portal',
    'marketing',
    'isa_engine',
    'compliance',
    'them_first',
    'mobile_app',
    'custom'
  )),
  video_url TEXT NOT NULL,
  thumbnail_url TEXT,
  duration_seconds INTEGER DEFAULT 0,
  order_index INTEGER DEFAULT 0,
  is_required BOOLEAN DEFAULT false,
  is_platform_default BOOLEAN DEFAULT false,
  heygen_project_id UUID REFERENCES ai_video_projects(id) ON DELETE SET NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Index for efficient querying
CREATE INDEX IF NOT EXISTS idx_training_videos_brokerage ON training_videos(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_training_videos_category ON training_videos(category);
CREATE INDEX IF NOT EXISTS idx_training_videos_order ON training_videos(order_index);
CREATE INDEX IF NOT EXISTS idx_training_videos_required ON training_videos(is_required) WHERE is_required = true;

-- RLS policies
ALTER TABLE training_videos ENABLE ROW LEVEL SECURITY;

-- Users can view platform defaults (brokerage_id IS NULL) or their own brokerage's videos
CREATE POLICY training_videos_select ON training_videos
  FOR SELECT
  USING (
    brokerage_id IS NULL 
    OR brokerage_id IN (
      SELECT brokerage_id FROM agents WHERE user_id = auth.uid()
    )
  );

-- Only admins/brokers can insert/update/delete training videos
CREATE POLICY training_videos_insert ON training_videos
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM users 
      WHERE id = auth.uid() 
      AND user_type IN ('admin', 'broker', 'superadmin')
    )
  );

CREATE POLICY training_videos_update ON training_videos
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM users 
      WHERE id = auth.uid() 
      AND user_type IN ('admin', 'broker', 'superadmin')
    )
  );

CREATE POLICY training_videos_delete ON training_videos
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM users 
      WHERE id = auth.uid() 
      AND user_type IN ('admin', 'broker', 'superadmin')
    )
  );

-- ─── video_completion_tracking ───────────────────────────────────────────────
-- Tracks agent progress through training videos

CREATE TABLE IF NOT EXISTS video_completion_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  training_video_id UUID NOT NULL REFERENCES training_videos(id) ON DELETE CASCADE,
  percent_watched NUMERIC DEFAULT 0 CHECK (percent_watched >= 0 AND percent_watched <= 100),
  last_position_seconds INTEGER DEFAULT 0,
  completed BOOLEAN DEFAULT false,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (agent_id, training_video_id)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_vct_agent ON video_completion_tracking(agent_id);
CREATE INDEX IF NOT EXISTS idx_vct_video ON video_completion_tracking(training_video_id);
CREATE INDEX IF NOT EXISTS idx_vct_completed ON video_completion_tracking(completed) WHERE completed = true;

-- RLS policies
ALTER TABLE video_completion_tracking ENABLE ROW LEVEL SECURITY;

-- Agents can view/update their own completion records
CREATE POLICY vct_select ON video_completion_tracking
  FOR SELECT
  USING (
    agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid())
    OR EXISTS (
      SELECT 1 FROM users 
      WHERE id = auth.uid() 
      AND user_type IN ('admin', 'broker', 'superadmin')
    )
  );

CREATE POLICY vct_insert ON video_completion_tracking
  FOR INSERT
  WITH CHECK (
    agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid())
  );

CREATE POLICY vct_update ON video_completion_tracking
  FOR UPDATE
  USING (
    agent_id IN (SELECT id FROM agents WHERE user_id = auth.uid())
  );

-- ─── Feature Flag for Training Library ───────────────────────────────────────

INSERT INTO feature_flags (
  feature_key,
  display_name,
  description,
  category,
  enabled,
  superadmin_only,
  solo_agent_access,
  team_access,
  brokerage_access,
  multi_location_access,
  beta,
  deprecated
) VALUES (
  'training_library',
  'Training Video Library',
  'Access to platform training videos and progress tracking',
  'onboarding',
  true,
  false,
  true,
  true,
  true,
  true,
  false,
  false
) ON CONFLICT (feature_key) DO UPDATE SET
  enabled = EXCLUDED.enabled,
  solo_agent_access = EXCLUDED.solo_agent_access,
  team_access = EXCLUDED.team_access,
  brokerage_access = EXCLUDED.brokerage_access,
  multi_location_access = EXCLUDED.multi_location_access;

-- ─── Seed Platform Default Training Videos ───────────────────────────────────

INSERT INTO training_videos (
  brokerage_id, title, description, category, video_url, 
  thumbnail_url, duration_seconds, order_index, is_required, is_platform_default
) VALUES
  -- Platform Tour
  (NULL, 'Welcome to VIP Real Estate AI OS', 'Get started with an overview of the platform''s key features and navigation.', 'platform_tour', 'https://cdn.heygen.com/placeholder/welcome-tour.mp4', NULL, 480, 1, true, true),
  (NULL, 'Dashboard Overview', 'Learn how to use your personalized dashboard for daily productivity.', 'platform_tour', 'https://cdn.heygen.com/placeholder/dashboard-overview.mp4', NULL, 360, 2, true, true),
  
  -- Lead Management
  (NULL, 'Lead Capture & Scoring', 'Understanding how leads are captured, scored, and prioritized.', 'lead_management', 'https://cdn.heygen.com/placeholder/lead-capture.mp4', NULL, 540, 1, true, true),
  (NULL, 'Working Your Lead Pipeline', 'Best practices for converting leads to clients.', 'lead_management', 'https://cdn.heygen.com/placeholder/lead-pipeline.mp4', NULL, 600, 2, true, true),
  
  -- Listing Workflow
  (NULL, 'Listing Stage Machine', 'Master the listing workflow from intake to close.', 'listing_workflow', 'https://cdn.heygen.com/placeholder/listing-stages.mp4', NULL, 720, 1, true, true),
  (NULL, 'Preparing Marketing Materials', 'Creating compelling listing presentations and marketing packages.', 'listing_workflow', 'https://cdn.heygen.com/placeholder/marketing-materials.mp4', NULL, 480, 2, false, true),
  
  -- Transaction
  (NULL, 'Transaction Coordination', 'Navigate transactions from offer to close seamlessly.', 'transaction', 'https://cdn.heygen.com/placeholder/transaction-coord.mp4', NULL, 660, 1, true, true),
  (NULL, 'Compliance Essentials', 'Understanding compliance requirements and avoiding common pitfalls.', 'compliance', 'https://cdn.heygen.com/placeholder/compliance.mp4', NULL, 540, 1, true, true),
  
  -- ISA Engine
  (NULL, 'AI ISA: Your Digital Assistant', 'Leverage the AI ISA for automated lead nurturing and qualification.', 'isa_engine', 'https://cdn.heygen.com/placeholder/ai-isa.mp4', NULL, 480, 1, false, true),
  
  -- Marketing
  (NULL, 'Video Marketing Suite', 'Create professional AI-powered videos for your listings and brand.', 'marketing', 'https://cdn.heygen.com/placeholder/video-marketing.mp4', NULL, 600, 1, false, true),
  (NULL, 'Social Media Automation', 'Set up automated social posting for consistent brand presence.', 'marketing', 'https://cdn.heygen.com/placeholder/social-automation.mp4', NULL, 420, 2, false, true),
  
  -- Them First Methodology
  (NULL, 'The Them First Approach', 'Our core philosophy: putting client needs before transactions.', 'them_first', 'https://cdn.heygen.com/placeholder/them-first.mp4', NULL, 540, 1, true, true)
ON CONFLICT DO NOTHING;

-- Verify the tables were created
SELECT 'training_videos' as table_name, count(*) as row_count FROM training_videos
UNION ALL
SELECT 'video_completion_tracking', count(*) FROM video_completion_tracking;
