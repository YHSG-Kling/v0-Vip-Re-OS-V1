-- =====================================================
-- LISTING LIFECYCLE MODULE MIGRATION
-- =====================================================
-- This migration creates all tables for the Listing Lifecycle module
-- including CMA, Pre-Listing, Marketing, Coming Soon, and Showing Management

-- =====================================================
-- ENUMS
-- =====================================================

CREATE TYPE trigger_source_enum AS ENUM ('initial', 'inspection_update', 'price_review', 'manual_refresh');
CREATE TYPE snippet_type_enum AS ENUM ('cma_disclaimer', 'inspection_rules', 'marketing_rules');
CREATE TYPE pre_listing_status_enum AS ENUM ('not_scheduled', 'scheduled', 'completed');
CREATE TYPE warranty_transfer_status_enum AS ENUM ('pending', 'transferred', 'not_applicable');
CREATE TYPE media_order_status_enum AS ENUM ('not_ordered', 'ordered', 'scheduled', 'delivered');
CREATE TYPE open_house_status_enum AS ENUM ('planned', 'completed', 'cancelled');
CREATE TYPE showing_source_enum AS ENUM ('open_house', 'private_showing', 'broker_open');
CREATE TYPE showing_status_enum AS ENUM ('scheduled', 'completed', 'cancelled', 'no_show');
CREATE TYPE price_rating_enum AS ENUM ('too_low', 'fair', 'a_bit_high', 'way_high');
CREATE TYPE condition_rating_enum AS ENUM ('poor', 'fair', 'good', 'excellent');
CREATE TYPE interest_level_enum AS ENUM ('no_interest', 'maybe_if_price_changes', 'would_offer', 'writing_offer');
CREATE TYPE coming_soon_status_enum AS ENUM ('none', 'coming_soon_in_mls', 'marketing_allowed', 'marketing_restricted');
CREATE TYPE address_masking_enum AS ENUM ('full_hidden', 'partial_neighborhood_only', 'full_visible');
CREATE TYPE feedback_signal_enum AS ENUM ('no_data', 'price_ok', 'price_high_flag');
CREATE TYPE condition_signal_enum AS ENUM ('no_data', 'cosmetic_issues', 'major_issues');

-- =====================================================
-- CORE CMA & PRESENTATION TABLES
-- =====================================================

