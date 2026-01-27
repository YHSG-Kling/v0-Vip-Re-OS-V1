-- Public Tools & Educational Content Schema
-- Zero-friction, no-gate lead generation system

-- Tool usage tracking (anonymous)
CREATE TABLE IF NOT EXISTS tool_usage_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tool_name TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  session_data_json JSONB,
  time_spent_seconds INTEGER DEFAULT 0,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  ip_address TEXT,
  user_agent TEXT,
  referrer TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tool_usage_visitor ON tool_usage_sessions(visitor_id);
CREATE INDEX idx_tool_usage_tool ON tool_usage_sessions(tool_name);
CREATE INDEX idx_tool_usage_timestamp ON tool_usage_sessions(timestamp);

-- Saved calculations (shareable results)
CREATE TABLE IF NOT EXISTS saved_calculations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  calculation_type TEXT,
  input_parameters_json JSONB NOT NULL,
  results_json JSONB NOT NULL,
  shareable_link TEXT UNIQUE NOT NULL,
  saved_at TIMESTAMPTZ DEFAULT NOW(),
  expiry_date TIMESTAMPTZ,
  views_count INTEGER DEFAULT 0,
  shares_count INTEGER DEFAULT 0,
  email_captured TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_saved_calc_visitor ON saved_calculations(visitor_id);
CREATE INDEX idx_saved_calc_link ON saved_calculations(shareable_link);
CREATE INDEX idx_saved_calc_tool ON saved_calculations(tool_name);

-- Share tracking (viral coefficient)
CREATE TABLE IF NOT EXISTS tool_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  calculation_id UUID REFERENCES saved_calculations(id),
  tool_name TEXT NOT NULL,
  shared_via TEXT, -- 'link', 'email', 'social'
  visitor_id TEXT NOT NULL,
  shared_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tool_shares_calc ON tool_shares(calculation_id);
CREATE INDEX idx_tool_shares_visitor ON tool_shares(visitor_id);

-- Neighborhood guides (SEO content)
CREATE TABLE IF NOT EXISTS neighborhood_guides (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  neighborhood_name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  one_line_description TEXT,
  hero_photo_url TEXT,
  photos JSONB, -- Array of photo URLs
  
  -- Quick stats
  median_price INTEGER,
  price_trend_percent DECIMAL(5,2),
  school_rating DECIMAL(3,1),
  walkability_score INTEGER,
  
  -- Detailed content
  pros JSONB, -- Array of pros
  cons JSONB, -- Array of cons
  hidden_gems JSONB, -- Local spots
  
  -- Schools
  schools JSONB,
  
  -- Future development
  future_development JSONB,
  
  -- Best streets/areas
  best_streets JSONB,
  
  -- Safety
  crime_data JSONB,
  safe_areas TEXT[],
  safety_tips TEXT[],
  
  -- Commute
  commute_data JSONB,
  
  -- Testimonials
  resident_quotes JSONB,
  
  -- SEO
  meta_title TEXT,
  meta_description TEXT,
  
  -- Status
  status TEXT DEFAULT 'draft', -- draft, review, published
  published_at TIMESTAMPTZ,
  views_count INTEGER DEFAULT 0,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_neighborhood_slug ON neighborhood_guides(slug);
CREATE INDEX idx_neighborhood_city ON neighborhood_guides(city);
CREATE INDEX idx_neighborhood_status ON neighborhood_guides(status);

-- Educational content library
CREATE TABLE IF NOT EXISTS educational_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  content_type TEXT NOT NULL, -- 'guide', 'video', 'worksheet', 'checklist'
  description TEXT,
  
  -- Content
  content_html TEXT,
  file_url TEXT,
  video_url TEXT,
  pages INTEGER,
  
  -- Metadata
  topics TEXT[], -- ['first-time-buyer', 'selling', 'investing']
  difficulty_level TEXT, -- 'beginner', 'intermediate', 'advanced'
  estimated_read_time INTEGER, -- minutes
  
  -- Downloads/views
  downloads_count INTEGER DEFAULT 0,
  views_count INTEGER DEFAULT 0,
  
  -- SEO
  meta_title TEXT,
  meta_description TEXT,
  
  -- Status
  status TEXT DEFAULT 'draft',
  published_at TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_educational_slug ON educational_content(slug);
CREATE INDEX idx_educational_topics ON educational_content USING gin(topics);
CREATE INDEX idx_educational_status ON educational_content(status);

-- Community members (optional membership)
CREATE TABLE IF NOT EXISTS community_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  first_name TEXT,
  last_name TEXT,
  
  -- Membership
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  status TEXT DEFAULT 'active', -- active, inactive
  
  -- Preferences
  interests TEXT[], -- ['buying', 'selling', 'investing']
  neighborhoods_of_interest TEXT[],
  email_frequency TEXT DEFAULT 'weekly', -- daily, weekly, monthly
  
  -- Engagement
  forum_posts_count INTEGER DEFAULT 0,
  guides_downloaded INTEGER DEFAULT 0,
  tools_used INTEGER DEFAULT 0,
  
  -- Conversion tracking
  became_lead BOOLEAN DEFAULT FALSE,
  lead_id UUID,
  conversion_date TIMESTAMPTZ,
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_community_email ON community_members(email);
CREATE INDEX idx_community_status ON community_members(status);

-- Portal access (magic link authentication for clients)
CREATE TABLE IF NOT EXISTS portal_access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL,
  transaction_id UUID,
  
  -- Authentication
  magic_link_token TEXT UNIQUE NOT NULL,
  token_expires_at TIMESTAMPTZ NOT NULL,
  last_login_at TIMESTAMPTZ,
  
  -- Access level
  access_level TEXT DEFAULT 'client', -- client, viewer, admin
  
  -- Status
  status TEXT DEFAULT 'active', -- active, revoked
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_portal_contact ON portal_access(contact_id);
CREATE INDEX idx_portal_token ON portal_access(magic_link_token);
CREATE INDEX idx_portal_transaction ON portal_access(transaction_id);

-- Playbook progress tracking
CREATE TABLE IF NOT EXISTS playbook_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL,
  playbook_type TEXT NOT NULL, -- 'first_time_buyer', 'seller', 'investor'
  
  -- Progress
  current_chapter INTEGER DEFAULT 1,
  completed_chapters INTEGER[] DEFAULT ARRAY[]::INTEGER[],
  percent_complete DECIMAL(5,2) DEFAULT 0,
  
  -- Engagement
  last_accessed_at TIMESTAMPTZ,
  total_time_spent INTEGER DEFAULT 0, -- seconds
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  UNIQUE(contact_id, playbook_type)
);

CREATE INDEX idx_playbook_contact ON playbook_progress(contact_id);

-- Trust ladder / micro-commitments tracking
CREATE TABLE IF NOT EXISTS trust_ladder_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  visitor_id TEXT NOT NULL,
  contact_id UUID,
  
  -- Event
  event_type TEXT NOT NULL, -- 'tool_used', 'results_saved', 'guide_downloaded', 'community_joined', etc.
  event_data JSONB,
  
  -- Scoring
  trust_boost INTEGER DEFAULT 0,
  value_delivered INTEGER DEFAULT 0,
  
  -- Conversion probability after event
  conversion_probability DECIMAL(5,4),
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_trust_ladder_visitor ON trust_ladder_events(visitor_id);
CREATE INDEX idx_trust_ladder_contact ON trust_ladder_events(contact_id);
CREATE INDEX idx_trust_ladder_event ON trust_ladder_events(event_type);

COMMIT;
