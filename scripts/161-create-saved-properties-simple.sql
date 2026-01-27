-- Simplified saved_properties table with contact_id
-- Drop existing table if needed and recreate

DROP TABLE IF EXISTS property_search_log CASCADE;
DROP TABLE IF EXISTS property_views CASCADE;
DROP TABLE IF EXISTS saved_properties CASCADE;

CREATE TABLE saved_properties (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  mls_number TEXT NOT NULL,
  property_address TEXT,
  list_price NUMERIC,
  beds INTEGER,
  baths NUMERIC,
  sqft INTEGER,
  property_type TEXT,
  listing_photos JSONB,
  listing_url TEXT,
  notes TEXT,
  rating TEXT CHECK (rating IN ('love', 'like', 'neutral', 'dislike', 'pass')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE property_views (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  mls_number TEXT NOT NULL,
  time_spent_seconds INTEGER DEFAULT 0,
  viewed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE property_search_log (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  natural_query TEXT,
  extracted_filters JSONB,
  results_count INTEGER DEFAULT 0,
  intent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_saved_props_contact ON saved_properties(contact_id);
CREATE INDEX idx_saved_props_mls ON saved_properties(mls_number);
CREATE INDEX idx_property_views_contact ON property_views(contact_id);
CREATE INDEX idx_property_views_mls ON property_views(mls_number);
CREATE INDEX idx_property_search_contact ON property_search_log(contact_id);
CREATE INDEX idx_property_search_created ON property_search_log(created_at DESC);

-- RLS with simple policies (service role bypass)
ALTER TABLE saved_properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_search_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role manages saved_properties" ON saved_properties FOR ALL USING (true);
CREATE POLICY "Service role manages property_views" ON property_views FOR ALL USING (true);
CREATE POLICY "Service role manages property_search_log" ON property_search_log FOR ALL USING (true);

-- Insert some demo saved properties for the first-time buyer demo contact
INSERT INTO saved_properties (contact_id, mls_number, property_address, list_price, beds, baths, sqft, property_type, rating, notes)
VALUES 
  ('00000000-0000-0000-0000-000000000001', 'MLS-2024-001', '123 Oak Lane, Austin, TX 78701', 425000, 3, 2, 1850, 'Single Family', 'love', 'Great backyard and close to work!'),
  ('00000000-0000-0000-0000-000000000001', 'MLS-2024-002', '456 Pine Street, Austin, TX 78702', 389000, 3, 2.5, 1650, 'Townhouse', 'like', 'Nice kitchen, smaller yard'),
  ('00000000-0000-0000-0000-000000000001', 'MLS-2024-003', '789 Elm Drive, Austin, TX 78703', 475000, 4, 3, 2200, 'Single Family', 'neutral', 'Needs some updates but good potential'),
  ('00000000-0000-0000-0000-000000000001', 'MLS-2024-004', '321 Maple Court, Austin, TX 78704', 350000, 2, 2, 1400, 'Condo', 'like', 'Great location downtown');
