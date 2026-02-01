-- ============================================================================
-- NEWSLETTER SYSTEM SCHEMA
-- Purpose: Complete newsletter template builder, local content, and analytics
-- Tables: newsletter_brokers_templates, newsletter_sections, newsletter_local_content,
--         local_news_sources, newsletter_scheduled_sends, newsletter_send_tracking,
--         newsletter_performance_analytics, newsletter_seo_scores
-- ============================================================================

-- Drop existing policies and tables if they exist
DROP POLICY IF EXISTS "Users view templates from own brokerage" ON newsletter_brokers_templates;
DROP POLICY IF EXISTS "Users create templates in own brokerage" ON newsletter_brokers_templates;
DROP POLICY IF EXISTS "Users update templates in own brokerage" ON newsletter_brokers_templates;
DROP POLICY IF EXISTS "Users delete templates in own brokerage" ON newsletter_brokers_templates;

DROP POLICY IF EXISTS "View sections from own templates" ON newsletter_sections;
DROP POLICY IF EXISTS "Insert sections for own templates" ON newsletter_sections;
DROP POLICY IF EXISTS "Update sections for own templates" ON newsletter_sections;
DROP POLICY IF EXISTS "Delete sections for own templates" ON newsletter_sections;

DROP POLICY IF EXISTS "View local content from own brokerage" ON newsletter_local_content;
DROP POLICY IF EXISTS "Insert local content to own brokerage" ON newsletter_local_content;
DROP POLICY IF EXISTS "Update local content in own brokerage" ON newsletter_local_content;
DROP POLICY IF EXISTS "Delete local content in own brokerage" ON newsletter_local_content;

DROP POLICY IF EXISTS "View news sources from own brokerage" ON local_news_sources;
DROP POLICY IF EXISTS "Insert news sources to own brokerage" ON local_news_sources;
DROP POLICY IF EXISTS "Update news sources in own brokerage" ON local_news_sources;
DROP POLICY IF EXISTS "Delete news sources in own brokerage" ON local_news_sources;

DROP POLICY IF EXISTS "View scheduled sends from own brokerage" ON newsletter_scheduled_sends;
DROP POLICY IF EXISTS "Insert scheduled sends to own brokerage" ON newsletter_scheduled_sends;
DROP POLICY IF EXISTS "Update scheduled sends in own brokerage" ON newsletter_scheduled_sends;
DROP POLICY IF EXISTS "Delete scheduled sends in own brokerage" ON newsletter_scheduled_sends;

DROP POLICY IF EXISTS "View send tracking from own brokerage" ON newsletter_send_tracking;
DROP POLICY IF EXISTS "Insert send tracking for own scheduled sends" ON newsletter_send_tracking;
DROP POLICY IF EXISTS "Update send tracking for own scheduled sends" ON newsletter_send_tracking;

DROP POLICY IF EXISTS "View analytics from own brokerage" ON newsletter_performance_analytics;
DROP POLICY IF EXISTS "Insert analytics for own scheduled sends" ON newsletter_performance_analytics;
DROP POLICY IF EXISTS "Update analytics for own scheduled sends" ON newsletter_performance_analytics;

DROP POLICY IF EXISTS "View seo scores from own brokerage" ON newsletter_seo_scores;
DROP POLICY IF EXISTS "Insert seo scores for own scheduled sends" ON newsletter_seo_scores;
DROP POLICY IF EXISTS "Update seo scores for own scheduled sends" ON newsletter_seo_scores;

DROP TABLE IF EXISTS newsletter_seo_scores CASCADE;
DROP TABLE IF EXISTS newsletter_performance_analytics CASCADE;
DROP TABLE IF EXISTS newsletter_send_tracking CASCADE;
DROP TABLE IF EXISTS newsletter_scheduled_sends CASCADE;
DROP TABLE IF EXISTS local_news_sources CASCADE;
DROP TABLE IF EXISTS newsletter_local_content CASCADE;
DROP TABLE IF EXISTS newsletter_sections CASCADE;
DROP TABLE IF EXISTS newsletter_brokers_templates CASCADE;

