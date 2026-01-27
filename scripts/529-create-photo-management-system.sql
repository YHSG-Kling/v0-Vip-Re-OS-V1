-- =====================================================
-- PHOTO MANAGEMENT SYSTEM
-- AI-powered photo analysis, optimization, and ordering
-- =====================================================

-- Drop existing tables if they exist
DROP TABLE IF EXISTS photo_enhancement_jobs CASCADE;
DROP TABLE IF EXISTS photo_ordering_rules CASCADE;
DROP TABLE IF EXISTS listing_photos CASCADE;

-- Listing Photos
CREATE TABLE listing_photos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- References
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  property_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES users(id) ON DELETE SET NULL,
  vendor_id UUID,
  
  -- File Information
  file_url TEXT NOT NULL,
  thumbnail_url TEXT,
  original_filename TEXT,
  file_size_bytes INTEGER,
  width INTEGER,
  height INTEGER,
  format TEXT, -- jpg, png, heic, webp
  
  -- Photo Classification
  photo_type TEXT, -- exterior, interior, kitchen, bedroom, bathroom, yard, detail, amenity
  room_name TEXT,
  is_hero BOOLEAN DEFAULT false,
  display_order INTEGER,
  
  -- AI Analysis
  ai_quality_score NUMERIC(5,2), -- 0-100
  ai_analysis JSONB, -- lighting, composition, staging quality, marketing appeal
  compliance_issues JSONB, -- any problems detected (people, personal items, etc.)
  
  -- Enhancement
  enhancement_applied BOOLEAN DEFAULT false,
  enhanced_url TEXT,
  enhancement_metadata JSONB,
  
  -- Engagement Tracking
  view_count INTEGER DEFAULT 0,
  engagement_score NUMERIC(10,2),
  click_through_rate NUMERIC(5,2),
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  analyzed_at TIMESTAMPTZ,
  
  -- Constraints
  CONSTRAINT valid_quality_score CHECK (ai_quality_score >= 0 AND ai_quality_score <= 100),
  CONSTRAINT valid_display_order CHECK (display_order > 0)
);

-- Photo Enhancement Jobs
CREATE TABLE photo_enhancement_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  photo_id UUID REFERENCES listing_photos(id) ON DELETE CASCADE,
  
  -- Enhancement Details
  enhancement_type TEXT NOT NULL, -- auto_enhance, straighten, crop, brightness, contrast, color_correction
  parameters JSONB,
  
  -- Processing Status
  status TEXT DEFAULT 'queued', -- queued, processing, completed, failed
  result_url TEXT,
  error_message TEXT,
  
  -- Performance Metrics
  processing_time_ms INTEGER,
  quality_improvement NUMERIC(5,2), -- before/after quality score difference
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  
  -- Constraints
  CONSTRAINT valid_status CHECK (status IN ('queued', 'processing', 'completed', 'failed'))
);

-- Photo Ordering Rules
CREATE TABLE photo_ordering_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  agent_id UUID REFERENCES users(id) ON DELETE CASCADE,
  
  -- Property Context
  property_type TEXT, -- single_family, condo, townhouse, land, commercial
  price_range TEXT, -- luxury, mid, entry
  
  -- Ordering Strategy
  optimal_sequence JSONB NOT NULL, -- array of photo types in preferred order
  rationale TEXT,
  performance_score NUMERIC(5,2), -- how well this rule performs
  
  -- Usage Stats
  times_applied INTEGER DEFAULT 0,
  avg_engagement_rate NUMERIC(5,2),
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for Performance
CREATE INDEX idx_listing_photos_transaction ON listing_photos(transaction_id);
CREATE INDEX idx_listing_photos_property ON listing_photos(property_id);
CREATE INDEX idx_listing_photos_agent ON listing_photos(agent_id);
CREATE INDEX idx_listing_photos_display_order ON listing_photos(transaction_id, display_order);
CREATE INDEX idx_listing_photos_hero ON listing_photos(transaction_id, is_hero) WHERE is_hero = true;
CREATE INDEX idx_listing_photos_type ON listing_photos(photo_type);
CREATE INDEX idx_enhancement_jobs_status ON photo_enhancement_jobs(status);
CREATE INDEX idx_enhancement_jobs_photo ON photo_enhancement_jobs(photo_id);
CREATE INDEX idx_ordering_rules_agent ON photo_ordering_rules(agent_id);
CREATE INDEX idx_ordering_rules_property_type ON photo_ordering_rules(property_type);

-- Enable Row Level Security
ALTER TABLE listing_photos ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_enhancement_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE photo_ordering_rules ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Agents manage own listing photos" ON listing_photos
  FOR ALL USING (
    agent_id = auth.uid()::uuid OR
    agent_id IS NULL
  );

CREATE POLICY "Agents manage own enhancement jobs" ON photo_enhancement_jobs
  FOR ALL USING (
    photo_id IN (
      SELECT id FROM listing_photos WHERE agent_id = auth.uid()::uuid
    )
  );

CREATE POLICY "Agents manage own ordering rules" ON photo_ordering_rules
  FOR ALL USING (
    agent_id = auth.uid()::uuid OR
    agent_id IS NULL
  );

-- Function to increment photo views
CREATE OR REPLACE FUNCTION increment_photo_views(photo_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE listing_photos
  SET view_count = view_count + 1,
      updated_at = NOW()
  WHERE id = photo_id;
END;
$$ LANGUAGE plpgsql;

-- Function to update photo engagement score
CREATE OR REPLACE FUNCTION update_photo_engagement_score(photo_id UUID)
RETURNS VOID AS $$
DECLARE
  photo_record RECORD;
BEGIN
  SELECT view_count, display_order INTO photo_record
  FROM listing_photos
  WHERE id = photo_id;
  
  IF photo_record IS NOT NULL THEN
    UPDATE listing_photos
    SET engagement_score = photo_record.view_count / GREATEST(photo_record.display_order, 1),
        updated_at = NOW()
    WHERE id = photo_id;
  END IF;
END;
$$ LANGUAGE plpgsql;
