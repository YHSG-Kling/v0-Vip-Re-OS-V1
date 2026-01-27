-- AI Marketing Automation Schema v2
-- Supports Newsletter, Direct Mail, Listing Creation, and Offer Creation with AI
-- Fixed version with proper error handling

-- ============================================
-- NEWSLETTERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS newsletters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  subject VARCHAR(255) NOT NULL,
  preheader VARCHAR(255),
  content JSONB NOT NULL,
  audience_segment VARCHAR(50) NOT NULL,
  quality_score INTEGER DEFAULT 0,
  them_percentage INTEGER DEFAULT 0,
  status VARCHAR(20) DEFAULT 'draft',
  scheduled_at TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  recipients_count INTEGER DEFAULT 0,
  open_rate DECIMAL(5,2),
  click_rate DECIMAL(5,2),
  unsubscribe_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_newsletters_agent ON newsletters(agent_id);
CREATE INDEX IF NOT EXISTS idx_newsletters_status ON newsletters(status);
CREATE INDEX IF NOT EXISTS idx_newsletters_scheduled ON newsletters(scheduled_at);

-- ============================================
-- DIRECT MAIL CAMPAIGNS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS direct_mail_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  mail_type VARCHAR(50) NOT NULL,
  target_audience VARCHAR(50) NOT NULL,
  property_id UUID,
  farm_area_zip VARCHAR(10),
  headline VARCHAR(255) NOT NULL,
  content JSONB NOT NULL,
  target_count INTEGER DEFAULT 0,
  estimated_cost DECIMAL(10,2),
  actual_cost DECIMAL(10,2),
  mailed_count INTEGER DEFAULT 0,
  response_count INTEGER DEFAULT 0,
  response_rate DECIMAL(5,2),
  status VARCHAR(20) DEFAULT 'draft',
  print_vendor VARCHAR(100),
  tracking_codes JSONB,
  mailed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_direct_mail_agent ON direct_mail_campaigns(agent_id);
CREATE INDEX IF NOT EXISTS idx_direct_mail_status ON direct_mail_campaigns(status);
CREATE INDEX IF NOT EXISTS idx_direct_mail_audience ON direct_mail_campaigns(target_audience);

-- ============================================
-- LISTING MARKETING CONTENT TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS listing_marketing_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id UUID NOT NULL,
  agent_id UUID,
  content_type VARCHAR(50) NOT NULL,
  content JSONB NOT NULL,
  platform VARCHAR(50),
  published_at TIMESTAMPTZ,
  engagement_stats JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_listing_marketing_listing ON listing_marketing_content(listing_id);
CREATE INDEX IF NOT EXISTS idx_listing_marketing_type ON listing_marketing_content(content_type);
CREATE INDEX IF NOT EXISTS idx_listing_marketing_agent ON listing_marketing_content(agent_id);

-- ============================================
-- NEWSLETTER SUBSCRIBERS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS newsletter_subscribers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  contact_id UUID,
  email VARCHAR(255) NOT NULL,
  first_name VARCHAR(100),
  last_name VARCHAR(100),
  segment VARCHAR(50) DEFAULT 'general',
  subscribed_at TIMESTAMPTZ DEFAULT NOW(),
  unsubscribed_at TIMESTAMPTZ,
  status VARCHAR(20) DEFAULT 'active',
  preferences JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_newsletter_sub_agent ON newsletter_subscribers(agent_id);
CREATE INDEX IF NOT EXISTS idx_newsletter_sub_segment ON newsletter_subscribers(segment);
CREATE INDEX IF NOT EXISTS idx_newsletter_sub_status ON newsletter_subscribers(status);

-- ============================================
-- NEWSLETTER SEND HISTORY
-- ============================================
CREATE TABLE IF NOT EXISTS newsletter_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  newsletter_id UUID NOT NULL,
  subscriber_id UUID NOT NULL,
  sent_at TIMESTAMPTZ DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  opened_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  bounced BOOLEAN DEFAULT FALSE,
  bounce_reason VARCHAR(255),
  unsubscribed BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_newsletter_sends_newsletter ON newsletter_sends(newsletter_id);
CREATE INDEX IF NOT EXISTS idx_newsletter_sends_subscriber ON newsletter_sends(subscriber_id);

-- ============================================
-- DIRECT MAIL RECIPIENTS TABLE
-- ============================================
CREATE TABLE IF NOT EXISTS direct_mail_recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL,
  contact_id UUID,
  name VARCHAR(255),
  address_line1 VARCHAR(255) NOT NULL,
  address_line2 VARCHAR(255),
  city VARCHAR(100) NOT NULL,
  state VARCHAR(50) NOT NULL,
  zip VARCHAR(20) NOT NULL,
  tracking_code VARCHAR(50),
  mailed_at TIMESTAMPTZ,
  delivered_at TIMESTAMPTZ,
  returned BOOLEAN DEFAULT FALSE,
  responded BOOLEAN DEFAULT FALSE,
  response_date TIMESTAMPTZ,
  response_type VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_dm_recipients_campaign ON direct_mail_recipients(campaign_id);
CREATE INDEX IF NOT EXISTS idx_dm_recipients_contact ON direct_mail_recipients(contact_id);
CREATE INDEX IF NOT EXISTS idx_dm_recipients_tracking ON direct_mail_recipients(tracking_code);