-- ============================================================================
-- TABLE 1: newsletter_brokers_templates
-- Purpose: Store approved newsletter templates per brokerage
-- ============================================================================
CREATE TABLE IF NOT EXISTS newsletter_brokers_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  template_name TEXT NOT NULL,
  template_description TEXT,
  template_html TEXT,
  brand_colors JSONB DEFAULT '{"primary":"#000000","secondary":"#FFFFFF","accent":"#0066CC"}',
  logo_url TEXT,
  sections JSONB DEFAULT '[]',
  approval_status TEXT NOT NULL DEFAULT 'draft' CHECK (approval_status IN ('draft', 'pending_review', 'approved', 'rejected')),
  approved_by UUID REFERENCES auth.users(id),
  approved_at TIMESTAMPTZ,
  rejected_reason TEXT,
  rejected_at TIMESTAMPTZ,
  is_default BOOLEAN DEFAULT false,
  version_number INTEGER DEFAULT 1,
  template_tags JSONB DEFAULT '[]',
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  CONSTRAINT template_name_unique_per_brokerage UNIQUE (brokerage_id, template_name)
);

-- ============================================================================
-- TABLE 2: newsletter_sections
-- Purpose: Define sections within a template (e.g., Market Update, Local News)
-- ============================================================================
CREATE TABLE IF NOT EXISTS newsletter_sections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  newsletter_template_id UUID NOT NULL REFERENCES newsletter_brokers_templates(id) ON DELETE CASCADE,
  section_name TEXT NOT NULL,
  section_type TEXT NOT NULL CHECK (section_type IN ('real_estate_tip', 'market_update', 'local_news', 'agent_feature', 'property_highlight')),
  ai_prompt_template TEXT,
  section_order INTEGER NOT NULL,
  is_dynamic BOOLEAN DEFAULT true,
  placeholder_text TEXT,
  min_words INTEGER DEFAULT 50,
  max_words INTEGER DEFAULT 300,
  created_at TIMESTAMPTZ DEFAULT now(),
  
  CONSTRAINT section_order_positive CHECK (section_order > 0)
);

-- ============================================================================
-- TABLE 3: newsletter_local_content
-- Purpose: Store local news/events to include in newsletters
-- ============================================================================
CREATE TABLE IF NOT EXISTS newsletter_local_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  zip_code TEXT NOT NULL,
  market_area TEXT,
  local_event_title TEXT NOT NULL,
  local_event_description TEXT NOT NULL,
  event_date DATE,
  event_category TEXT CHECK (event_category IN ('school_news', 'community_event', 'business_opening', 'infrastructure', 'market_data')),
  source_url TEXT,
  source_name TEXT,
  relevance_score NUMERIC DEFAULT 0 CHECK (relevance_score >= 0 AND relevance_score <= 100),
  is_featured BOOLEAN DEFAULT false,
  included_in_last_newsletter BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now(),
  fetched_from_newsapi BOOLEAN DEFAULT false
);

-- ============================================================================
-- TABLE 4: local_news_sources
-- Purpose: Configure which markets/zips to monitor for local news
-- ============================================================================
CREATE TABLE IF NOT EXISTS local_news_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  market_zip_codes TEXT[] NOT NULL,
  market_name TEXT,
  news_api_source TEXT DEFAULT 'newsapi.org',
  news_api_enabled BOOLEAN DEFAULT true,
  refresh_frequency TEXT DEFAULT 'daily' CHECK (refresh_frequency IN ('hourly', 'daily', 'weekly')),
  last_refresh TIMESTAMPTZ,
  enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- TABLE 5: newsletter_scheduled_sends
-- Purpose: Track scheduled newsletters queued for sending
-- ============================================================================
CREATE TABLE IF NOT EXISTS newsletter_scheduled_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  template_id UUID NOT NULL REFERENCES newsletter_brokers_templates(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES auth.users(id),
  subject_line TEXT NOT NULL,
  preview_text TEXT,
  scheduled_send_time TIMESTAMPTZ NOT NULL,
  recommended_send_time TIMESTAMPTZ,
  send_status TEXT DEFAULT 'scheduled' CHECK (send_status IN ('scheduled', 'sending', 'sent', 'failed', 'cancelled')),
  recipient_segment JSONB DEFAULT '{}',
  recipient_count INTEGER DEFAULT 0,
  sections_included JSONB DEFAULT '[]',
  personalization_variables JSONB DEFAULT '{}',
  ab_test_variant TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  sent_at TIMESTAMPTZ,
  failed_reason TEXT
);

