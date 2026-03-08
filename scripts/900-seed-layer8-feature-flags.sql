-- ═══════════════════════════════════════════════════════════════════════════
-- LAYER 8 FEATURE FLAGS SEED
-- Seeds the feature_flags table with all Layer 8 feature keys
-- These keys are looked up exactly as written by canAccessFeature()
-- ═══════════════════════════════════════════════════════════════════════════

-- Insert feature flags only if they don't already exist
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
) VALUES
  -- Video Generation
  (
    'video_generation',
    'AI Video Generation',
    'Generate AI-powered videos using HeyGen',
    'video',
    true,
    false,
    true,
    true,
    true,
    true,
    false,
    false
  ),
  -- Voice Clone
  (
    'voice_clone',
    'Voice Clone Training',
    'Clone agent voice for personalized video generation',
    'video',
    true,
    false,
    true,
    true,
    true,
    true,
    false,
    false
  ),
  -- Snippet Generation
  (
    'snippet_generation',
    'Video Snippet Generation',
    'Create platform-optimized video snippets from long-form content',
    'video',
    true,
    false,
    true,
    true,
    true,
    true,
    false,
    false
  ),
  -- Repurposing
  (
    'repurposing',
    'Content Repurposing',
    'Repurpose content across multiple social platforms',
    'marketing',
    true,
    false,
    true,
    true,
    true,
    true,
    false,
    false
  ),
  -- Podcast Generation
  (
    'podcast_generation',
    'AI Podcast Generation',
    'Generate podcast episodes from keywords or scripts',
    'marketing',
    true,
    false,
    true,
    true,
    true,
    true,
    false,
    false
  ),
  -- AI Content Generation
  (
    'ai_content_generation',
    'AI Content Generation',
    'Generate AI-powered marketing content with brand voice',
    'ai',
    true,
    false,
    true,
    true,
    true,
    true,
    false,
    false
  )
ON CONFLICT (feature_key) DO UPDATE SET
  enabled = EXCLUDED.enabled,
  solo_agent_access = EXCLUDED.solo_agent_access,
  team_access = EXCLUDED.team_access,
  brokerage_access = EXCLUDED.brokerage_access,
  multi_location_access = EXCLUDED.multi_location_access;

-- Verify the feature flags were inserted
SELECT feature_key, enabled, solo_agent_access FROM feature_flags 
WHERE feature_key IN (
  'video_generation',
  'voice_clone', 
  'snippet_generation',
  'repurposing',
  'podcast_generation',
  'ai_content_generation'
);
