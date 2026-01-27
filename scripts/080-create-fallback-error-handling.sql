-- =====================================================
-- Fallback & Error Handling Infrastructure
-- =====================================================
-- Purpose: Provides graceful degradation when AI services fail
-- Tables: fallback_templates, brand_voice_config, micro_video_beats_config

-- =====================================================
-- 1. Create Enums
-- =====================================================

-- Template types for fallback content
CREATE TYPE template_type_enum AS ENUM (
  'cma',
  'open_house_copy',
  'seller_update_email',
  'buyer_nurture_sms',
  'listing_remarks'
);

-- Brand voice configuration
CREATE TYPE voice_style_enum AS ENUM (
  'formal',
  'neutral',
  'casual',
  'playful'
);

CREATE TYPE emoji_policy_enum AS ENUM (
  'none',
  'light',
  'full'
);

CREATE TYPE length_preference_enum AS ENUM (
  'short',
  'medium',
  'detailed'
);

CREATE TYPE owner_type_enum AS ENUM (
  'brokerage',
  'team',
  'agent'
);

-- Video beat context types
CREATE TYPE video_beat_context_enum AS ENUM (
  'pre_listing',
  'pre_buyer_consult',
  'offer_review'
);

-- =====================================================
-- 2. Create fallback_templates Table
-- =====================================================

CREATE TABLE fallback_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_type template_type_enum NOT NULL,
  content TEXT NOT NULL,
  placeholders TEXT[] DEFAULT '{}', -- Array of field names to be replaced: ['agent_name', 'property_address', etc.]
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for fallback_templates
CREATE INDEX idx_fallback_templates_type ON fallback_templates(template_type);
CREATE INDEX idx_fallback_templates_active ON fallback_templates(is_active);
CREATE INDEX idx_fallback_templates_type_active ON fallback_templates(template_type, is_active);

-- RLS Policies for fallback_templates
ALTER TABLE fallback_templates ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read active templates
CREATE POLICY "All users can read active templates"
  ON fallback_templates
  FOR SELECT
  TO authenticated
  USING (is_active = true);

-- Only admins can insert/update/delete templates
CREATE POLICY "Only admins can manage templates"
  ON fallback_templates
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role IN ('admin', 'broker')
    )
  );

-- =====================================================
-- 3. Create brand_voice_config Table
-- =====================================================

CREATE TABLE brand_voice_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  owner_type owner_type_enum NOT NULL,
  voice_style voice_style_enum DEFAULT 'neutral',
  emoji_policy emoji_policy_enum DEFAULT 'light',
  length_preference length_preference_enum DEFAULT 'medium',
  tone_keywords TEXT[] DEFAULT '{}', -- e.g., ['professional', 'friendly', 'luxury']
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(owner_id, owner_type)
);

-- Indexes for brand_voice_config
CREATE INDEX idx_brand_voice_owner ON brand_voice_config(owner_id);
CREATE INDEX idx_brand_voice_owner_type ON brand_voice_config(owner_id, owner_type);
CREATE INDEX idx_brand_voice_style ON brand_voice_config(voice_style);

-- RLS Policies for brand_voice_config
ALTER TABLE brand_voice_config ENABLE ROW LEVEL SECURITY;

-- Users can read their own config
CREATE POLICY "Users can read their own brand voice config"
  ON brand_voice_config
  FOR SELECT
  TO authenticated
  USING (owner_id = auth.uid());

-- Admins/brokers can read all configs in their org
CREATE POLICY "Admins can read all brand voice configs"
  ON brand_voice_config
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u1
      WHERE u1.id = auth.uid()
      AND u1.role IN ('admin', 'broker')
      AND u1.brokerage_id = (
        SELECT u2.brokerage_id FROM users u2 WHERE u2.id = brand_voice_config.owner_id
      )
    )
  );

-- Users can insert/update their own config
CREATE POLICY "Users can manage their own brand voice config"
  ON brand_voice_config
  FOR ALL
  TO authenticated
  USING (owner_id = auth.uid());

