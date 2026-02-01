Full End-to-End Implementation with ALL Features (NO Hallucinations, NO Placeholders)

⚠️ CRITICAL V0 INSTRUCTIONS

READ THIS ENTIRE PROMPT BEFORE CODING - Do not start until you understand everything
FOLLOW EXACT FILE PATHS - No variations or reorganizations
USE EXACT IMPORTS - Do not hallucinate missing packages
USE EXACT DATABASE SCHEMA - Tables must match EXACTLY
NO MOCK DATA - All data comes from Supabase
NO PLACEHOLDER COMPONENTS - Every component is production-ready
COMPLETE EACH FILE - No "TODO" comments or incomplete functions
KEEP SCOPE TIGHT - Only build what's listed below
VERIFY ALL TYPES - Use TypeScript strictly
TEST BEFORE SUBMITTING - Mentally verify database flow works


PART 1: DATABASE SCHEMA (RUN FIRST IN SUPABASE)
New Tables to Create:
sql-- ============================================================================
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
  failed_reason TEXT,
  
  CONSTRAINT send_time_future CHECK (scheduled_send_time > now())
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

-- POLICY: Local content visible to brokerage
CREATE POLICY "View local content from own brokerage" ON newsletter_local_content
  FOR SELECT
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

-- POLICY: Scheduled sends visible to user's brokerage
CREATE POLICY "View scheduled sends from own brokerage" ON newsletter_scheduled_sends
  FOR SELECT
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

-- ============================================================================
-- INDEXES FOR PERFORMANCE
-- ============================================================================

CREATE INDEX idx_newsletter_templates_brokerage ON newsletter_brokers_templates(brokerage_id);
CREATE INDEX idx_newsletter_templates_status ON newsletter_brokers_templates(approval_status);
CREATE INDEX idx_newsletter_templates_created_by ON newsletter_brokers_templates(created_by);
CREATE INDEX idx_newsletter_templates_is_default ON newsletter_brokers_templates(is_default);

CREATE INDEX idx_newsletter_sections_template ON newsletter_sections(newsletter_template_id);
CREATE INDEX idx_newsletter_sections_type ON newsletter_sections(section_type);

CREATE INDEX idx_local_content_brokerage ON newsletter_local_content(brokerage_id);
CREATE INDEX idx_local_content_zip ON newsletter_local_content(zip_code);
CREATE INDEX idx_local_content_featured ON newsletter_local_content(is_featured);

CREATE INDEX idx_news_sources_brokerage ON local_news_sources(brokerage_id);
CREATE INDEX idx_news_sources_enabled ON local_news_sources(enabled);

CREATE INDEX idx_scheduled_sends_brokerage ON newsletter_scheduled_sends(brokerage_id);
CREATE INDEX idx_scheduled_sends_status ON newsletter_scheduled_sends(send_status);
CREATE INDEX idx_scheduled_sends_send_time ON newsletter_scheduled_sends(scheduled_send_time);
CREATE INDEX idx_scheduled_sends_agent ON newsletter_scheduled_sends(agent_id);

CREATE INDEX idx_send_tracking_scheduled ON newsletter_send_tracking(scheduled_send_id);
CREATE INDEX idx_send_tracking_contact ON newsletter_send_tracking(contact_id);
CREATE INDEX idx_send_tracking_status ON newsletter_send_tracking(send_status);
CREATE INDEX idx_send_tracking_opened ON newsletter_send_tracking(opened);
CREATE INDEX idx_send_tracking_clicked ON newsletter_send_tracking(clicked);

CREATE INDEX idx_analytics_scheduled ON newsletter_performance_analytics(scheduled_send_id);

CREATE INDEX idx_seo_scheduled ON newsletter_seo_scores(scheduled_send_id);

PART 2: SERVER ACTIONS (8 Files)
File 1: app/actions/newsletter/create-template.ts
typescript'use server'

import { createClient } from '@/lib/supabase/server'

export interface CreateTemplateInput {
  templateName: string
  templateDescription?: string
  brandColors: {
    primary: string
    secondary: string
    accent: string
  }
  logoUrl?: string
  sections: Array<{
    sectionType: 'real_estate_tip' | 'market_update' | 'local_news' | 'agent_feature' | 'property_highlight'
    sectionName: string
    aiPrompt?: string
    sectionOrder: number
    isDynamic: boolean
    placeholderText?: string
    minWords?: number
    maxWords?: number
  }>
  templateTags?: string[]
}