-- ============================================================================
-- TABLE 6: newsletter_send_tracking
-- Purpose: Track individual email sends and engagement (opens, clicks, bounces)
-- ============================================================================
CREATE TABLE IF NOT EXISTS newsletter_send_tracking (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_send_id UUID NOT NULL REFERENCES newsletter_scheduled_sends(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  email_address TEXT NOT NULL,
  sendgrid_message_id TEXT,
  send_status TEXT DEFAULT 'pending' CHECK (send_status IN ('pending', 'sent', 'delivered', 'bounced', 'invalid', 'failed')),
  
  -- Engagement metrics
  opened BOOLEAN DEFAULT false,
  opened_at TIMESTAMPTZ,
  open_count INTEGER DEFAULT 0,
  
  clicked BOOLEAN DEFAULT false,
  clicked_at TIMESTAMPTZ,
  click_count INTEGER DEFAULT 0,
  
  bounced BOOLEAN DEFAULT false,
  bounced_at TIMESTAMPTZ,
  bounce_type TEXT,
  bounce_reason TEXT,
  
  unsubscribed BOOLEAN DEFAULT false,
  unsubscribed_at TIMESTAMPTZ,
  
  complained BOOLEAN DEFAULT false,
  complained_at TIMESTAMPTZ,
  
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- TABLE 7: newsletter_performance_analytics
-- Purpose: Aggregate performance metrics per newsletter send
-- ============================================================================
CREATE TABLE IF NOT EXISTS newsletter_performance_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_send_id UUID NOT NULL REFERENCES newsletter_scheduled_sends(id) ON DELETE CASCADE,
  
  total_sent INTEGER DEFAULT 0,
  total_delivered INTEGER DEFAULT 0,
  total_opened INTEGER DEFAULT 0,
  total_clicked INTEGER DEFAULT 0,
  total_bounced INTEGER DEFAULT 0,
  total_unsubscribed INTEGER DEFAULT 0,
  total_complained INTEGER DEFAULT 0,
  
  open_rate NUMERIC DEFAULT 0,
  click_rate NUMERIC DEFAULT 0,
  bounce_rate NUMERIC DEFAULT 0,
  unsubscribe_rate NUMERIC DEFAULT 0,
  complaint_rate NUMERIC DEFAULT 0,
  
  unique_opens INTEGER DEFAULT 0,
  unique_clicks INTEGER DEFAULT 0,
  
  average_time_to_open INTERVAL,
  average_time_to_click INTERVAL,
  
  links_clicked JSONB DEFAULT '{}',
  
  created_at TIMESTAMPTZ DEFAULT now(),
  last_calculated TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- TABLE 8: newsletter_seo_scores
-- Purpose: Store SEO optimization scores for newsletter content
-- ============================================================================
CREATE TABLE IF NOT EXISTS newsletter_seo_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scheduled_send_id UUID NOT NULL REFERENCES newsletter_scheduled_sends(id) ON DELETE CASCADE,
  
  h1_present BOOLEAN DEFAULT false,
  h1_text TEXT,
  
  keyword_density NUMERIC,
  primary_keyword TEXT,
  keyword_count INTEGER DEFAULT 0,
  
  readability_score NUMERIC CHECK (readability_score >= 0 AND readability_score <= 100),
  readability_grade TEXT,
  
  word_count INTEGER,
  sentence_count INTEGER,
  average_sentence_length NUMERIC,
  
  has_meta_description BOOLEAN DEFAULT false,
  meta_description TEXT,
  meta_description_length INTEGER,
  
  has_internal_links BOOLEAN DEFAULT false,
  internal_link_count INTEGER DEFAULT 0,
  
  has_external_links BOOLEAN DEFAULT false,
  external_link_count INTEGER DEFAULT 0,
  
  image_count INTEGER DEFAULT 0,
  image_alt_text_count INTEGER DEFAULT 0,
  
  overall_seo_score NUMERIC CHECK (overall_seo_score >= 0 AND overall_seo_score <= 100),
  
  recommendations JSONB DEFAULT '[]',
  
  analyzed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- ============================================================================
-- RLS POLICIES
-- ============================================================================

-- Enable RLS on all tables
ALTER TABLE newsletter_brokers_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_sections ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_local_content ENABLE ROW LEVEL SECURITY;
ALTER TABLE local_news_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_scheduled_sends ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_send_tracking ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_performance_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE newsletter_seo_scores ENABLE ROW LEVEL SECURITY;

-- POLICY: Users see only templates from their brokerage
CREATE POLICY "Users view templates from own brokerage" ON newsletter_brokers_templates
  FOR SELECT
  USING (
    brokerage_id = (
      SELECT brokerage_id FROM users WHERE id = auth.uid()
    )
  );

-- POLICY: Brokers can create templates in their brokerage
CREATE POLICY "Users create templates in own brokerage" ON newsletter_brokers_templates
  FOR INSERT
  WITH CHECK (
    brokerage_id = (
      SELECT brokerage_id FROM users WHERE id = auth.uid()
    )
  );

-- POLICY: Users can update templates in their brokerage
CREATE POLICY "Users update templates in own brokerage" ON newsletter_brokers_templates
  FOR UPDATE
  USING (
    brokerage_id = (
      SELECT brokerage_id FROM users WHERE id = auth.uid()
    )
  );

-- POLICY: Users can delete templates in their brokerage
CREATE POLICY "Users delete templates in own brokerage" ON newsletter_brokers_templates
  FOR DELETE
  USING (
    brokerage_id = (
      SELECT brokerage_id FROM users WHERE id = auth.uid()
    )
  );

-- POLICY: Sections inherit template visibility
CREATE POLICY "View sections from own templates" ON newsletter_sections
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM newsletter_brokers_templates nbt
      WHERE nbt.id = newsletter_sections.newsletter_template_id
      AND nbt.brokerage_id = (
        SELECT brokerage_id FROM users WHERE id = auth.uid()
      )
    )
  );

