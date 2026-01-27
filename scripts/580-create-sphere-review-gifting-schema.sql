-- Sphere, Review, and Gifting System Schema
-- Comprehensive client relationship management

-- ============================================================================
-- REVIEW SYSTEM TABLES
-- ============================================================================

-- Review requests tracking
CREATE TABLE IF NOT EXISTS review_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id),
  agent_id UUID REFERENCES auth.users(id),
  contact_id UUID REFERENCES contacts(id),
  platform TEXT NOT NULL CHECK (platform IN ('google', 'zillow', 'realtor', 'facebook', 'yelp')),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'text', 'in_person')),
  content JSONB,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'completed', 'declined')),
  sent_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Reviews received
CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES auth.users(id),
  contact_id UUID REFERENCES contacts(id),
  transaction_id UUID REFERENCES transactions(id),
  platform TEXT NOT NULL,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  review_text TEXT,
  reviewer_name TEXT,
  review_url TEXT,
  is_verified BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Review responses
CREATE TABLE IF NOT EXISTS review_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID REFERENCES reviews(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES auth.users(id),
  platform TEXT NOT NULL,
  original_review TEXT,
  rating INTEGER,
  response JSONB,
  status TEXT DEFAULT 'draft' CHECK (status IN ('draft', 'approved', 'posted')),
  posted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Review timing analysis
CREATE TABLE IF NOT EXISTS review_timing_analysis (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id),
  agent_id UUID REFERENCES auth.users(id),
  analysis JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Review recovery plans
CREATE TABLE IF NOT EXISTS review_recovery_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID,
  agent_id UUID REFERENCES auth.users(id),
  client_id UUID REFERENCES contacts(id),
  plan JSONB,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Review monitoring configuration
CREATE TABLE IF NOT EXISTS review_monitoring_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES auth.users(id) UNIQUE,
  platforms TEXT[] DEFAULT ARRAY['google', 'zillow'],
  alert_threshold INTEGER DEFAULT 3,
  notification_email BOOLEAN DEFAULT true,
  notification_sms BOOLEAN DEFAULT false,
  auto_respond_positive BOOLEAN DEFAULT false,
  escalate_negative BOOLEAN DEFAULT true,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- CLIENT GIFTING TABLES
-- ============================================================================

-- Client gifts
CREATE TABLE IF NOT EXISTS client_gifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES auth.users(id),
  contact_id UUID REFERENCES contacts(id),
  transaction_id UUID REFERENCES transactions(id),
  gift_type TEXT NOT NULL,
  gift_description TEXT,
  cost NUMERIC(10,2),
  vendor TEXT,
  occasion TEXT CHECK (occasion IN ('closing', 'anniversary', 'birthday', 'referral_thank_you', 'holiday', 'apology', 'congratulations')),
  personal_note TEXT,
  delivery_address TEXT,
  scheduled_delivery DATE,
  actual_delivery DATE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'ordered', 'shipped', 'delivered', 'cancelled')),
  tracking_number TEXT,
  recipient_feedback TEXT,
  tax_deductible BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Gift vendors
CREATE TABLE IF NOT EXISTS gift_vendors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  category TEXT[],
  website TEXT,
  phone TEXT,
  email TEXT,
  bulk_discount_available BOOLEAN DEFAULT false,
  min_order_for_discount INTEGER,
  discount_percentage NUMERIC(5,2),
  avg_delivery_days INTEGER,
  rating NUMERIC(3,2),
  notes TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Gift templates (pre-approved gifts by occasion)
CREATE TABLE IF NOT EXISTS gift_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID,
  name TEXT NOT NULL,
  description TEXT,
  occasion TEXT[],
  price_tier TEXT CHECK (price_tier IN ('budget', 'standard', 'premium', 'luxury')),
  min_price NUMERIC(10,2),
  max_price NUMERIC(10,2),
  vendor_id UUID REFERENCES gift_vendors(id),
  image_url TEXT,
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- SPHERE MANAGEMENT ENHANCEMENTS
-- ============================================================================