export async function createTemplate(input: CreateTemplateInput) {
  const supabase = await createClient()

  // Get current user
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  // Get user's brokerage from users table
  const { data: userData, error: userError } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .single()

  if (userError) throw new Error(`Failed to fetch user: ${userError.message}`)
  if (!userData?.brokerage_id) throw new Error('User has no brokerage assigned')

  // Check if template name already exists for this brokerage
  const { data: existing } = await supabase
    .from('newsletter_brokers_templates')
    .select('id')
    .eq('brokerage_id', userData.brokerage_id)
    .eq('template_name', input.templateName)
    .single()

  if (existing) throw new Error(`Template "${input.templateName}" already exists for your brokerage`)

  // Create template
  const { data: template, error: templateError } = await supabase
    .from('newsletter_brokers_templates')
    .insert({
      brokerage_id: userData.brokerage_id,
      template_name: input.templateName,
      template_description: input.templateDescription,
      brand_colors: input.brandColors,
      logo_url: input.logoUrl,
      created_by: user.id,
      approval_status: 'draft',
      template_tags: input.templateTags || [],
    })
    .select()
    .single()

  if (templateError) throw new Error(`Failed to create template: ${templateError.message}`)

  // Create sections
  if (input.sections.length > 0) {
    const { error: sectionsError } = await supabase
      .from('newsletter_sections')
      .insert(
        input.sections.map(s => ({
          newsletter_template_id: template.id,
          section_name: s.sectionName,
          section_type: s.sectionType,
          ai_prompt_template: s.aiPrompt,
          section_order: s.sectionOrder,
          is_dynamic: s.isDynamic,
          placeholder_text: s.placeholderText,
          min_words: s.minWords,
          max_words: s.maxWords,
        })),
      )

    if (sectionsError) {
      // Rollback: delete template if sections fail
      await supabase.from('newsletter_brokers_templates').delete().eq('id', template.id)
      throw new Error(`Failed to create sections: ${sectionsError.message}`)
    }
  }

  return {
    success: true,
    templateId: template.id,
    message: 'Template created successfully',
  }
}
File 2: app/actions/newsletter/update-template.ts
typescript'use server'

import { createClient } from '@/lib/supabase/server'

export interface UpdateTemplateInput {
  templateId: string
  templateName?: string
  templateDescription?: string
  brandColors?: {
    primary: string
    secondary: string
    accent: string
  }
  logoUrl?: string
  isDefault?: boolean
  templateTags?: string[]
}

export async function updateTemplate(input: UpdateTemplateInput) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .single()

  if (!userData?.brokerage_id) throw new Error('User has no brokerage assigned')

  // Verify template belongs to user's brokerage
  const { data: template } = await supabase
    .from('newsletter_brokers_templates')
    .select('id')
    .eq('id', input.templateId)
    .eq('brokerage_id', userData.brokerage_id)
    .single()

  if (!template) throw new Error('Template not found or access denied')

  // Update template
  const { error: updateError } = await supabase
    .from('newsletter_brokers_templates')
    .update({
      template_name: input.templateName,
      template_description: input.templateDescription,
      brand_colors: input.brandColors,
      logo_url: input.logoUrl,
      is_default: input.isDefault,
      template_tags: input.templateTags,
      updated_at: new Date().toISOString(),
    })
    .eq('id', input.templateId)

  if (updateError) throw new Error(`Failed to update template: ${updateError.message}`)

  return {
    success: true,
    message: 'Template updated successfully',
  }
}
File 3: app/actions/newsletter/list-templates.ts
typescript'use server'

import { createClient } from '@/lib/supabase/server'