-- POLICY: Users can insert sections for their templates
CREATE POLICY "Insert sections for own templates" ON newsletter_sections
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM newsletter_brokers_templates nbt
      WHERE nbt.id = newsletter_sections.newsletter_template_id
      AND nbt.brokerage_id = (
        SELECT brokerage_id FROM users WHERE id = auth.uid()
      )
    )
  );

-- POLICY: Users can update sections for their templates
CREATE POLICY "Update sections for own templates" ON newsletter_sections
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM newsletter_brokers_templates nbt
      WHERE nbt.id = newsletter_sections.newsletter_template_id
      AND nbt.brokerage_id = (
        SELECT brokerage_id FROM users WHERE id = auth.uid()
      )
    )
  );

-- POLICY: Users can delete sections for their templates
CREATE POLICY "Delete sections for own templates" ON newsletter_sections
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM newsletter_brokers_templates nbt
      WHERE nbt.id = newsletter_sections.newsletter_template_id
      AND nbt.brokerage_id = (
        SELECT brokerage_id FROM users WHERE id = auth.uid()
      )
    )
  );

-- POLICY: Local content visible to brokerage
CREATE POLICY "View local content from own brokerage" ON newsletter_local_content
  FOR SELECT
  USING (
    brokerage_id = (
      SELECT brokerage_id FROM users WHERE id = auth.uid()
    )
  );

-- POLICY: Insert local content to own brokerage
CREATE POLICY "Insert local content to own brokerage" ON newsletter_local_content
  FOR INSERT
  WITH CHECK (
    brokerage_id = (
      SELECT brokerage_id FROM users WHERE id = auth.uid()
    )
  );

-- POLICY: Update local content in own brokerage
CREATE POLICY "Update local content in own brokerage" ON newsletter_local_content
  FOR UPDATE
  USING (
    brokerage_id = (
      SELECT brokerage_id FROM users WHERE id = auth.uid()
    )
  );

-- POLICY: Delete local content in own brokerage
CREATE POLICY "Delete local content in own brokerage" ON newsletter_local_content
  FOR DELETE
  USING (
    brokerage_id = (
      SELECT brokerage_id FROM users WHERE id = auth.uid()
    )
  );

-- POLICY: News sources visible to brokerage
CREATE POLICY "View news sources from own brokerage" ON local_news_sources
  FOR SELECT
  USING (
    brokerage_id = (
      SELECT brokerage_id FROM users WHERE id = auth.uid()
    )
  );

