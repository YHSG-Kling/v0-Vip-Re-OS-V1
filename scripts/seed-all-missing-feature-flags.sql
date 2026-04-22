-- Missing Feature Flags Seed
-- Inserts all feature keys referenced in canAccessFeature() calls but not yet in the DB.
-- All features enabled for all tiers (testing phase).
-- Safe to re-run: uses ON CONFLICT (feature_key) DO UPDATE SET.

INSERT INTO feature_flags (
  feature_key,
  display_name,
  description,
  enabled,
  solo_agent_access,
  team_access,
  brokerage_access,
  multi_location_access,
  solo_agent_limit,
  team_limit,
  brokerage_limit,
  multi_location_limit,
  superadmin_only,
  beta,
  deprecated,
  category,
  created_at,
  updated_at
) VALUES
  (
    'marketing_studio',
    'Marketing Studio',
    'Create and manage marketing campaigns, assets, and content calendar',
    true, true, true, true, true,
    NULL, NULL, NULL, NULL,
    false, false, false,
    'marketing', now(), now()
  ),
  (
    'seo_blog_engine',
    'SEO Blog Engine',
    'Generate and publish SEO-optimized blog content to drive organic search traffic',
    true, true, true, true, true,
    NULL, NULL, NULL, NULL,
    false, false, false,
    'marketing', now(), now()
  ),
  (
    'email_campaigns',
    'Email Campaigns',
    'Design and send targeted email campaigns to leads, clients, and prospects',
    true, true, true, true, true,
    NULL, NULL, NULL, NULL,
    false, false, false,
    'marketing', now(), now()
  ),
  (
    'newsletter_engine',
    'Newsletter Engine',
    'Build and distribute branded newsletters to your contact list on a recurring schedule',
    true, true, true, true, true,
    NULL, NULL, NULL, NULL,
    false, false, false,
    'marketing', now(), now()
  ),
  (
    'ad_creator',
    'Ad Creator',
    'Design and export digital ads for social media, display networks, and print',
    true, true, true, true, true,
    NULL, NULL, NULL, NULL,
    false, false, false,
    'marketing', now(), now()
  ),
  (
    'ads_audiences',
    'Ads Audiences',
    'Build and manage targeted ad audiences based on CRM data and behavioral signals',
    true, true, true, true, true,
    NULL, NULL, NULL, NULL,
    false, false, false,
    'marketing', now(), now()
  ),
  (
    'ads_campaigns',
    'Ads Campaigns',
    'Launch and monitor paid advertising campaigns across multiple channels',
    true, true, true, true, true,
    NULL, NULL, NULL, NULL,
    false, false, false,
    'marketing', now(), now()
  ),
  (
    'ai_listing_generation',
    'AI Listing Generation',
    'Automatically generate compelling property listing descriptions and marketing copy using AI',
    true, true, true, true, true,
    NULL, NULL, NULL, NULL,
    false, false, false,
    'listings', now(), now()
  ),
  (
    'ai_social_content',
    'AI Social Content',
    'Generate platform-optimized social media posts, captions, and creative assets using AI',
    true, true, true, true, true,
    NULL, NULL, NULL, NULL,
    false, false, false,
    'marketing', now(), now()
  ),
  (
    'campaign_roi_dashboard',
    'Campaign ROI Dashboard',
    'Track return on investment across all marketing campaigns with unified attribution reporting',
    true, true, true, true, true,
    NULL, NULL, NULL, NULL,
    false, false, false,
    'analytics', now(), now()
  ),
  (
    'competitor_monitor',
    'Competitor Monitor',
    'Monitor competitor listings, pricing, and market activity to inform your strategy',
    true, true, true, true, true,
    NULL, NULL, NULL, NULL,
    false, false, false,
    'analytics', now(), now()
  ),
  (
    'content_performance_predictor',
    'Content Performance Predictor',
    'Use AI to forecast engagement and reach for content before publishing',
    true, true, true, true, true,
    NULL, NULL, NULL, NULL,
    false, false, false,
    'analytics', now(), now()
  ),
  (
    'listing_marketing_tiers',
    'Listing Marketing Tiers',
    'Define and apply tiered marketing packages to listings based on price point or client level',
    true, true, true, true, true,
    NULL, NULL, NULL, NULL,
    false, false, false,
    'listings', now(), now()
  ),
  (
    'omnipresence_repurposer',
    'Omnipresence Repurposer',
    'Automatically repurpose a single piece of content into multiple formats for every channel',
    true, true, true, true, true,
    NULL, NULL, NULL, NULL,
    false, false, false,
    'marketing', now(), now()
  ),
  (
    'social_automation',
    'Social Automation',
    'Schedule, publish, and automate social media posting across all connected platforms',
    true, true, true, true, true,
    NULL, NULL, NULL, NULL,
    false, false, false,
    'marketing', now(), now()
  ),
  (
    'training_library',
    'Training Library',
    'Access a curated library of real estate training videos, courses, and certification resources',
    true, true, true, true, true,
    NULL, NULL, NULL, NULL,
    false, false, false,
    'training', now(), now()
  )
ON CONFLICT (feature_key)
DO UPDATE SET
  display_name             = EXCLUDED.display_name,
  description              = EXCLUDED.description,
  category                 = EXCLUDED.category,
  updated_at               = now();
-- NOTE: enabled, access flags, and limits are intentionally NOT updated on conflict
-- so re-running this seed cannot reset live feature gating or usage limits.

-- Completed: all 16 missing feature flags seeded with full tier access enabled.