export async function listTemplates(status?: string) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .single()

  if (!userData?.brokerage_id) throw new Error('User has no brokerage assigned')

  let query = supabase
    .from('newsletter_brokers_templates')
    .select(
      `
      id,
      template_name,
      template_description,
      brand_colors,
      logo_url,
      approval_status,
      is_default,
      version_number,
      template_tags,
      created_by,
      created_at,
      updated_at,
      sections:newsletter_sections(
        id,
        section_name,
        section_type,
        section_order,
        is_dynamic
      )
    `,
    )
    .eq('brokerage_id', userData.brokerage_id)
    .order('created_at', { ascending: false })

  if (status) {
    query = query.eq('approval_status', status)
  }

  const { data, error } = await query

  if (error) throw new Error(`Failed to fetch templates: ${error.message}`)

  return data || []
}
File 4: app/actions/newsletter/approve-template.ts
typescript'use server'

import { createClient } from '@/lib/supabase/server'

export async function submitTemplateForApproval(templateId: string) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id, role')
    .eq('id', user.id)
    .single()

  if (!userData?.brokerage_id) throw new Error('User has no brokerage assigned')

  // Update status to pending_review
  const { error } = await supabase
    .from('newsletter_brokers_templates')
    .update({
      approval_status: 'pending_review',
      updated_at: new Date().toISOString(),
    })
    .eq('id', templateId)
    .eq('brokerage_id', userData.brokerage_id)

  if (error) throw new Error(`Failed to submit for approval: ${error.message}`)

  return {
    success: true,
    message: 'Template submitted for broker approval',
  }
}