-- POLICY: Insert news sources to own brokerage
CREATE POLICY "Insert news sources to own brokerage" ON local_news_sources
  FOR INSERT
  WITH CHECK (
    brokerage_id = (
      SELECT brokerage_id FROM users WHERE id = auth.uid()
    )
  );

-- POLICY: Update news sources in own brokerage
CREATE POLICY "Update news sources in own brokerage" ON local_news_sources
  FOR UPDATE
  USING (
    brokerage_id = (
      SELECT brokerage_id FROM users WHERE id = auth.uid()
    )
  );

-- POLICY: Delete news sources in own brokerage
CREATE POLICY "Delete news sources in own brokerage" ON local_news_sources
  FOR DELETE
  USING (
    brokerage_id = (
      SELECT brokerage_id FROM users WHERE id = auth.uid()
    )
  );

-- POLICY: Scheduled sends visible to user's brokerage
CREATE POLICY "View scheduled sends from own brokerage" ON newsletter_scheduled_sends
  FOR SELECT
  USING (
    brokerage_id = (
      SELECT brokerage_id FROM users WHERE id = auth.uid()
    )
  );

-- POLICY: Insert scheduled sends to own brokerage
CREATE POLICY "Insert scheduled sends to own brokerage" ON newsletter_scheduled_sends
  FOR INSERT
  WITH CHECK (
    brokerage_id = (
      SELECT brokerage_id FROM users WHERE id = auth.uid()
    )
  );

-- POLICY: Update scheduled sends in own brokerage
CREATE POLICY "Update scheduled sends in own brokerage" ON newsletter_scheduled_sends
  FOR UPDATE
  USING (
    brokerage_id = (
      SELECT brokerage_id FROM users WHERE id = auth.uid()
    )
  );

-- POLICY: Delete scheduled sends in own brokerage
CREATE POLICY "Delete scheduled sends in own brokerage" ON newsletter_scheduled_sends
  FOR DELETE
  USING (
    brokerage_id = (
      SELECT brokerage_id FROM users WHERE id = auth.uid()
    )
  );

-- POLICY: Send tracking visible if can view scheduled send
CREATE POLICY "View send tracking from own brokerage" ON newsletter_send_tracking
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM newsletter_scheduled_sends nss
      WHERE nss.id = newsletter_send_tracking.scheduled_send_id
      AND nss.brokerage_id = (
        SELECT brokerage_id FROM users WHERE id = auth.uid()
      )
    )
  );

-- POLICY: Insert send tracking for own scheduled sends
CREATE POLICY "Insert send tracking for own scheduled sends" ON newsletter_send_tracking
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM newsletter_scheduled_sends nss
      WHERE nss.id = newsletter_send_tracking.scheduled_send_id
      AND nss.brokerage_id = (
        SELECT brokerage_id FROM users WHERE id = auth.uid()
      )
    )
  );

-- POLICY: Update send tracking for own scheduled sends
CREATE POLICY "Update send tracking for own scheduled sends" ON newsletter_send_tracking
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM newsletter_scheduled_sends nss
      WHERE nss.id = newsletter_send_tracking.scheduled_send_id
      AND nss.brokerage_id = (
        SELECT brokerage_id FROM users WHERE id = auth.uid()
      )
    )
  );

-- POLICY: Analytics visible if can view scheduled send
CREATE POLICY "View analytics from own brokerage" ON newsletter_performance_analytics
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM newsletter_scheduled_sends nss
      WHERE nss.id = newsletter_performance_analytics.scheduled_send_id
      AND nss.brokerage_id = (
        SELECT brokerage_id FROM users WHERE id = auth.uid()
      )
    )
  );

-- POLICY: Insert analytics for own scheduled sends
CREATE POLICY "Insert analytics for own scheduled sends" ON newsletter_performance_analytics
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM newsletter_scheduled_sends nss
      WHERE nss.id = newsletter_performance_analytics.scheduled_send_id
      AND nss.brokerage_id = (
        SELECT brokerage_id FROM users WHERE id = auth.uid()
      )
    )
  );

-- POLICY: Update analytics for own scheduled sends
CREATE POLICY "Update analytics for own scheduled sends" ON newsletter_performance_analytics
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM newsletter_scheduled_sends nss
      WHERE nss.id = newsletter_performance_analytics.scheduled_send_id
      AND nss.brokerage_id = (
        SELECT brokerage_id FROM users WHERE id = auth.uid()
      )
    )
  );