-- Comparative Market Analysis
CREATE TABLE IF NOT EXISTS cma (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  subject_snapshot TEXT,
  comps JSONB DEFAULT '[]'::jsonb,
  adjustments_notes TEXT,
  recommended_price_range TEXT,
  narrative_summary TEXT,
  state_guideline_version UUID,
  is_appraisal_disclaimer BOOLEAN DEFAULT true,
  inputs_snapshot JSONB DEFAULT '{}'::jsonb,
  version INTEGER DEFAULT 1,
  generated_at TIMESTAMP DEFAULT now(),
  generated_by TEXT CHECK (generated_by IN ('agent', 'automation')),
  trigger_source trigger_source_enum DEFAULT 'initial',
  llm_prompt_ref TEXT,
  llm_raw_output TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_cma_listing_id ON cma(listing_id);
CREATE INDEX idx_cma_generated_at ON cma(generated_at DESC);
CREATE INDEX idx_cma_trigger_source ON cma(trigger_source);

-- Listing Presentation
CREATE TABLE IF NOT EXISTS listing_presentation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  sections JSONB DEFAULT '[]'::jsonb,
  slides_outline TEXT,
  micro_video_scripts JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_listing_presentation_listing_id ON listing_presentation(listing_id);

-- State Guideline Snippets (reference data)
CREATE TABLE IF NOT EXISTS state_guideline_snippets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  state TEXT NOT NULL,
  snippet_type snippet_type_enum NOT NULL,
  body TEXT NOT NULL,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_state_guidelines_state ON state_guideline_snippets(state);
CREATE INDEX idx_state_guidelines_type ON state_guideline_snippets(snippet_type);
CREATE INDEX idx_state_guidelines_active ON state_guideline_snippets(is_active);

-- Add foreign key after state_guideline_snippets exists
ALTER TABLE cma 
ADD CONSTRAINT fk_cma_state_guideline 
FOREIGN KEY (state_guideline_version) 
REFERENCES state_guideline_snippets(id) ON DELETE SET NULL;

-- =====================================================
-- PRE-LISTING & PREPARATION TABLES
-- =====================================================

-- Pre-Listing Inspection
CREATE TABLE IF NOT EXISTS pre_listing_inspection (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  vendor TEXT,
  vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
  scheduled_date TIMESTAMP,
  status pre_listing_status_enum DEFAULT 'not_scheduled',
  report_url TEXT,
  key_defects TEXT,
  repairs_planned TEXT,
  repairs_completed TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_pre_listing_inspection_listing_id ON pre_listing_inspection(listing_id);
CREATE INDEX idx_pre_listing_inspection_status ON pre_listing_inspection(status);
CREATE INDEX idx_pre_listing_inspection_scheduled_date ON pre_listing_inspection(scheduled_date);

-- Home Warranty
CREATE TABLE IF NOT EXISTS home_warranty (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  provider TEXT,
  plan_name TEXT,
  coverage_start DATE,
  coverage_end DATE,
  summary TEXT,
  cost NUMERIC(10, 2),
  transfer_status warranty_transfer_status_enum DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_home_warranty_listing_id ON home_warranty(listing_id);
CREATE INDEX idx_home_warranty_coverage_dates ON home_warranty(coverage_start, coverage_end);

-- Media Order
CREATE TABLE IF NOT EXISTS media_order (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  media_type TEXT[] DEFAULT ARRAY[]::TEXT[],
  vendor TEXT,
  vendor_id UUID REFERENCES vendors(id) ON DELETE SET NULL,
  target_shoot_date DATE,
  status media_order_status_enum DEFAULT 'not_ordered',
  delivered_urls JSONB DEFAULT '[]'::jsonb,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_media_order_listing_id ON media_order(listing_id);
CREATE INDEX idx_media_order_status ON media_order(status);
CREATE INDEX idx_media_order_target_date ON media_order(target_shoot_date);

-- =====================================================
-- OPEN HOUSE & SHOWING TABLES
-- =====================================================

-- Open House
CREATE TABLE IF NOT EXISTS open_house (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  status open_house_status_enum DEFAULT 'planned',
  attendee_count INTEGER DEFAULT 0,
  attendee_list_source TEXT,
  marketing_assets_generated JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_open_house_listing_id ON open_house(listing_id);
CREATE INDEX idx_open_house_date ON open_house(date);
CREATE INDEX idx_open_house_status ON open_house(status);

-- Open House Defaults (config table)
CREATE TABLE IF NOT EXISTS open_house_defaults (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  region TEXT NOT NULL,
  default_start_time TIME DEFAULT '14:00:00',
  default_end_time TIME DEFAULT '16:00:00',
  days_before_for_marketing_start INTEGER DEFAULT 7,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE UNIQUE INDEX idx_open_house_defaults_region ON open_house_defaults(region);

-- Showing
CREATE TABLE IF NOT EXISTS showing (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  buyer_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  appointment_datetime TIMESTAMP NOT NULL,
  source showing_source_enum DEFAULT 'private_showing',
  status showing_status_enum DEFAULT 'scheduled',
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_showing_listing_id ON showing(listing_id);
CREATE INDEX idx_showing_buyer_id ON showing(buyer_id);
CREATE INDEX idx_showing_appointment_datetime ON showing(appointment_datetime);
CREATE INDEX idx_showing_status ON showing(status);

-- Showing Feedback
CREATE TABLE IF NOT EXISTS showing_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  showing_id UUID REFERENCES showing(id) ON DELETE CASCADE,
  buyer_agent_name TEXT,
  price_rating price_rating_enum,
  condition_rating condition_rating_enum,
  overall_interest interest_level_enum,
  likes TEXT,
  dislikes TEXT,
  offer_obstacle TEXT,
  created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX idx_showing_feedback_showing_id ON showing_feedback(showing_id);
CREATE INDEX idx_showing_feedback_price_rating ON showing_feedback(price_rating);
CREATE INDEX idx_showing_feedback_interest ON showing_feedback(overall_interest);

-- =====================================================
-- COMING SOON RULES (CONFIG TABLE)
-- =====================================================

CREATE TABLE IF NOT EXISTS coming_soon_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mls_name TEXT NOT NULL,
  region TEXT,
  max_days_coming_soon INTEGER DEFAULT 21,
  public_marketing_allowed BOOLEAN DEFAULT false,
  allowed_channels TEXT[] DEFAULT ARRAY[]::TEXT[],
  address_mask_required BOOLEAN DEFAULT true,
  required_disclaimer TEXT,
  created_at TIMESTAMP DEFAULT now(),
  updated_at TIMESTAMP DEFAULT now()
);

CREATE UNIQUE INDEX idx_coming_soon_rules_mls ON coming_soon_rules(mls_name);
CREATE INDEX idx_coming_soon_rules_region ON coming_soon_rules(region);

-- =====================================================
-- EXTEND LISTINGS TABLE
-- =====================================================

-- Add new columns to listings table for lifecycle tracking
ALTER TABLE listings ADD COLUMN IF NOT EXISTS coming_soon_status coming_soon_status_enum DEFAULT 'none';
ALTER TABLE listings ADD COLUMN IF NOT EXISTS coming_soon_start_date DATE;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS coming_soon_end_date DATE;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS address_masking_mode address_masking_enum DEFAULT 'full_visible';
ALTER TABLE listings ADD COLUMN IF NOT EXISTS feedback_price_signal feedback_signal_enum DEFAULT 'no_data';
ALTER TABLE listings ADD COLUMN IF NOT EXISTS feedback_condition_signal condition_signal_enum DEFAULT 'no_data';
ALTER TABLE listings ADD COLUMN IF NOT EXISTS feedback_summary_last_30_days TEXT;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS mls_live_date DATE;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS first_open_house_date DATE;
ALTER TABLE listings ADD COLUMN IF NOT EXISTS open_house_marketing_start_date DATE;

-- Create indexes for new listing columns
CREATE INDEX IF NOT EXISTS idx_listings_coming_soon_status ON listings(coming_soon_status);
CREATE INDEX IF NOT EXISTS idx_listings_coming_soon_dates ON listings(coming_soon_start_date, coming_soon_end_date);
CREATE INDEX IF NOT EXISTS idx_listings_mls_live_date ON listings(mls_live_date);
CREATE INDEX IF NOT EXISTS idx_listings_first_open_house_date ON listings(first_open_house_date);

-- =====================================================
-- TRIGGERS FOR AUTO TIMESTAMP UPDATES
-- =====================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_cma_updated_at BEFORE UPDATE ON cma FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_listing_presentation_updated_at BEFORE UPDATE ON listing_presentation FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_state_guideline_snippets_updated_at BEFORE UPDATE ON state_guideline_snippets FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_pre_listing_inspection_updated_at BEFORE UPDATE ON pre_listing_inspection FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_home_warranty_updated_at BEFORE UPDATE ON home_warranty FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_media_order_updated_at BEFORE UPDATE ON media_order FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_open_house_updated_at BEFORE UPDATE ON open_house FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_open_house_defaults_updated_at BEFORE UPDATE ON open_house_defaults FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_showing_updated_at BEFORE UPDATE ON showing FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
CREATE TRIGGER update_coming_soon_rules_updated_at BEFORE UPDATE ON coming_soon_rules FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- ROW LEVEL SECURITY (RLS)
-- =====================================================

-- Enable RLS on all tables
ALTER TABLE cma ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_presentation ENABLE ROW LEVEL SECURITY;
ALTER TABLE state_guideline_snippets ENABLE ROW LEVEL SECURITY;
ALTER TABLE pre_listing_inspection ENABLE ROW LEVEL SECURITY;
ALTER TABLE home_warranty ENABLE ROW LEVEL SECURITY;
ALTER TABLE media_order ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_house ENABLE ROW LEVEL SECURITY;
ALTER TABLE open_house_defaults ENABLE ROW LEVEL SECURITY;
ALTER TABLE showing ENABLE ROW LEVEL SECURITY;
ALTER TABLE showing_feedback ENABLE ROW LEVEL SECURITY;
ALTER TABLE coming_soon_rules ENABLE ROW LEVEL SECURITY;

-- CMA Policies
CREATE POLICY "Users can view their listing CMAs" ON cma FOR SELECT USING (
  listing_id IN (SELECT id FROM listings WHERE agent_id = auth.uid())
);

CREATE POLICY "Users can create CMAs for their listings" ON cma FOR INSERT WITH CHECK (
  listing_id IN (SELECT id FROM listings WHERE agent_id = auth.uid())
);

CREATE POLICY "Users can update their listing CMAs" ON cma FOR UPDATE USING (
  listing_id IN (SELECT id FROM listings WHERE agent_id = auth.uid())
);

-- Listing Presentation Policies
CREATE POLICY "Users can view their listing presentations" ON listing_presentation FOR SELECT USING (
  listing_id IN (SELECT id FROM listings WHERE agent_id = auth.uid())
);

CREATE POLICY "Users can create presentations for their listings" ON listing_presentation FOR INSERT WITH CHECK (
  listing_id IN (SELECT id FROM listings WHERE agent_id = auth.uid())
);

CREATE POLICY "Users can update their listing presentations" ON listing_presentation FOR UPDATE USING (
  listing_id IN (SELECT id FROM listings WHERE agent_id = auth.uid())
);

-- State Guideline Snippets (read-only for all authenticated users)
CREATE POLICY "All authenticated users can view state guidelines" ON state_guideline_snippets FOR SELECT USING (auth.role() = 'authenticated');

-- Pre-Listing Inspection Policies
CREATE POLICY "Users can view inspections for their listings" ON pre_listing_inspection FOR SELECT USING (
  listing_id IN (SELECT id FROM listings WHERE agent_id = auth.uid())
);

CREATE POLICY "Users can create inspections for their listings" ON pre_listing_inspection FOR INSERT WITH CHECK (
  listing_id IN (SELECT id FROM listings WHERE agent_id = auth.uid())
);

CREATE POLICY "Users can update inspections for their listings" ON pre_listing_inspection FOR UPDATE USING (
  listing_id IN (SELECT id FROM listings WHERE agent_id = auth.uid())
);

-- Home Warranty Policies
CREATE POLICY "Users can view warranties for their listings" ON home_warranty FOR SELECT USING (
  listing_id IN (SELECT id FROM listings WHERE agent_id = auth.uid())
);

CREATE POLICY "Users can create warranties for their listings" ON home_warranty FOR INSERT WITH CHECK (
  listing_id IN (SELECT id FROM listings WHERE agent_id = auth.uid())
);

CREATE POLICY "Users can update warranties for their listings" ON home_warranty FOR UPDATE USING (
  listing_id IN (SELECT id FROM listings WHERE agent_id = auth.uid())
);

-- Media Order Policies
CREATE POLICY "Users can view media orders for their listings" ON media_order FOR SELECT USING (
  listing_id IN (SELECT id FROM listings WHERE agent_id = auth.uid())
);

CREATE POLICY "Users can create media orders for their listings" ON media_order FOR INSERT WITH CHECK (
  listing_id IN (SELECT id FROM listings WHERE agent_id = auth.uid())
);

CREATE POLICY "Users can update media orders for their listings" ON media_order FOR UPDATE USING (
  listing_id IN (SELECT id FROM listings WHERE agent_id = auth.uid())
);

-- Open House Policies
CREATE POLICY "Users can view open houses for their listings" ON open_house FOR SELECT USING (
  listing_id IN (SELECT id FROM listings WHERE agent_id = auth.uid())
);

CREATE POLICY "Users can create open houses for their listings" ON open_house FOR INSERT WITH CHECK (
  listing_id IN (SELECT id FROM listings WHERE agent_id = auth.uid())
);

CREATE POLICY "Users can update open houses for their listings" ON open_house FOR UPDATE USING (
  listing_id IN (SELECT id FROM listings WHERE agent_id = auth.uid())
);

-- Open House Defaults (read-only for all authenticated users)
CREATE POLICY "All authenticated users can view open house defaults" ON open_house_defaults FOR SELECT USING (auth.role() = 'authenticated');

-- Showing Policies
CREATE POLICY "Users can view showings for their listings" ON showing FOR SELECT USING (
  listing_id IN (SELECT id FROM listings WHERE agent_id = auth.uid())
);

CREATE POLICY "Users can create showings for their listings" ON showing FOR INSERT WITH CHECK (
  listing_id IN (SELECT id FROM listings WHERE agent_id = auth.uid())
);

CREATE POLICY "Users can update showings for their listings" ON showing FOR UPDATE USING (
  listing_id IN (SELECT id FROM listings WHERE agent_id = auth.uid())
);

-- Showing Feedback Policies
CREATE POLICY "Users can view feedback for their listings showings" ON showing_feedback FOR SELECT USING (
  showing_id IN (
    SELECT s.id FROM showing s 
    JOIN listings l ON s.listing_id = l.id 
    WHERE l.agent_id = auth.uid()
  )
);

CREATE POLICY "Users can create feedback for their listings showings" ON showing_feedback FOR INSERT WITH CHECK (
  showing_id IN (
    SELECT s.id FROM showing s 
    JOIN listings l ON s.listing_id = l.id 
    WHERE l.agent_id = auth.uid()
  )
);

-- Coming Soon Rules (read-only for all authenticated users)
CREATE POLICY "All authenticated users can view coming soon rules" ON coming_soon_rules FOR SELECT USING (auth.role() = 'authenticated');

-- =====================================================
-- SEED DEFAULT DATA
-- =====================================================

-- Seed Open House Defaults
INSERT INTO open_house_defaults (region, default_start_time, default_end_time, days_before_for_marketing_start)
VALUES 
  ('West Coast', '14:00:00', '16:00:00', 7),
  ('East Coast', '13:00:00', '15:00:00', 7),
  ('Midwest', '14:00:00', '16:00:00', 7),
  ('South', '13:00:00', '15:00:00', 7)
ON CONFLICT DO NOTHING;

-- Seed Coming Soon Rules (sample MLS)
INSERT INTO coming_soon_rules (mls_name, region, max_days_coming_soon, public_marketing_allowed, allowed_channels, address_mask_required, required_disclaimer)
VALUES 
  ('CRMLS', 'California', 21, true, ARRAY['social_media', 'email', 'website'], false, 'This property is listed as Coming Soon on the MLS.'),
  ('NTREIS', 'Texas', 14, false, ARRAY[]::TEXT[], true, 'This property is Coming Soon. Public marketing is restricted by MLS rules.'),
  ('FMLS', 'Florida', 30, true, ARRAY['social_media', 'email', 'website', 'yard_sign'], false, 'Coming Soon! Contact agent for details.')
ON CONFLICT DO NOTHING;

-- Seed State Guideline Snippets
INSERT INTO state_guideline_snippets (state, snippet_type, body, is_active)
VALUES 
  ('CA', 'cma_disclaimer', 'This Comparative Market Analysis is not an appraisal. It is provided to assist in your decision-making process and should not be relied upon as a definitive valuation of the property.', true),
  ('TX', 'cma_disclaimer', 'This analysis is a broker price opinion only and not an appraisal. Consult a licensed appraiser for official property valuations.', true),
  ('FL', 'cma_disclaimer', 'This CMA is an estimate of market value based on recent comparable sales and is not a substitute for a professional appraisal.', true),
  ('CA', 'inspection_rules', 'California requires disclosure of all known material defects. Pre-listing inspections are highly recommended.', true),
  ('TX', 'marketing_rules', 'Texas TREC rules require accurate representation of property conditions in all marketing materials.', true)
ON CONFLICT DO NOTHING;
