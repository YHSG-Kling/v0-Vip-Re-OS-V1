-- Public Tools Tables (Zero Friction)
-- These tables support public calculators and tools with optional save/share features

CREATE TABLE IF NOT EXISTS tool_usage_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  session_data_json JSONB,
  time_spent_seconds INTEGER DEFAULT 0,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tool_usage_visitor ON tool_usage_sessions(visitor_id);
CREATE INDEX IF NOT EXISTS idx_tool_usage_tool ON tool_usage_sessions(tool_name);
CREATE INDEX IF NOT EXISTS idx_tool_usage_timestamp ON tool_usage_sessions(timestamp);

COMMIT;

CREATE TABLE IF NOT EXISTS saved_calculations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  calculation_type TEXT,
  input_parameters_json JSONB NOT NULL,
  results_json JSONB NOT NULL,
  shareable_link TEXT UNIQUE,
  email TEXT, -- Optional, only if user provides
  saved_at TIMESTAMPTZ DEFAULT NOW(),
  expiry_date TIMESTAMPTZ DEFAULT NOW() + INTERVAL '90 days',
  view_count INTEGER DEFAULT 0,
  last_viewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_saved_calc_visitor ON saved_calculations(visitor_id);
CREATE INDEX IF NOT EXISTS idx_saved_calc_link ON saved_calculations(shareable_link);
CREATE INDEX IF NOT EXISTS idx_saved_calc_expiry ON saved_calculations(expiry_date);

COMMIT;

CREATE TABLE IF NOT EXISTS tool_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  saved_calculation_id UUID REFERENCES saved_calculations(id),
  tool_name TEXT NOT NULL,
  shared_via TEXT, -- 'link', 'email', 'social'
  visitor_id TEXT,
  shared_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tool_shares_calc ON tool_shares(saved_calculation_id);
CREATE INDEX IF NOT EXISTS idx_tool_shares_tool ON tool_shares(tool_name);

COMMIT;

-- RLS Policies (Public read, anyone can save)
ALTER TABLE tool_usage_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE saved_calculations ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_shares ENABLE ROW LEVEL SECURITY;

-- Allow anyone to insert
CREATE POLICY "Anyone can track tool usage" ON tool_usage_sessions
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Anyone can save calculations" ON saved_calculations
  FOR INSERT WITH CHECK (true);

CREATE POLICY "Anyone can view saved calculations by link" ON saved_calculations
  FOR SELECT USING (shareable_link IS NOT NULL);

CREATE POLICY "Anyone can share" ON tool_shares
  FOR INSERT WITH CHECK (true);

COMMIT;