-- ============================================
-- AI ENHANCEMENT COLUMNS (Safe additions)
-- ============================================
DO $$ 
BEGIN
  -- Add AI columns to offers table if they don't exist
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'offers' AND column_name = 'ai_analysis') THEN
    ALTER TABLE offers ADD COLUMN ai_analysis JSONB;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'offers' AND column_name = 'strength_score') THEN
    ALTER TABLE offers ADD COLUMN strength_score INTEGER;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'offers' AND column_name = 'escalation_clause') THEN
    ALTER TABLE offers ADD COLUMN escalation_clause JSONB;
  END IF;
  
  -- Add AI columns to listings table if they don't exist
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'listings' AND column_name = 'ai_suggested_price') THEN
    ALTER TABLE listings ADD COLUMN ai_suggested_price JSONB;
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'listings' AND column_name = 'target_personas') THEN
    ALTER TABLE listings ADD COLUMN target_personas TEXT[];
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'listings' AND column_name = 'marketing_strategy') THEN
    ALTER TABLE listings ADD COLUMN marketing_strategy TEXT[];
  END IF;
  
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'listings' AND column_name = 'marketing_description') THEN
    ALTER TABLE listings ADD COLUMN marketing_description TEXT;
  END IF;
END $$;

-- ============================================
-- ROW LEVEL SECURITY
-- ============================================
ALTER TABLE newsletters ENABLE ROW LEVEL SECURITY;
ALTER TABLE direct_mail_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_marketing_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE direct_mail_recipients ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist and recreate
DROP POLICY IF EXISTS "Agents can manage own newsletters" ON newsletters;
CREATE POLICY "Agents can manage own newsletters" ON newsletters
  FOR ALL USING (agent_id = auth.uid());

DROP POLICY IF EXISTS "Agents can manage own direct mail" ON direct_mail_campaigns;
CREATE POLICY "Agents can manage own direct mail" ON direct_mail_campaigns
  FOR ALL USING (agent_id = auth.uid());

DROP POLICY IF EXISTS "Agents can manage listing marketing" ON listing_marketing_content;
CREATE POLICY "Agents can manage listing marketing" ON listing_marketing_content
  FOR ALL USING (agent_id = auth.uid());

DROP POLICY IF EXISTS "Agents can manage own subscribers" ON newsletter_subscribers;
CREATE POLICY "Agents can manage own subscribers" ON newsletter_subscribers
  FOR ALL USING (agent_id = auth.uid());

DROP POLICY IF EXISTS "Agents can view own newsletter sends" ON newsletter_sends;
CREATE POLICY "Agents can view own newsletter sends" ON newsletter_sends
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM newsletters WHERE newsletters.id = newsletter_sends.newsletter_id 
      AND newsletters.agent_id = auth.uid()
    )
  );

DROP POLICY IF EXISTS "Agents can manage dm recipients" ON direct_mail_recipients;
CREATE POLICY "Agents can manage dm recipients" ON direct_mail_recipients
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM direct_mail_campaigns WHERE direct_mail_campaigns.id = direct_mail_recipients.campaign_id 
      AND direct_mail_campaigns.agent_id = auth.uid()
    )
  );

-- ============================================
-- PERFORMANCE FUNCTIONS
-- ============================================
CREATE OR REPLACE FUNCTION calculate_newsletter_performance(newsletter_uuid UUID)
RETURNS JSONB AS $$
DECLARE
  result JSONB;
BEGIN
  SELECT jsonb_build_object(
    'total_sent', COUNT(*),
    'delivered', COUNT(*) FILTER (WHERE delivered_at IS NOT NULL),
    'opened', COUNT(*) FILTER (WHERE opened_at IS NOT NULL),
    'clicked', COUNT(*) FILTER (WHERE clicked_at IS NOT NULL),
    'bounced', COUNT(*) FILTER (WHERE bounced = TRUE),
    'unsubscribed', COUNT(*) FILTER (WHERE unsubscribed = TRUE),
    'open_rate', ROUND(COUNT(*) FILTER (WHERE opened_at IS NOT NULL)::NUMERIC / NULLIF(COUNT(*), 0) * 100, 2),
    'click_rate', ROUND(COUNT(*) FILTER (WHERE clicked_at IS NOT NULL)::NUMERIC / NULLIF(COUNT(*), 0) * 100, 2)
  ) INTO result
  FROM newsletter_sends
  WHERE newsletter_id = newsletter_uuid;
  
  RETURN result;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION calculate_dm_campaign_roi(campaign_uuid UUID)
RETURNS JSONB AS $$
DECLARE
  result JSONB;
  campaign_cost DECIMAL;
  response_value DECIMAL;
BEGIN
  SELECT actual_cost INTO campaign_cost 
  FROM direct_mail_campaigns WHERE id = campaign_uuid;
  
  SELECT COUNT(*) * 500 INTO response_value
  FROM direct_mail_recipients 
  WHERE campaign_id = campaign_uuid AND responded = TRUE;
  
  SELECT jsonb_build_object(
    'total_mailed', COUNT(*),
    'delivered', COUNT(*) FILTER (WHERE delivered_at IS NOT NULL),
    'returned', COUNT(*) FILTER (WHERE returned = TRUE),
    'responses', COUNT(*) FILTER (WHERE responded = TRUE),
    'response_rate', ROUND(COUNT(*) FILTER (WHERE responded = TRUE)::NUMERIC / NULLIF(COUNT(*), 0) * 100, 2),
    'cost', campaign_cost,
    'estimated_value', response_value,
    'roi', CASE WHEN campaign_cost > 0 THEN ROUND((response_value - campaign_cost) / campaign_cost * 100, 2) ELSE 0 END
  ) INTO result
  FROM direct_mail_recipients
  WHERE campaign_id = campaign_uuid;
  
  RETURN result;
END;
$$ LANGUAGE plpgsql;