-- Admins can manage all configs in their org
CREATE POLICY "Admins can manage all brand voice configs"
  ON brand_voice_config
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users u1
      WHERE u1.id = auth.uid()
      AND u1.role IN ('admin', 'broker')
      AND u1.brokerage_id = (
        SELECT u2.brokerage_id FROM users u2 WHERE u2.id = brand_voice_config.owner_id
      )
    )
  );

-- =====================================================
-- 4. Create micro_video_beats_config Table
-- =====================================================

CREATE TABLE micro_video_beats_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  context video_beat_context_enum NOT NULL,
  label TEXT NOT NULL, -- e.g., "Pricing philosophy", "Marketing plan"
  required BOOLEAN DEFAULT false,
  priority_order INTEGER NOT NULL, -- Determines the order of beats
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(context, label)
);

-- Indexes for micro_video_beats_config
CREATE INDEX idx_video_beats_context ON micro_video_beats_config(context);
CREATE INDEX idx_video_beats_context_priority ON micro_video_beats_config(context, priority_order);
CREATE INDEX idx_video_beats_required ON micro_video_beats_config(required);

-- RLS Policies for micro_video_beats_config
ALTER TABLE micro_video_beats_config ENABLE ROW LEVEL SECURITY;

-- All authenticated users can read video beat configs
CREATE POLICY "All users can read video beat configs"
  ON micro_video_beats_config
  FOR SELECT
  TO authenticated
  USING (true);

-- Only admins can manage video beat configs
CREATE POLICY "Only admins can manage video beat configs"
  ON micro_video_beats_config
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM users
      WHERE users.id = auth.uid()
      AND users.role IN ('admin', 'broker')
    )
  );

-- =====================================================
-- 5. Create updated_at Triggers
-- =====================================================

-- Trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply triggers
CREATE TRIGGER update_fallback_templates_updated_at
  BEFORE UPDATE ON fallback_templates
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_brand_voice_config_updated_at
  BEFORE UPDATE ON brand_voice_config
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_micro_video_beats_config_updated_at
  BEFORE UPDATE ON micro_video_beats_config
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- 6. Seed Data
-- =====================================================