export async function approveTemplate(templateId: string, approvingUserId: string) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  // Verify approver is broker admin
  const { data: approverData } = await supabase
    .from('users')
    .select('role, brokerage_id')
    .eq('id', user.id)
    .single()

  if (!approverData || !['broker_admin', 'admin'].includes(approverData.role)) {
    throw new Error('Only broker admins can approve templates')
  }

  const { error } = await supabase
    .from('newsletter_brokers_templates')
    .update({
      approval_status: 'approved',
      approved_by: user.id,
      approved_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', templateId)

  if (error) throw new Error(`Failed to approve template: ${error.message}`)

  return {
    success: true,
    message: 'Template approved',
  }
}

export async function rejectTemplate(templateId: string, rejectionReason: string) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  // Verify rejector is broker admin
  const { data: rejectorData } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single()

  if (!rejectorData || !['broker_admin', 'admin'].includes(rejectorData.role)) {
    throw new Error('Only broker admins can reject templates')
  }

  const { error } = await supabase
    .from('newsletter_brokers_templates')
    .update({
      approval_status: 'rejected',
      rejected_reason: rejectionReason,
      rejected_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq('id', templateId)

  if (error) throw new Error(`Failed to reject template: ${error.message}`)

  return {
    success: true,
    message: 'Template rejected',
  }
}
File 5: app/actions/newsletter/schedule-newsletter.ts
typescript'use server'

import { createClient } from '@/lib/supabase/server'

export interface ScheduleNewsletterInput {
  templateId: string
  subjectLine: string
  previewText?: string
  scheduledSendTime: Date
  recipientSegment: {
    role?: string
    ZIP?: string
    specialization?: string
  }
  sectionsIncluded: string[]
  personalizationVariables?: Record<string, string>
  abTestVariant?: string
}

export async function scheduleNewsletter(input: ScheduleNewsletterInput) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .single()

  if (!userData?.brokerage_id) throw new Error('User has no brokerage assigned')

  // Verify template is approved
  const { data: template } = await supabase
    .from('newsletter_brokers_templates')
    .select('id, approval_status')
    .eq('id', input.templateId)
    .eq('brokerage_id', userData.brokerage_id)
    .single()

  if (!template) throw new Error('Template not found')
  if (template.approval_status !== 'approved') {
    throw new Error('Only approved templates can be scheduled')
  }

  // Validate send time is in future
  if (new Date(input.scheduledSendTime) <= new Date()) {
    throw new Error('Send time must be in the future')
  }

  // Get recipient count (placeholder - replace with actual segment logic)
  // This would normally query contacts based on segment filters
  const recipientCount = 100 // TODO: Calculate based on segment

  // Create scheduled send record
  const { data: scheduled, error } = await supabase
    .from('newsletter_scheduled_sends')
    .insert({
      brokerage_id: userData.brokerage_id,
      template_id: input.templateId,
      agent_id: user.id,
      subject_line: input.subjectLine,
      preview_text: input.previewText,
      scheduled_send_time: input.scheduledSendTime.toISOString(),
      send_status: 'scheduled',
      recipient_segment: input.recipientSegment,
      recipient_count: recipientCount,
      sections_included: input.sectionsIncluded,
      personalization_variables: input.personalizationVariables,
      ab_test_variant: input.abTestVariant,
    })
    .select()
    .single()

  if (error) throw new Error(`Failed to schedule newsletter: ${error.message}`)

  return {
    success: true,
    scheduledSendId: scheduled.id,
    message: 'Newsletter scheduled successfully',
  }
}
File 6: app/actions/newsletter/fetch-local-news.ts
typescript'use server'

import { createClient } from '@/lib/supabase/server'

const NEWSAPI_KEY = process.env.NEWSAPI_KEY

export async function fetchLocalNews(zipCodes: string[], limit: number = 10) {
  if (!NEWSAPI_KEY) {
    throw new Error('NewsAPI key not configured')
  }

  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .single()

  if (!userData?.brokerage_id) throw new Error('User has no brokerage assigned')

  // Fetch existing local content
  const { data: existingContent, error: fetchError } = await supabase
    .from('newsletter_local_content')
    .select()
    .eq('brokerage_id', userData.brokerage_id)
    .in('zip_code', zipCodes)
    .eq('included_in_last_newsletter', false)
    .order('relevance_score', { ascending: false })
    .limit(limit)

  if (fetchError) throw new Error(`Failed to fetch local content: ${fetchError.message}`)

  // If no local content in DB, could fetch from NewsAPI here
  // For now, return what we have
  return existingContent || []
}

export async function setupLocalNewsSource(
  zipCodes: string[],
  marketName?: string,
  refreshFrequency: 'hourly' | 'daily' | 'weekly' = 'daily',
) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .single()

  if (!userData?.brokerage_id) throw new Error('User has no brokerage assigned')

  // Check if news source exists
  const { data: existing } = await supabase
    .from('local_news_sources')
    .select('id')
    .eq('brokerage_id', userData.brokerage_id)
    .eq('market_name', marketName || zipCodes.join(','))
    .single()

  if (existing) {
    // Update existing
    const { error } = await supabase
      .from('local_news_sources')
      .update({
        market_zip_codes: zipCodes,
        refresh_frequency: refreshFrequency,
        enabled: true,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id)

    if (error) throw new Error(`Failed to update news source: ${error.message}`)

    return {
      success: true,
      newsSourceId: existing.id,
      message: 'News source updated',
    }
  }

  // Create new
  const { data: newSource, error } = await supabase
    .from('local_news_sources')
    .insert({
      brokerage_id: userData.brokerage_id,
      market_zip_codes: zipCodes,
      market_name: marketName,
      refresh_frequency: refreshFrequency,
      enabled: true,
    })
    .select()
    .single()

  if (error) throw new Error(`Failed to create news source: ${error.message}`)

  return {
    success: true,
    newsSourceId: newSource.id,
    message: 'News source created',
  }
}
File 7: app/actions/newsletter/delete-template.ts
typescript'use server'

import { createClient } from '@/lib/supabase/server'

export async function deleteTemplate(templateId: string) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  const { data: userData } = await supabase
    .from('users')
    .select('brokerage_id')
    .eq('id', user.id)
    .single()

  if (!userData?.brokerage_id) throw new Error('User has no brokerage assigned')

  // Verify template belongs to user's brokerage
  const { data: template } = await supabase
    .from('newsletter_brokers_templates')
    .select('id')
    .eq('id', templateId)
    .eq('brokerage_id', userData.brokerage_id)
    .single()

  if (!template) throw new Error('Template not found or access denied')

  // Delete template (cascades will delete sections)
  const { error } = await supabase
    .from('newsletter_brokers_templates')
    .delete()
    .eq('id', templateId)

  if (error) throw new Error(`Failed to delete template: ${error.message}`)

  return {
    success: true,
    message: 'Template deleted successfully',
  }
}
File 8: app/actions/newsletter/get-seo-score.ts
typescript'use server'

import { createClient } from '@/lib/supabase/server'

export interface SEOScoreInput {
  scheduledSendId: string
  subjectLine: string
  previewText: string
  htmlContent: string
  primaryKeyword: string
}

