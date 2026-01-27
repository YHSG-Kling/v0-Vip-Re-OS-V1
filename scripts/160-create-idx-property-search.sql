-- IDX Property Search Integration Tables

-- Drop and recreate saved_properties with enhanced schema
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
  intent TEXT, -- 'serious', 'browsing', 'researching'
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_saved_props_contact ON saved_properties(contact_id);
CREATE INDEX idx_saved_props_mls ON saved_properties(mls_number);
CREATE INDEX idx_property_views_contact ON property_views(contact_id);
CREATE INDEX idx_property_views_mls ON property_views(mls_number);
CREATE INDEX idx_property_search_contact ON property_search_log(contact_id);
CREATE INDEX idx_property_search_created ON property_search_log(created_at DESC);

-- RLS Policies
ALTER TABLE saved_properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_views ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_search_log ENABLE ROW LEVEL SECURITY;

-- Agents see only their contacts' property data
CREATE POLICY "Agents see own contacts saved properties"
  ON saved_properties FOR ALL
  USING (
    contact_id IN (
      SELECT id FROM contacts WHERE agent_id = auth.uid()
    )
  );

CREATE POLICY "Agents see own contacts property views"
  ON property_views FOR ALL
  USING (
    contact_id IN (
      SELECT id FROM contacts WHERE agent_id = auth.uid()
    )
  );

CREATE POLICY "Agents see own contacts search log"
  ON property_search_log FOR ALL
  USING (
    contact_id IN (
      SELECT id FROM contacts WHERE agent_id = auth.uid()
    )
  );

-- Admins/Brokers see all
CREATE POLICY "Admins see all saved properties"
  ON saved_properties FOR ALL
  USING (auth.user_is_admin());

CREATE POLICY "Admins see all property views"
  ON property_views FOR ALL
  USING (auth.user_is_admin());

CREATE POLICY "Admins see all search logs"
  ON property_search_log FOR ALL
  USING (auth.user_is_admin());

-- Updated_at trigger
CREATE TRIGGER update_saved_properties_updated_at
  BEFORE UPDATE ON saved_properties
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();
