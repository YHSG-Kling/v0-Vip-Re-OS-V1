-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║ DEAD — DO NOT RE-RUN. The `vendor_directory` table this file touches no   ║
-- ║ longer exists: m355 folded its curation columns onto `vendors` and        ║
-- ║ dropped it (one vendor system, per the owner's ruling on drift).          ║
-- ║ Re-running would DROP ... CASCADE, recreate a different shape, AND point  ║
-- ║ listing_marketing_services.vendor_id at it — that FK targets vendors(id).║
-- ║ Kept only as the historical record of how the schema got here.           ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- =====================================================
-- LISTING MARKETING PACKAGE AUTOMATION SYSTEM
-- Automated vendor booking, multi-platform syndication, AI optimization
-- =====================================================

-- Drop existing tables if they exist
DROP TABLE IF EXISTS ai_listing_optimizations CASCADE;
DROP TABLE IF EXISTS listing_performance_analytics CASCADE;
DROP TABLE IF EXISTS listing_syndication_tracking CASCADE;
DROP TABLE IF EXISTS listing_marketing_services CASCADE;
DROP TABLE IF EXISTS listing_marketing_packages CASCADE;
DROP TABLE IF EXISTS vendor_directory CASCADE;

-- Vendor Directory
CREATE TABLE vendor_directory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  vendor_name TEXT NOT NULL,
  vendor_type TEXT NOT NULL, -- photographer, drone_operator, stager, videographer, 3d_tour, twilight, floorplan
  email TEXT,
  phone TEXT,
  service_area JSONB, -- cities/zips they cover
  average_rating NUMERIC DEFAULT 0,
  total_jobs INTEGER DEFAULT 0,
  base_pricing JSONB, -- pricing by service type
  availability_calendar JSONB,
  preferred BOOLEAN DEFAULT false,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Listing Marketing Packages
CREATE TABLE listing_marketing_packages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  property_id UUID REFERENCES listings(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  package_tier TEXT NOT NULL CHECK (package_tier IN ('basic', 'premium', 'luxury')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'completed', 'cancelled')),
  activated_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  total_cost_cents INTEGER DEFAULT 0,
  services_included JSONB,
  auto_booked_services JSONB,
  performance_score NUMERIC,
  roi_metrics JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Listing Marketing Services
CREATE TABLE listing_marketing_services (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID REFERENCES listing_marketing_packages(id) ON DELETE CASCADE,
  service_type TEXT NOT NULL,
  vendor_id UUID REFERENCES vendor_directory(id) ON DELETE SET NULL,
  scheduled_date DATE,
  completed_date DATE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'scheduled', 'in_progress', 'completed', 'cancelled')),
  cost_cents INTEGER DEFAULT 0,
  deliverables_url JSONB,
  auto_booked BOOLEAN DEFAULT false,
  vendor_response TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Listing Syndication Tracking
CREATE TABLE listing_syndication_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID REFERENCES listing_marketing_packages(id) ON DELETE CASCADE,
  transaction_id UUID REFERENCES transactions(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  syndicated_at TIMESTAMPTZ,
  listing_url TEXT,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'pending', 'removed', 'error')),
  views INTEGER DEFAULT 0,
  saves INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  inquiries INTEGER DEFAULT 0,
  last_synced_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Listing Performance Analytics
CREATE TABLE listing_performance_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID REFERENCES listing_marketing_packages(id) ON DELETE CASCADE,
  date DATE NOT NULL,
  total_views INTEGER DEFAULT 0,
  total_inquiries INTEGER DEFAULT 0,
  showings_scheduled INTEGER DEFAULT 0,
  offers_received INTEGER DEFAULT 0,
  avg_dom_comparison NUMERIC,
  social_engagement INTEGER DEFAULT 0,
  email_opens INTEGER DEFAULT 0,
  website_traffic INTEGER DEFAULT 0,
  lead_quality_score NUMERIC,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(package_id, date)
);

-- AI Listing Optimizations
CREATE TABLE ai_listing_optimizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_id UUID REFERENCES listing_marketing_packages(id) ON DELETE CASCADE,
  optimization_type TEXT NOT NULL,
  current_state JSONB,
  recommended_change TEXT NOT NULL,
  predicted_impact TEXT,
  confidence_score NUMERIC,
  implemented BOOLEAN DEFAULT false,
  implemented_at TIMESTAMPTZ,
  actual_impact TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for Performance
CREATE INDEX idx_vendor_directory_type ON vendor_directory(vendor_type) WHERE active = true;
CREATE INDEX idx_vendor_directory_agent ON vendor_directory(agent_id);
CREATE INDEX idx_marketing_packages_transaction ON listing_marketing_packages(transaction_id);
CREATE INDEX idx_marketing_packages_agent ON listing_marketing_packages(agent_id);
CREATE INDEX idx_marketing_packages_status ON listing_marketing_packages(status);
CREATE INDEX idx_marketing_services_package ON listing_marketing_services(package_id);
CREATE INDEX idx_marketing_services_vendor ON listing_marketing_services(vendor_id);
CREATE INDEX idx_syndication_tracking_package ON listing_syndication_tracking(package_id);
CREATE INDEX idx_syndication_tracking_transaction ON listing_syndication_tracking(transaction_id);
CREATE INDEX idx_performance_analytics_package ON listing_performance_analytics(package_id);
CREATE INDEX idx_performance_analytics_date ON listing_performance_analytics(date);
CREATE INDEX idx_ai_optimizations_package ON ai_listing_optimizations(package_id);

-- Enable Row Level Security
ALTER TABLE vendor_directory ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_marketing_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_marketing_services ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_syndication_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_performance_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_listing_optimizations ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY "Agents manage own vendors" ON vendor_directory
  FOR ALL USING (
    agent_id = auth.uid()::uuid OR
    agent_id IS NULL
  );

CREATE POLICY "Agents manage own packages" ON listing_marketing_packages
  FOR ALL USING (
    agent_id = auth.uid()::uuid OR
    agent_id IS NULL
  );

CREATE POLICY "Agents view own services" ON listing_marketing_services
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM listing_marketing_packages
      WHERE listing_marketing_packages.id = listing_marketing_services.package_id
      AND (listing_marketing_packages.agent_id = auth.uid()::uuid OR listing_marketing_packages.agent_id IS NULL)
    )
  );

CREATE POLICY "Agents view own syndication" ON listing_syndication_tracking
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM listing_marketing_packages
      WHERE listing_marketing_packages.id = listing_syndication_tracking.package_id
      AND (listing_marketing_packages.agent_id = auth.uid()::uuid OR listing_marketing_packages.agent_id IS NULL)
    )
  );

CREATE POLICY "Agents view own analytics" ON listing_performance_analytics
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM listing_marketing_packages
      WHERE listing_marketing_packages.id = listing_performance_analytics.package_id
      AND (listing_marketing_packages.agent_id = auth.uid()::uuid OR listing_marketing_packages.agent_id IS NULL)
    )
  );

CREATE POLICY "Agents view own optimizations" ON ai_listing_optimizations
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM listing_marketing_packages
      WHERE listing_marketing_packages.id = ai_listing_optimizations.package_id
      AND (listing_marketing_packages.agent_id = auth.uid()::uuid OR listing_marketing_packages.agent_id IS NULL)
    )
  );

COMMIT;