-- Seed fallback templates
INSERT INTO fallback_templates (template_type, content, placeholders, is_active) VALUES
(
  'cma',
  E'# Comparative Market Analysis\n\n**Property Address:** {{property_address}}\n**Prepared For:** {{client_name}}\n**Date:** {{date}}\n**Agent:** {{agent_name}}\n\n## Market Summary\nBased on current market conditions in {{neighborhood}}, similar properties are selling between {{price_low}} and {{price_high}}.\n\n## Recommended List Price: {{recommended_price}}\n\n### Supporting Data:\n- Average Days on Market: {{avg_dom}} days\n- Recent Sale Price Range: {{price_range}}\n- Market Trend: {{trend}}\n\n*This analysis is provided as guidance. Final pricing should consider property condition, location, and current market dynamics.*',
  ARRAY['property_address', 'client_name', 'date', 'agent_name', 'neighborhood', 'price_low', 'price_high', 'recommended_price', 'avg_dom', 'price_range', 'trend'],
  true
),
(
  'open_house_copy',
  E'🏡 OPEN HOUSE THIS {{day_of_week}}!\n\n{{property_address}}\n{{time_range}}\n\n✨ Features:\n• {{bedrooms}} bed, {{bathrooms}} bath\n• {{square_feet}} sq ft\n• {{key_feature_1}}\n• {{key_feature_2}}\n• {{key_feature_3}}\n\nDon''t miss this opportunity! See you there!\n\n{{agent_name}}\n{{phone}}\n{{brokerage}}',
  ARRAY['day_of_week', 'property_address', 'time_range', 'bedrooms', 'bathrooms', 'square_feet', 'key_feature_1', 'key_feature_2', 'key_feature_3', 'agent_name', 'phone', 'brokerage'],
  true
),
(
  'seller_update_email',
  E'Subject: Property Update for {{property_address}}\n\nHi {{client_name}},\n\nI wanted to give you a quick update on your listing at {{property_address}}.\n\n**This Week''s Activity:**\n• Showings: {{showings_count}}\n• Online Views: {{online_views}}\n• Inquiries: {{inquiries_count}}\n\n**Market Update:**\n{{market_update}}\n\n**Next Steps:**\n{{next_steps}}\n\nPlease let me know if you have any questions. I''m here to help!\n\nBest regards,\n{{agent_name}}\n{{phone}}',
  ARRAY['property_address', 'client_name', 'showings_count', 'online_views', 'inquiries_count', 'market_update', 'next_steps', 'agent_name', 'phone'],
  true
),
(
  'buyer_nurture_sms',
  E'Hi {{first_name}}! Just wanted to check in - are you still looking for a home in {{area}}? I have some new listings that might interest you. Let me know if you''d like to schedule a showing! - {{agent_name}}',
  ARRAY['first_name', 'area', 'agent_name'],
  true
),
(
  'listing_remarks',
  E'Welcome to {{property_address}}! This {{bedrooms}}-bedroom, {{bathrooms}}-bathroom home offers {{square_feet}} square feet of comfortable living space. Located in the desirable {{neighborhood}} area, this property features {{key_features}}. {{additional_details}} Perfect for {{target_buyer}}. Schedule your showing today!',
  ARRAY['property_address', 'bedrooms', 'bathrooms', 'square_feet', 'neighborhood', 'key_features', 'additional_details', 'target_buyer'],
  true
);

-- Seed video beat configurations
INSERT INTO micro_video_beats_config (context, label, required, priority_order) VALUES
-- Pre-listing beats
('pre_listing', 'Introduction & Property Overview', true, 1),
('pre_listing', 'Pricing Philosophy', true, 2),
('pre_listing', 'Marketing Plan', true, 3),
('pre_listing', 'Professional Photography & Staging', false, 4),
('pre_listing', 'Open House Strategy', false, 5),
('pre_listing', 'Timeline & Process', true, 6),
('pre_listing', 'Communication Expectations', false, 7),
('pre_listing', 'Commission & Contract Terms', true, 8),
('pre_listing', 'Questions & Next Steps', true, 9),

-- Pre-buyer consult beats
('pre_buyer_consult', 'Introduction & Goals', true, 1),
('pre_buyer_consult', 'Budget & Financing', true, 2),
('pre_buyer_consult', 'Lender Referral', false, 3),
('pre_buyer_consult', 'Area & Property Preferences', true, 4),
('pre_buyer_consult', 'Timeline & Urgency', true, 5),
('pre_buyer_consult', 'Showing Process', true, 6),
('pre_buyer_consult', 'Offer Strategy', false, 7),
('pre_buyer_consult', 'Representation & Agreement', true, 8),

-- Offer review beats
('offer_review', 'Offer Overview', true, 1),
('offer_review', 'Price Analysis', true, 2),
('offer_review', 'Terms & Contingencies', true, 3),
('offer_review', 'Earnest Money & Down Payment', true, 4),
('offer_review', 'Closing Timeline', true, 5),
('offer_review', 'Inspection & Appraisal Considerations', false, 6),
('offer_review', 'Strengths & Weaknesses', true, 7),
('offer_review', 'Recommendation & Next Steps', true, 8);

-- =====================================================
-- Migration Complete
-- =====================================================

COMMENT ON TABLE fallback_templates IS 'Fallback content templates used when AI services are unavailable';
COMMENT ON TABLE brand_voice_config IS 'Brand voice configuration for brokerages, teams, and individual agents';
COMMENT ON TABLE micro_video_beats_config IS 'Configuration for AI-generated micro-video beats in different contexts';
