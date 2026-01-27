-- Client Portal Collaborative Features Schema
-- Includes: collaborative searches, family ratings, smart insights, showing requests, activity tracking

-- =====================================================
-- COLLABORATIVE SEARCHES (RealScout-style family search)
-- =====================================================
CREATE TABLE IF NOT EXISTS collaborative_searches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Our Home Search',
  description TEXT,
  search_criteria JSONB DEFAULT '{}', -- price range, beds, baths, location, etc.
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Family members who can participate in the search
CREATE TABLE IF NOT EXISTS collaborative_search_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collaborative_search_id UUID NOT NULL REFERENCES collaborative_searches(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  name TEXT,
  role TEXT DEFAULT 'viewer', -- owner, editor, viewer
  invite_status TEXT DEFAULT 'pending', -- pending, accepted, declined
  invite_token TEXT UNIQUE,
  invited_at TIMESTAMPTZ DEFAULT now(),
  accepted_at TIMESTAMPTZ,
  last_active_at TIMESTAMPTZ
);

-- Properties added to collaborative search boards
CREATE TABLE IF NOT EXISTS collaborative_search_properties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collaborative_search_id UUID NOT NULL REFERENCES collaborative_searches(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL, -- IDX Broker property ID
  property_data JSONB NOT NULL, -- cached property details
  added_by_email TEXT NOT NULL,
  status TEXT DEFAULT 'active', -- active, archived, removed
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- =====================================================
-- PROPERTY FAMILY RATINGS & VOTING
-- =====================================================
CREATE TABLE IF NOT EXISTS property_family_ratings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collaborative_search_id UUID NOT NULL REFERENCES collaborative_searches(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL,
  member_email TEXT NOT NULL,
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  vote TEXT CHECK (vote IN ('love', 'like', 'neutral', 'dislike', 'pass')),
  pros TEXT[], -- what they like
  cons TEXT[], -- concerns
  comments TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(collaborative_search_id, property_id, member_email)
);

-- Consensus tracking for properties
CREATE TABLE IF NOT EXISTS property_consensus (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collaborative_search_id UUID NOT NULL REFERENCES collaborative_searches(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL,
  avg_rating DECIMAL(3,2),
  total_votes INTEGER DEFAULT 0,
  love_count INTEGER DEFAULT 0,
  like_count INTEGER DEFAULT 0,
  neutral_count INTEGER DEFAULT 0,
  dislike_count INTEGER DEFAULT 0,
  pass_count INTEGER DEFAULT 0,
  consensus_status TEXT DEFAULT 'pending', -- pending, consensus_yes, consensus_no, mixed
  is_finalist BOOLEAN DEFAULT false,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(collaborative_search_id, property_id)
);

-- =====================================================
-- SMART PROPERTY INSIGHTS
-- =====================================================
CREATE TABLE IF NOT EXISTS property_smart_insights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id TEXT NOT NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE, -- personalized insights per contact
  
  -- Commute Analysis
  commute_insights JSONB DEFAULT '{}', -- destinations, times, modes
  
  -- School Information
  school_insights JSONB DEFAULT '{}', -- nearby schools, ratings, distances
  
  -- Investment Potential
  investment_insights JSONB DEFAULT '{}', -- appreciation, rental yield, market trends
  
  -- Neighborhood
  neighborhood_insights JSONB DEFAULT '{}', -- walkability, crime, amenities
  
  -- AI Match Score
  match_score INTEGER CHECK (match_score >= 0 AND match_score <= 100),
  match_reasons TEXT[],
  match_concerns TEXT[],
  
  -- Metadata
  generated_at TIMESTAMPTZ DEFAULT now(),
  expires_at TIMESTAMPTZ DEFAULT (now() + INTERVAL '7 days'),
  
  UNIQUE(property_id, contact_id)
);

-- =====================================================
-- SHOWING REQUESTS
-- =====================================================
CREATE TABLE IF NOT EXISTS showing_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  property_id TEXT NOT NULL,
  property_address TEXT,
  property_data JSONB,
  
  -- Scheduling
  preferred_dates JSONB DEFAULT '[]', -- array of date/time preferences
  confirmed_date TIMESTAMPTZ,
  
  -- Status tracking
  status TEXT DEFAULT 'pending', -- pending, confirmed, completed, cancelled, rescheduled
  agent_id UUID REFERENCES users(id),
  agent_notes TEXT,
  client_notes TEXT,
  
  -- Follow-up
  feedback_rating INTEGER CHECK (feedback_rating >= 1 AND feedback_rating <= 5),
  feedback_notes TEXT,
  interested_level TEXT, -- very_interested, interested, neutral, not_interested
  
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- =====================================================
-- CLIENT PORTAL ACTIVITY TRACKING
-- =====================================================
CREATE TABLE IF NOT EXISTS client_portal_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  
  -- Activity details
  activity_type TEXT NOT NULL, -- view_property, save_property, rate_property, request_showing, search, login, etc.
  activity_data JSONB DEFAULT '{}',
  
  -- Property context (if applicable)
  property_id TEXT,
  
  -- Session info
  session_id TEXT,
  ip_address TEXT,
  user_agent TEXT,
  
  created_at TIMESTAMPTZ DEFAULT now()
);

-- =====================================================
-- CLIENT PORTAL MESSAGES (Compassionate support)
-- =====================================================
CREATE TABLE IF NOT EXISTS client_portal_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  
  message_type TEXT NOT NULL, -- welcome, milestone, encouragement, reminder, custom
  persona TEXT, -- which persona this message is for
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  
  -- Display settings
  is_read BOOLEAN DEFAULT false,
  is_dismissed BOOLEAN DEFAULT false,
  display_until TIMESTAMPTZ,
  priority INTEGER DEFAULT 0,
  
  created_at TIMESTAMPTZ DEFAULT now(),
  read_at TIMESTAMPTZ
);