-- POLICY: SEO scores visible if can view scheduled send
CREATE POLICY "View seo scores from own brokerage" ON newsletter_seo_scores
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM newsletter_scheduled_sends nss
      WHERE nss.id = newsletter_seo_scores.scheduled_send_id
      AND nss.brokerage_id = (
        SELECT brokerage_id FROM users WHERE id = auth.uid()
      )
    )
  );

-- POLICY: Insert SEO scores for own scheduled sends
CREATE POLICY "Insert seo scores for own scheduled sends" ON newsletter_seo_scores
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM newsletter_scheduled_sends nss
      WHERE nss.id = newsletter_seo_scores.scheduled_send_id
      AND nss.brokerage_id = (
        SELECT brokerage_id FROM users WHERE id = auth.uid()
      )
    )
  );

-- POLICY: Update SEO scores for own scheduled sends
CREATE POLICY "Update seo scores for own scheduled sends" ON newsletter_seo_scores
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM newsletter_scheduled_sends nss
      WHERE nss.id = newsletter_seo_scores.scheduled_send_id
      AND nss.brokerage_id = (
        SELECT brokerage_id FROM users WHERE id = auth.uid()
      )
    )
  );

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_newsletter_templates_brokerage ON newsletter_brokers_templates(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_newsletter_templates_status ON newsletter_brokers_templates(approval_status);
CREATE INDEX IF NOT EXISTS idx_newsletter_templates_created_by ON newsletter_brokers_templates(created_by);
CREATE INDEX IF NOT EXISTS idx_newsletter_templates_is_default ON newsletter_brokers_templates(is_default);

CREATE INDEX IF NOT EXISTS idx_newsletter_sections_template ON newsletter_sections(newsletter_template_id);
CREATE INDEX IF NOT EXISTS idx_newsletter_sections_type ON newsletter_sections(section_type);

CREATE INDEX IF NOT EXISTS idx_local_content_brokerage ON newsletter_local_content(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_local_content_zip ON newsletter_local_content(zip_code);
CREATE INDEX IF NOT EXISTS idx_local_content_featured ON newsletter_local_content(is_featured);

CREATE INDEX IF NOT EXISTS idx_news_sources_brokerage ON local_news_sources(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_news_sources_enabled ON local_news_sources(enabled);

CREATE INDEX IF NOT EXISTS idx_scheduled_sends_brokerage ON newsletter_scheduled_sends(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_scheduled_sends_status ON newsletter_scheduled_sends(send_status);
CREATE INDEX IF NOT EXISTS idx_scheduled_sends_send_time ON newsletter_scheduled_sends(scheduled_send_time);
CREATE INDEX IF NOT EXISTS idx_scheduled_sends_agent ON newsletter_scheduled_sends(agent_id);

CREATE INDEX IF NOT EXISTS idx_send_tracking_scheduled ON newsletter_send_tracking(scheduled_send_id);
CREATE INDEX IF NOT EXISTS idx_send_tracking_contact ON newsletter_send_tracking(contact_id);
CREATE INDEX IF NOT EXISTS idx_send_tracking_status ON newsletter_send_tracking(send_status);
CREATE INDEX IF NOT EXISTS idx_send_tracking_opened ON newsletter_send_tracking(opened);
CREATE INDEX IF NOT EXISTS idx_send_tracking_clicked ON newsletter_send_tracking(clicked);

CREATE INDEX IF NOT EXISTS idx_analytics_scheduled ON newsletter_performance_analytics(scheduled_send_id);

CREATE INDEX IF NOT EXISTS idx_seo_scheduled ON newsletter_seo_scores(scheduled_send_id);

-- ============================================================================
-- TRIGGERS FOR UPDATED_AT TIMESTAMPS
-- ============================================================================

-- Trigger function to update updated_at column
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Apply trigger to tables with updated_at
CREATE TRIGGER update_newsletter_brokers_templates_updated_at BEFORE UPDATE ON newsletter_brokers_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_local_news_sources_updated_at BEFORE UPDATE ON local_news_sources
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_newsletter_send_tracking_updated_at BEFORE UPDATE ON newsletter_send_tracking
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Success message
SELECT 'Newsletter system schema created successfully' as status;