-- Sphere engagement scores (cached)
CREATE TABLE IF NOT EXISTS sphere_engagement_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES auth.users(id),
  contact_id UUID REFERENCES contacts(id),
  engagement_score INTEGER CHECK (engagement_score >= 0 AND engagement_score <= 100),
  referral_potential TEXT CHECK (referral_potential IN ('high', 'medium', 'low')),
  risk_level TEXT CHECK (risk_level IN ('at_risk', 'cooling', 'engaged', 'champion')),
  recommended_action TEXT,
  next_touchpoint_type TEXT,
  urgency TEXT CHECK (urgency IN ('immediate', 'this_week', 'this_month', 'quarterly')),
  calculated_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id, contact_id)
);

-- Sphere segments
CREATE TABLE IF NOT EXISTS sphere_segments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES auth.users(id),
  name TEXT NOT NULL,
  description TEXT,
  criteria JSONB,
  contact_ids UUID[],
  recommended_cadence TEXT,
  recommended_content TEXT[],
  priority TEXT CHECK (priority IN ('high', 'medium', 'low')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_review_requests_agent ON review_requests(agent_id);
CREATE INDEX IF NOT EXISTS idx_review_requests_status ON review_requests(status);
CREATE INDEX IF NOT EXISTS idx_reviews_agent ON reviews(agent_id);
CREATE INDEX IF NOT EXISTS idx_reviews_rating ON reviews(rating);
CREATE INDEX IF NOT EXISTS idx_client_gifts_agent ON client_gifts(agent_id);
CREATE INDEX IF NOT EXISTS idx_client_gifts_contact ON client_gifts(contact_id);
CREATE INDEX IF NOT EXISTS idx_client_gifts_occasion ON client_gifts(occasion);
CREATE INDEX IF NOT EXISTS idx_sphere_scores_agent ON sphere_engagement_scores(agent_id);
CREATE INDEX IF NOT EXISTS idx_sphere_scores_urgency ON sphere_engagement_scores(urgency);

-- ============================================================================
-- RLS POLICIES
-- ============================================================================

ALTER TABLE review_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE review_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_gifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE sphere_engagement_scores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS review_requests_agent_policy ON review_requests;
CREATE POLICY review_requests_agent_policy ON review_requests FOR ALL USING (agent_id = auth.uid());

DROP POLICY IF EXISTS reviews_agent_policy ON reviews;
CREATE POLICY reviews_agent_policy ON reviews FOR ALL USING (agent_id = auth.uid());

DROP POLICY IF EXISTS review_responses_agent_policy ON review_responses;
CREATE POLICY review_responses_agent_policy ON review_responses FOR ALL USING (agent_id = auth.uid());

DROP POLICY IF EXISTS client_gifts_agent_policy ON client_gifts;
CREATE POLICY client_gifts_agent_policy ON client_gifts FOR ALL USING (agent_id = auth.uid());

DROP POLICY IF EXISTS sphere_scores_agent_policy ON sphere_engagement_scores;
CREATE POLICY sphere_scores_agent_policy ON sphere_engagement_scores FOR ALL USING (agent_id = auth.uid());

-- ============================================================================
-- SEED GIFT VENDORS
-- ============================================================================

INSERT INTO gift_vendors (name, category, website, bulk_discount_available, min_order_for_discount, discount_percentage, avg_delivery_days, rating) VALUES
('Tiff''s Treats', ARRAY['cookies', 'sweets'], 'https://tiffstreats.com', true, 10, 10.00, 1, 4.8),
('Wine.com', ARRAY['wine', 'spirits'], 'https://wine.com', true, 6, 15.00, 3, 4.5),
('1-800-Flowers', ARRAY['flowers', 'plants'], 'https://1800flowers.com', true, 5, 10.00, 2, 4.2),
('Harry & David', ARRAY['food', 'fruit', 'gifts'], 'https://harryanddavid.com', true, 10, 12.00, 4, 4.6),
('Etsy Custom Gifts', ARRAY['personalized', 'custom', 'home'], 'https://etsy.com', false, NULL, NULL, 7, 4.4),
('Local Artisan Box', ARRAY['local', 'artisan', 'gift_box'], NULL, true, 20, 20.00, 3, 4.7)
ON CONFLICT DO NOTHING;