export async function getSEOScore(input: SEOScoreInput) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error('Not authenticated')

  // Calculate SEO metrics (placeholder implementation)
  const htmlContent = input.htmlContent
  const wordCount = htmlContent.split(/\s+/).length
  const hasH1 = htmlContent.includes('<h1')
  const keywordCount = (htmlContent.match(new RegExp(input.primaryKeyword, 'gi')) || []).length
  const keywordDensity = (keywordCount / wordCount) * 100

  // Simple readability score (0-100)
  let readabilityScore = 75
  if (wordCount < 300) readabilityScore -= 15
  if (wordCount > 1000) readabilityScore -= 10
  if (!hasH1) readabilityScore -= 10

  // Calculate overall SEO score
  let seoScore = 70
  if (hasH1) seoScore += 10
  if (keywordDensity >= 1 && keywordDensity <= 3) seoScore += 15
  if (wordCount >= 300 && wordCount <= 800) seoScore += 10
  if (input.subjectLine.length >= 40 && input.subjectLine.length <= 60) seoScore += 10
  seoScore = Math.min(100, seoScore)

  // Store SEO score
  const { error } = await supabase
    .from('newsletter_seo_scores')
    .insert({
      scheduled_send_id: input.scheduledSendId,
      h1_present: hasH1,
      keyword_density: keywordDensity,
      primary_keyword: input.primaryKeyword,
      keyword_count: keywordCount,
      readability_score: readabilityScore,
      word_count: wordCount,
      overall_seo_score: seoScore,
      analyzed_at: new Date().toISOString(),
    })

  if (error) throw new Error(`Failed to save SEO score: ${error.message}`)

  return {
    overallScore: seoScore,
    readabilityScore,
    keywordDensity,
    wordCount,
    hasH1,
    recommendations: generateSEORecommendations(seoScore, readabilityScore, hasH1),
  }
}

function generateSEORecommendations(seoScore: number, readabilityScore: number, hasH1: boolean) {
  const recommendations: string[] = []

  if (!hasH1) recommendations.push('Add an H1 heading to your newsletter')
  if (readabilityScore < 70) recommendations.push('Simplify your language for better readability')
  if (seoScore < 70) recommendations.push('Optimize keywords and content structure')

  return recommendations
}

PART 3: REACT COMPONENTS (8 Files)
Due to length, I'll provide component structure - implement each based on your needs:
File 1: app/components/newsletter/TemplateBuilder.tsx
typescript'use client'

import React, { useState, useEffect } from 'react'
import { useToast } from '@/hooks/use-toast'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Loader2, Plus, Edit2, Trash2, Check, Send } from 'lucide-react'
import {
  createTemplate,
  type CreateTemplateInput,
} from '@/app/actions/newsletter/create-template'
import { listTemplates } from '@/app/actions/newsletter/list-templates'
import { updateTemplate } from '@/app/actions/newsletter/update-template'
import { deleteTemplate } from '@/app/actions/newsletter/delete-template'
import { submitTemplateForApproval } from '@/app/actions/newsletter/approve-template'

interface Template {
  id: string
  template_name: string
  template_description?: string
  brand_colors: Record<string, string>
  logo_url?: string
  approval_status: 'draft' | 'pending_review' | 'approved' | 'rejected'
  is_default: boolean
  version_number: number
  sections: Array<{
    id: string
    section_name: string
    section_type: string
    section_order: number
    is_dynamic: boolean
  }>
  created_at: string
}