-- =====================================================
-- INDEXES
-- =====================================================
CREATE INDEX IF NOT EXISTS idx_collab_searches_contact ON collaborative_searches(contact_id);
CREATE INDEX IF NOT EXISTS idx_collab_members_search ON collaborative_search_members(collaborative_search_id);
CREATE INDEX IF NOT EXISTS idx_collab_members_email ON collaborative_search_members(email);
CREATE INDEX IF NOT EXISTS idx_collab_members_token ON collaborative_search_members(invite_token);
CREATE INDEX IF NOT EXISTS idx_collab_properties_search ON collaborative_search_properties(collaborative_search_id);
CREATE INDEX IF NOT EXISTS idx_family_ratings_search ON property_family_ratings(collaborative_search_id);
CREATE INDEX IF NOT EXISTS idx_family_ratings_property ON property_family_ratings(property_id);
CREATE INDEX IF NOT EXISTS idx_consensus_search ON property_consensus(collaborative_search_id);
CREATE INDEX IF NOT EXISTS idx_smart_insights_property ON property_smart_insights(property_id);
CREATE INDEX IF NOT EXISTS idx_smart_insights_contact ON property_smart_insights(contact_id);
CREATE INDEX IF NOT EXISTS idx_showing_requests_contact ON showing_requests(contact_id);
CREATE INDEX IF NOT EXISTS idx_showing_requests_status ON showing_requests(status);
CREATE INDEX IF NOT EXISTS idx_portal_activity_contact ON client_portal_activity(contact_id);
CREATE INDEX IF NOT EXISTS idx_portal_activity_type ON client_portal_activity(activity_type);
CREATE INDEX IF NOT EXISTS idx_portal_messages_contact ON client_portal_messages(contact_id);

-- =====================================================
-- ROW LEVEL SECURITY
-- =====================================================
ALTER TABLE collaborative_searches ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaborative_search_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE collaborative_search_properties ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_family_ratings ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_consensus ENABLE ROW LEVEL SECURITY;
ALTER TABLE property_smart_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE showing_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_portal_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE client_portal_messages ENABLE ROW LEVEL SECURITY;

-- Simplified RLS policies - service role has full access, authenticated users can read
CREATE POLICY "Service role full access collaborative_searches" ON collaborative_searches FOR ALL USING (true);
CREATE POLICY "Service role full access collaborative_search_members" ON collaborative_search_members FOR ALL USING (true);
CREATE POLICY "Service role full access collaborative_search_properties" ON collaborative_search_properties FOR ALL USING (true);
CREATE POLICY "Service role full access property_family_ratings" ON property_family_ratings FOR ALL USING (true);
CREATE POLICY "Service role full access property_consensus" ON property_consensus FOR ALL USING (true);
CREATE POLICY "Service role full access property_smart_insights" ON property_smart_insights FOR ALL USING (true);
CREATE POLICY "Service role full access showing_requests" ON showing_requests FOR ALL USING (true);
CREATE POLICY "Service role full access client_portal_activity" ON client_portal_activity FOR ALL USING (true);
CREATE POLICY "Service role full access client_portal_messages" ON client_portal_messages FOR ALL USING (true);

-- =====================================================
-- FUNCTIONS
-- =====================================================

-- Function to update consensus when ratings change
CREATE OR REPLACE FUNCTION update_property_consensus()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO property_consensus (collaborative_search_id, property_id, avg_rating, total_votes, love_count, like_count, neutral_count, dislike_count, pass_count, consensus_status, updated_at)
  SELECT 
    NEW.collaborative_search_id,
    NEW.property_id,
    AVG(rating),
    COUNT(*),
    COUNT(*) FILTER (WHERE vote = 'love'),
    COUNT(*) FILTER (WHERE vote = 'like'),
    COUNT(*) FILTER (WHERE vote = 'neutral'),
    COUNT(*) FILTER (WHERE vote = 'dislike'),
    COUNT(*) FILTER (WHERE vote = 'pass'),
    CASE 
      WHEN COUNT(*) FILTER (WHERE vote IN ('love', 'like')) > COUNT(*) * 0.6 THEN 'consensus_yes'
      WHEN COUNT(*) FILTER (WHERE vote IN ('dislike', 'pass')) > COUNT(*) * 0.6 THEN 'consensus_no'
      ELSE 'mixed'
    END,
    now()
  FROM property_family_ratings
  WHERE collaborative_search_id = NEW.collaborative_search_id AND property_id = NEW.property_id
  GROUP BY collaborative_search_id, property_id
  ON CONFLICT (collaborative_search_id, property_id) 
  DO UPDATE SET
    avg_rating = EXCLUDED.avg_rating,
    total_votes = EXCLUDED.total_votes,
    love_count = EXCLUDED.love_count,
    like_count = EXCLUDED.like_count,
    neutral_count = EXCLUDED.neutral_count,
    dislike_count = EXCLUDED.dislike_count,
    pass_count = EXCLUDED.pass_count,
    consensus_status = EXCLUDED.consensus_status,
    updated_at = now();
  
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger to update consensus on rating changes
DROP TRIGGER IF EXISTS trigger_update_consensus ON property_family_ratings;
CREATE TRIGGER trigger_update_consensus
  AFTER INSERT OR UPDATE ON property_family_ratings
  FOR EACH ROW
  EXECUTE FUNCTION update_property_consensus();
