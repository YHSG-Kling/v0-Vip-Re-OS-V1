-- Agent API Credentials System
-- Stores encrypted API keys and OAuth tokens per agent

CREATE TABLE IF NOT EXISTS agent_api_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  brokerage_id UUID REFERENCES brokerages(id) ON DELETE CASCADE,
  
  -- Service identification
  service_name TEXT NOT NULL, -- 'idx_broker', 'ghl', 'meta', 'linkedin', 'twitter'
  service_type TEXT NOT NULL, -- 'listing_provider', 'crm_sync', 'social_media'
  
  -- Encrypted credentials (use Supabase vault or encryption)
  api_key TEXT, -- For IDX Broker, GHL API key
  api_secret TEXT, -- For services that need secret
  access_token TEXT, -- OAuth tokens for social media
  refresh_token TEXT, -- OAuth refresh tokens
  token_expires_at TIMESTAMPTZ, -- Token expiration
  
  -- Service-specific config
  config JSONB DEFAULT '{}', -- Additional service configs
  -- Examples:
  -- IDX: {"mls_id": "12345", "agent_code": "ABC"}
  -- GHL: {"location_id": "xyz", "sub_account_id": "abc"}
  -- Meta: {"page_id": "123", "instagram_account_id": "456"}
  
  -- Status
  is_active BOOLEAN DEFAULT true,
  is_verified BOOLEAN DEFAULT false, -- Connection tested successfully
  last_verified_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ, -- For GHL sync
  error_message TEXT, -- Last error if connection failed
  
  -- Metadata
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  
  -- Ensure one credential per agent per service
  UNIQUE(agent_id, service_name)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_agent_api_credentials_agent ON agent_api_credentials(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_api_credentials_service ON agent_api_credentials(service_name);
CREATE INDEX IF NOT EXISTS idx_agent_api_credentials_active ON agent_api_credentials(agent_id, is_active);

-- RLS Policies
ALTER TABLE agent_api_credentials ENABLE ROW LEVEL SECURITY;

-- Agents can only see and manage their own credentials
CREATE POLICY "Agents manage own API credentials"
  ON agent_api_credentials
  FOR ALL
  USING (agent_id = auth.uid());

-- Brokers and admins can view agent credentials in their brokerage
CREATE POLICY "Brokers view brokerage agent credentials"
  ON agent_api_credentials
  FOR SELECT
  USING (
    brokerage_id IN (
      SELECT brokerage_id FROM users WHERE id = auth.uid() AND user_role IN ('broker', 'admin')
    )
  );

-- Updated timestamp trigger
CREATE OR REPLACE FUNCTION update_agent_api_credentials_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_api_credentials_updated_at
  BEFORE UPDATE ON agent_api_credentials
  FOR EACH ROW
  EXECUTE FUNCTION update_agent_api_credentials_updated_at();

-- Sync History Table (tracks GHL bi-directional syncs)
CREATE TABLE IF NOT EXISTS ghl_sync_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  
  sync_type TEXT NOT NULL, -- 'contacts_to_ghl', 'contacts_from_ghl', 'notes_sync', 'sms_history'
  direction TEXT NOT NULL, -- 'to_ghl', 'from_ghl', 'bidirectional'
  
  -- Sync details
  records_processed INTEGER DEFAULT 0,
  records_success INTEGER DEFAULT 0,
  records_failed INTEGER DEFAULT 0,
  
  -- Status
  status TEXT NOT NULL, -- 'running', 'completed', 'failed', 'partial'
  error_details JSONB,
  
  -- Timing
  started_at TIMESTAMPTZ DEFAULT NOW(),
  completed_at TIMESTAMPTZ,
  duration_ms INTEGER,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ghl_sync_history_agent ON ghl_sync_history(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ghl_sync_history_status ON ghl_sync_history(status, created_at DESC);

-- RLS for sync history
ALTER TABLE ghl_sync_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents view own sync history"
  ON ghl_sync_history
  FOR SELECT
  USING (agent_id = auth.uid());

-- Social Publishing Queue (for scheduled posts)
CREATE TABLE IF NOT EXISTS social_publishing_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- Content
  content_text TEXT NOT NULL,
  media_urls TEXT[], -- Array of image/video URLs
  hashtags TEXT[],
  
  -- Platforms (multi-platform posting)
  platforms JSONB NOT NULL, -- {"facebook": true, "instagram": true, "linkedin": false}
  
  -- Scheduling
  scheduled_for TIMESTAMPTZ NOT NULL,
  publish_status TEXT DEFAULT 'scheduled', -- 'scheduled', 'publishing', 'published', 'failed'
  
  -- Publishing results per platform
  publish_results JSONB DEFAULT '{}',
  -- Example: {"facebook": {"post_id": "123", "url": "...", "published_at": "..."}}
  
  -- Metadata
  source_type TEXT, -- 'manual', 'listing', 'video', 'content_idea'
  source_id UUID, -- Reference to listing, video, or content_idea
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  published_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_social_queue_agent ON social_publishing_queue(agent_id);
CREATE INDEX IF NOT EXISTS idx_social_queue_scheduled ON social_publishing_queue(scheduled_for) WHERE publish_status = 'scheduled';
CREATE INDEX IF NOT EXISTS idx_social_queue_status ON social_publishing_queue(publish_status, scheduled_for);

-- RLS for social queue
ALTER TABLE social_publishing_queue ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents manage own social posts"
  ON social_publishing_queue
  FOR ALL
  USING (agent_id = auth.uid());

-- Social Analytics (pulled from APIs)
CREATE TABLE IF NOT EXISTS social_post_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  post_id UUID REFERENCES social_publishing_queue(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  
  platform TEXT NOT NULL, -- 'facebook', 'instagram', 'linkedin', 'twitter'
  platform_post_id TEXT NOT NULL, -- ID from the social platform
  
  -- Metrics (updated periodically)
  likes INTEGER DEFAULT 0,
  comments INTEGER DEFAULT 0,
  shares INTEGER DEFAULT 0,
  views INTEGER DEFAULT 0,
  clicks INTEGER DEFAULT 0,
  reach INTEGER DEFAULT 0,
  engagement_rate DECIMAL(5,2) DEFAULT 0,
  
  last_updated_at TIMESTAMPTZ DEFAULT NOW(),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_social_analytics_agent ON social_post_analytics(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_social_analytics_post ON social_post_analytics(post_id);

-- RLS for analytics
ALTER TABLE social_post_analytics ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Agents view own analytics"
  ON social_post_analytics
  FOR SELECT
  USING (agent_id = auth.uid());

COMMENT ON TABLE agent_api_credentials IS 'Stores encrypted agent-specific API credentials for IDX, GHL, and social media';
COMMENT ON TABLE ghl_sync_history IS 'Tracks bi-directional contact sync between app and GHL';
COMMENT ON TABLE social_publishing_queue IS 'Queue for scheduled social media posts across multiple platforms';
COMMENT ON TABLE social_post_analytics IS 'Analytics data pulled from social media platforms';