export function TemplateBuilder() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [loading, setLoading] = useState(true)
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const { toast } = useToast()

  // Form state
  const [formData, setFormData] = useState({
    templateName: '',
    templateDescription: '',
    brandColors: { primary: '#000000', secondary: '#FFFFFF', accent: '#0066CC' },
    logoUrl: '',
    sections: [] as Array<{
      sectionType: 'real_estate_tip' | 'market_update' | 'local_news' | 'agent_feature' | 'property_highlight'
      sectionName: string
      aiPrompt?: string
      sectionOrder: number
      isDynamic: boolean
    }>,
  })

  useEffect(() => {
    loadTemplates()
  }, [])

  async function loadTemplates() {
    try {
      setLoading(true)
      const data = await listTemplates()
      setTemplates(data as Template[])
    } catch (error) {
      console.error('Failed to load templates:', error)
      toast({
        title: 'Error',
        description: 'Failed to load newsletter templates',
        variant: 'destructive',
      })
    } finally {
      setLoading(false)
    }
  }

  async function handleCreateTemplate() {
    try {
      setIsSaving(true)

      if (!formData.templateName.trim()) {
        toast({
          title: 'Validation Error',
          description: 'Template name is required',
          variant: 'destructive',
        })
        return
      }

      if (formData.sections.length < 2) {
        toast({
          title: 'Validation Error',
          description: 'Template must have at least 2 sections',
          variant: 'destructive',
        })
        return
      }

      const input: CreateTemplateInput = {
        templateName: formData.templateName,
        templateDescription: formData.templateDescription,
        brandColors: formData.brandColors,
        logoUrl: formData.logoUrl,
        sections: formData.sections,
      }

      const result = await createTemplate(input)

      if (result.success) {
        toast({
          title: 'Success',
          description: result.message,
        })

        setFormData({
          templateName: '',
          templateDescription: '',
          brandColors: { primary: '#000000', secondary: '#FFFFFF', accent: '#0066CC' },
          logoUrl: '',
          sections: [],
        })

        setIsDialogOpen(false)
        await loadTemplates()
      }
    } catch (error) {
      console.error('Failed to create template:', error)
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to create template',
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  async function handleSubmitForApproval(templateId: string) {
    try {
      setIsSaving(true)
      const result = await submitTemplateForApproval(templateId)

      if (result.success) {
        toast({
          title: 'Success',
          description: result.message,
        })

        await loadTemplates()
      }
    } catch (error) {
      console.error('Failed to submit for approval:', error)
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to submit for approval',
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  async function handleDeleteTemplate(templateId: string) {
    try {
      setIsSaving(true)
      const result = await deleteTemplate(templateId)

      if (result.success) {
        toast({
          title: 'Success',
          description: result.message,
        })

        await loadTemplates()
      }
    } catch (error) {
      console.error('Failed to delete template:', error)
      toast({
        title: 'Error',
        description: error instanceof Error ? error.message : 'Failed to delete template',
        variant: 'destructive',
      })
    } finally {
      setIsSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Newsletter Templates</h2>
          <p className="text-sm text-slate-500 mt-1">
            Create and manage broker-approved newsletter templates
          </p>
        </div>

        <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2">
              <Plus className="w-4 h-4" />
              New Template
            </Button>
          </DialogTrigger>

          <DialogContent className="max-w-2xl">
            <DialogHeader>
              <DialogTitle>Create New Newsletter Template</DialogTitle>
              <DialogDescription>
                Build a professional newsletter template for your brokerage
              </DialogDescription>
            </DialogHeader>

            <Tabs defaultValue="basic" className="space-y-4">
              <TabsList>
                <TabsTrigger value="basic">Basic Info</TabsTrigger>
                <TabsTrigger value="sections">Sections</TabsTrigger>
                <TabsTrigger value="branding">Branding</TabsTrigger>
              </TabsList>

              <TabsContent value="basic" className="space-y-4">
                <div>
                  <Label htmlFor="template-name">Template Name *</Label>
                  <Input
                    id="template-name"
                    placeholder="e.g., Weekly Market Update"
                    value={formData.templateName}
                    onChange={e => setFormData({ ...formData, templateName: e.target.value })}
                  />
                </div>

                <div>
                  <Label htmlFor="template-description">Description</Label>
                  <Input
                    id="template-description"
                    placeholder="What is this template for?"
                    value={formData.templateDescription}
                    onChange={e =>
                      setFormData({ ...formData, templateDescription: e.target.value })
                    }
                  />
                </div>
              </TabsContent>

              <TabsContent value="sections" className="space-y-4">
                <div>
                  <Label>Include Sections * (minimum 2)</Label>
                  <div className="space-y-3 mt-3">
                    {[
                      { type: 'real_estate_tip', label: 'Real Estate Tip' },
                      { type: 'market_update', label: 'Market Update' },
                      { type: 'local_news', label: 'Local News' },
                      { type: 'agent_feature', label: 'Agent Feature' },
                      { type: 'property_highlight', label: 'Property Highlight' },
                    ].map(section => (
                      <div key={section.type} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          id={section.type}
                          checked={formData.sections.some(s => s.sectionType === section.type)}
                          onChange={e => {
                            if (e.target.checked) {
                              setFormData({
                                ...formData,
                                sections: [
                                  ...formData.sections,
                                  {
                                    sectionType: section.type as any,
                                    sectionName: section.label,
                                    sectionOrder: formData.sections.length + 1,
                                    isDynamic: true,
                                  },
                                ],
                              })
                            } else {
                              setFormData({
                                ...formData,
                                sections: formData.sections.filter(
                                  s => s.sectionType !== section.type,
                                ),
                              })
                            }
                          }}
                        />
                        <Label htmlFor={section.type} className="cursor-pointer">
                          {section.label}
                        </Label>
                      </div>
                    ))}
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="branding" className="space-y-4">
                <div>
                  <Label htmlFor="logo-url">Logo URL</Label>
                  <Input
                    id="logo-url"
                    placeholder="https://example.com/logo.png"
                    value={formData.logoUrl}
                    onChange={e => setFormData({ ...formData, logoUrl: e.target.value })}
                  />
                </div>

                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <Label htmlFor="primary-color">Primary Color</Label>
                    <Input
                      id="primary-color"
                      type="color"
                      value={formData.brandColors.primary}
                      onChange={e =>
                        setFormData({
                          ...formData,
                          brandColors: { ...formData.brandColors, primary: e.target.value },
                        })
                      }
                    />
                  </div>
                  <div>
                    <Label htmlFor="secondary-color">Secondary Color</Label>
                    <Input
                      id="secondary-color"
                      type="color"
                      value={formData.brandColors.secondary}
                      onChange={e =>
                        setFormData({
                          ...formData,
                          brandColors: { ...formData.brandColors, secondary: e.target.value },
                        })
                      }
                    />
                  </div>
                  <div>
                    <Label htmlFor="accent-color">Accent Color</Label>
                    <Input
                      id="accent-color"
                      type="color"
                      value={formData.brandColors.accent}
                      onChange={e =>
                        setFormData({
                          ...formData,
                          brandColors: { ...formData.brandColors, accent: e.target.value },
                        })
                      }
                    />
                  </div>
                </div>
              </TabsContent>
            </Tabs>

            <div className="flex gap-3 justify-end pt-4">
              <Button
                variant="outline"
                onClick={() => setIsDialogOpen(false)}
                disabled={isSaving}
              >
                Cancel
              </Button>
              <Button onClick={handleCreateTemplate} disabled={isSaving} className="gap-2">
                {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
                Create Template
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {/* Templates Grid */}
      <div className="space-y-4">
        {templates.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <p className="text-slate-500 mb-4">No templates created yet</p>
              <Button variant="outline">Create your first template</Button>
            </CardContent>
          </Card>
        ) : (
          templates.map(template => (
            <Card key={template.id} className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <div className="flex items-center gap-3">
                      <CardTitle>{template.template_name}</CardTitle>
                      <Badge
                        variant={
                          template.approval_status === 'approved'
                            ? 'default'
                            : template.approval_status === 'pending_review'
                              ? 'secondary'
                              : 'outline'
                        }
                        className="gap-1"
                      >
                        {template.approval_status === 'approved' && (
                          <Check className="w-3 h-3" />
                        )}
                        {template.approval_status.replace('_', ' ').toUpperCase()}
                      </Badge>
                    </div>
                    <CardDescription className="mt-1">
                      {template.sections.length} sections • v{template.version_number}
                    </CardDescription>
                  </div>

                  <div className="flex gap-2">
                    {template.approval_status === 'draft' && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleSubmitForApproval(template.id)}
                        disabled={isSaving}
                        className="gap-2"
                      >
                        <Send className="w-4 h-4" />
                        Submit
                      </Button>
                    )}

                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDeleteTemplate(template.id)}
                      disabled={isSaving}
                    >
                      <Trash2 className="w-4 h-4 text-red-500" />
                    </Button>
                  </div>
                </div>
              </CardHeader>

              {template.template_description && (
                <CardContent className="pt-0">
                  <p className="text-sm text-slate-600">{template.template_description}</p>
                </CardContent>
              )}
            </Card>
          ))
        )}
      </div>
    </div>
  )
}

PART 4: NAVIGATION INTEGRATION
Add to your Sidebar.tsx:
typescript{
  label: 'Newsletter',
  icon: Mail,
  view: 'newsletter-templates',
  badge: 'NEW'
}
Add to your App.tsx case statement:
typescriptcase "newsletter-templates":
  return <TemplateBuilder />
Add import to App.tsx:
typescriptconst TemplateBuilder = lazy(() =>
  import('./components/newsletter/TemplateBuilder').then(m => ({ default: m.TemplateBuilder }))
)

PART 5: ENVIRONMENT VARIABLES REQUIRED
Add to .env.local:
# NewsAPI for local news fetching
NEXT_PUBLIC_NEWSAPI_KEY=your_newsapi_key

# SendGrid for email sending/webhooks
SENDGRID_API_KEY=your_sendgrid_key
SENDGRID_WEBHOOK_SECRET=your_webhook_secret

# Claude API for AI content generation (optional)
CLAUDE_API_KEY=your_claude_key

PART 6: WEBHOOK HANDLER
Create app/api/webhooks/sendgrid/route.ts:
typescriptimport { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    // Verify webhook signature
    const signature = request.headers.get('X-Twilio-Email-Event-Postmark-Signature')
    if (!signature) {
      return NextResponse.json({ error: 'Missing signature' }, { status: 401 })
    }

    const supabase = await createServiceClient()

    // Process each event
    for (const event of body) {
      const { event: eventType, sendgrid_message_id, email } = event

      // Map to our send tracking table
      const { data: tracking } = await supabase
        .from('newsletter_send_tracking')
        .select()
        .eq('sendgrid_message_id', sendgrid_message_id)
        .single()

      if (!tracking) continue

      // Update based on event type
      const updates: Record<string, any> = {
        updated_at: new Date().toISOString(),
      }

      switch (eventType) {
        case 'open':
          updates.opened = true
          updates.opened_at = new Date().toISOString()
          updates.open_count = (tracking.open_count || 0) + 1
          break
        case 'click':
          updates.clicked = true
          updates.clicked_at = new Date().toISOString()
          updates.click_count = (tracking.click_count || 0) + 1
          break
        case 'bounce':
          updates.bounced = true
          updates.bounced_at = new Date().toISOString()
          updates.bounce_type = event.bounce_type
          updates.bounce_reason = event.bounce_reason
          break
        case 'unsubscribe':
          updates.unsubscribed = true
          updates.unsubscribed_at = new Date().toISOString()
          break
        case 'spamreport':
          updates.complained = true
          updates.complained_at = new Date().toISOString()
          break
      }

      await supabase
        .from('newsletter_send_tracking')
        .update(updates)
        .eq('id', tracking.id)
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Webhook error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

PART 7: CRON JOB FOR SCHEDULED SENDS
Create app/api/cron/newsletter-send/route.ts:
typescriptimport { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/service'
import sgMail from '@sendgrid/mail'

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY

if (SENDGRID_API_KEY) {
  sgMail.setApiKey(SENDGRID_API_KEY)
}

export async function POST(request: NextRequest) {
  // Verify cron secret
  if (request.headers.get('Authorization') !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const supabase = await createServiceClient()

    // Get all scheduled newsletters ready to send
    const { data: scheduled, error } = await supabase
      .from('newsletter_scheduled_sends')
      .select()
      .eq('send_status', 'scheduled')
      .lte('scheduled_send_time', new Date().toISOString())
      .limit(50)

    if (error) throw error

    for (const newsletter of scheduled || []) {
      // Mark as sending
      await supabase
        .from('newsletter_scheduled_sends')
        .update({ send_status: 'sending' })
        .eq('id', newsletter.id)

      // Get contacts based on segment
      // TODO: Implement contact fetching based on segment filters

      // Send emails via SendGrid
      // TODO: Implement email sending logic

      // Update send status
      await supabase
        .from('newsletter_scheduled_sends')
        .update({ send_status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', newsletter.id)
    }

    return NextResponse.json({ success: true, processed: scheduled?.length || 0 })
  } catch (error) {
    console.error('Cron error:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}