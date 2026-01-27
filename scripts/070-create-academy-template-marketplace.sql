-- =====================================================
-- Academy & Template Marketplace Migration
-- =====================================================

-- Create enum types
DO $$ BEGIN
  CREATE TYPE academy_content_type AS ENUM ('sop', 'playbook_breakdown', 'loom_link', 'case_study');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE template_visibility AS ENUM ('global', 'brokerage_only', 'private');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE feedback_type AS ENUM ('comment', 'upvote', 'request_variation');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- =====================================================
-- 1. ACADEMY CONTENT TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS academy_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Content details
  title TEXT NOT NULL,
  type academy_content_type NOT NULL,
  related_playbook_id UUID REFERENCES playbooks(id) ON DELETE SET NULL,
  
  -- Content body
  body TEXT,  -- Markdown supported
  video_url TEXT,
  
  -- Organization
  tags TEXT[] DEFAULT ARRAY[]::TEXT[],
  
  -- Engagement metrics
  view_count INTEGER DEFAULT 0,
  
  -- Publishing
  is_published BOOLEAN DEFAULT false,
  
  -- Ownership
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  
  -- Audit fields
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Indexes for academy_content
CREATE INDEX IF NOT EXISTS idx_academy_content_type ON academy_content(type);
CREATE INDEX IF NOT EXISTS idx_academy_content_playbook ON academy_content(related_playbook_id);
CREATE INDEX IF NOT EXISTS idx_academy_content_published ON academy_content(is_published);
CREATE INDEX IF NOT EXISTS idx_academy_content_creator ON academy_content(created_by);
CREATE INDEX IF NOT EXISTS idx_academy_content_tags ON academy_content USING gin(tags);
CREATE INDEX IF NOT EXISTS idx_academy_content_created ON academy_content(created_at DESC);

-- RLS for academy_content
ALTER TABLE academy_content ENABLE ROW LEVEL SECURITY;

-- Published content is visible to all authenticated users
CREATE POLICY "Published content visible to all" ON academy_content
  FOR SELECT
  USING (is_published = true);

-- Drafts only visible to creator and admins/brokers
CREATE POLICY "Drafts visible to creator and admins" ON academy_content
  FOR SELECT
  USING (
    is_published = false AND (
      created_by = auth.uid()
      OR EXISTS (
        SELECT 1 FROM users 
        WHERE users.id = auth.uid() 
        AND users.user_type IN ('admin', 'broker')
      )
    )
  );

-- Creators can insert their own content
CREATE POLICY "Users can create academy content" ON academy_content
  FOR INSERT
  WITH CHECK (created_by = auth.uid());

-- Creators and admins can update content
CREATE POLICY "Creators and admins can update content" ON academy_content
  FOR UPDATE
  USING (
    created_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM users 
      WHERE users.id = auth.uid() 
      AND users.user_type IN ('admin', 'broker')
    )
  );

-- Admins can delete content
CREATE POLICY "Admins can delete content" ON academy_content
  FOR DELETE
  USING (
    EXISTS (
      SELECT 1 FROM users 
      WHERE users.id = auth.uid() 
      AND users.user_type IN ('admin', 'broker')
    )
  );

COMMENT ON TABLE academy_content IS 'Academy content including SOPs, playbook breakdowns, tutorials, and case studies';

-- =====================================================
-- 2. TEMPLATE MARKETPLACE TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS template_marketplace (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Source playbook
  source_playbook_id UUID NOT NULL REFERENCES playbooks(id) ON DELETE CASCADE,
  
  -- Template details
  name TEXT NOT NULL,
  description TEXT,
  
  -- Visibility and access
  visibility template_visibility NOT NULL DEFAULT 'brokerage_only',
  
  -- Branding configuration
  branding_placeholders JSONB DEFAULT '{}'::jsonb,
  -- Example: { "logo_url": "", "primary_color": "#000", "secondary_color": "#fff", "from_name": "", "phone": "" }
  
  -- Engagement metrics
  clone_count INTEGER DEFAULT 0,
  rating NUMERIC(3,2) CHECK (rating >= 1.0 AND rating <= 5.0),
  
  -- Done-with-you service
  supports_done_with_you BOOLEAN DEFAULT false,
  
  -- Ownership
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  
  -- Audit fields
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

-- Indexes for template_marketplace
CREATE INDEX IF NOT EXISTS idx_template_marketplace_playbook ON template_marketplace(source_playbook_id);
CREATE INDEX IF NOT EXISTS idx_template_marketplace_visibility ON template_marketplace(visibility);
CREATE INDEX IF NOT EXISTS idx_template_marketplace_rating ON template_marketplace(rating DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_template_marketplace_creator ON template_marketplace(created_by);
CREATE INDEX IF NOT EXISTS idx_template_marketplace_created ON template_marketplace(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_template_marketplace_clone_count ON template_marketplace(clone_count DESC);

-- RLS for template_marketplace
ALTER TABLE template_marketplace ENABLE ROW LEVEL SECURITY;

-- Global templates visible to all
CREATE POLICY "Global templates visible to all" ON template_marketplace
  FOR SELECT
  USING (visibility = 'global');

-- Brokerage templates visible to same brokerage
CREATE POLICY "Brokerage templates visible to same brokerage" ON template_marketplace
  FOR SELECT
  USING (
    visibility = 'brokerage_only' AND (
      created_by IN (
        SELECT id FROM users 
        WHERE brokerage = (
          SELECT brokerage FROM users WHERE id = auth.uid()
        )
      )
    )
  );

-- Private templates only visible to creator
CREATE POLICY "Private templates visible to creator" ON template_marketplace
  FOR SELECT
  USING (
    visibility = 'private' AND created_by = auth.uid()
  );

-- Users can create templates from their playbooks
CREATE POLICY "Users can create templates" ON template_marketplace
  FOR INSERT
  WITH CHECK (
    created_by = auth.uid() AND
    EXISTS (
      SELECT 1 FROM playbooks 
      WHERE playbooks.id = source_playbook_id
    )
  );

-- Creators and admins can update templates
CREATE POLICY "Creators and admins can update templates" ON template_marketplace
  FOR UPDATE
  USING (
    created_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM users 
      WHERE users.id = auth.uid() 
      AND users.user_type IN ('admin', 'broker')
    )
  );

-- Creators and admins can delete templates
CREATE POLICY "Creators and admins can delete templates" ON template_marketplace
  FOR DELETE
  USING (
    created_by = auth.uid()
    OR EXISTS (
      SELECT 1 FROM users 
      WHERE users.id = auth.uid() 
      AND users.user_type IN ('admin', 'broker')
    )
  );

COMMENT ON TABLE template_marketplace IS 'Marketplace for shareable automation playbook templates';

-- =====================================================
-- 3. TEMPLATE FEEDBACK TABLE
-- =====================================================

CREATE TABLE IF NOT EXISTS template_feedback (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Template reference
  template_id UUID NOT NULL REFERENCES template_marketplace(id) ON DELETE CASCADE,
  
  -- User reference
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  -- Feedback details
  feedback_type feedback_type NOT NULL,
  comment TEXT,
  
  -- Audit field
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now(),
  
  -- Ensure one upvote per user per template
  UNIQUE(template_id, user_id, feedback_type)
);

-- Indexes for template_feedback
CREATE INDEX IF NOT EXISTS idx_template_feedback_template ON template_feedback(template_id);
CREATE INDEX IF NOT EXISTS idx_template_feedback_user ON template_feedback(user_id);
CREATE INDEX IF NOT EXISTS idx_template_feedback_type ON template_feedback(feedback_type);
CREATE INDEX IF NOT EXISTS idx_template_feedback_created ON template_feedback(created_at DESC);

-- RLS for template_feedback
ALTER TABLE template_feedback ENABLE ROW LEVEL SECURITY;

-- Users can view all feedback on templates they can access
CREATE POLICY "Users can view feedback on accessible templates" ON template_feedback
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM template_marketplace
      WHERE template_marketplace.id = template_id
      AND (
        visibility = 'global'
        OR (visibility = 'brokerage_only' AND created_by IN (
          SELECT id FROM users 
          WHERE brokerage = (SELECT brokerage FROM users WHERE id = auth.uid())
        ))
        OR (visibility = 'private' AND created_by = auth.uid())
      )
    )
  );

-- Users can create feedback
CREATE POLICY "Users can create feedback" ON template_feedback
  FOR INSERT
  WITH CHECK (user_id = auth.uid());

-- Users can update their own feedback
CREATE POLICY "Users can update their own feedback" ON template_feedback
  FOR UPDATE
  USING (user_id = auth.uid());

-- Users can delete their own feedback
CREATE POLICY "Users can delete their own feedback" ON template_feedback
  FOR DELETE
  USING (user_id = auth.uid());

COMMENT ON TABLE template_feedback IS 'User feedback, ratings, and comments on marketplace templates';

-- =====================================================
-- TRIGGERS FOR UPDATED_AT
-- =====================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_academy_content_updated_at
  BEFORE UPDATE ON academy_content
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_template_marketplace_updated_at
  BEFORE UPDATE ON template_marketplace
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- SEED DATA
-- =====================================================

-- Seed default academy content (example SOPs)
INSERT INTO academy_content (title, type, body, is_published, tags) VALUES
(
  'How to Create Your First Playbook',
  'sop',
  '# Creating Your First Playbook

## Step 1: Define Your Trigger
Choose when the playbook should activate (e.g., new lead, appointment scheduled).

## Step 2: Configure Audience
Set filters to target specific contact types, timelines, or statuses.

## Step 3: Select Your AI Agent
Choose which AI agent will execute the playbook actions.

## Step 4: Define Actions
Configure the workflow steps: send SMS, schedule calls, update statuses.

## Step 5: Set KPI Targets
Define success metrics to track playbook performance.',
  true,
  ARRAY['playbook', 'getting-started', 'automation']
),
(
  'Understanding Contact Personas',
  'case_study',
  '# Contact Personas: A Guide

Understanding your contact personas is crucial for effective targeting.

## First-Time Buyer
- Timeline: Often immediate to 30 days
- Needs: Education, guidance, hand-holding
- Communication: Regular check-ins, educational content

## Luxury Buyer
- Timeline: 90+ days typically
- Needs: Privacy, exclusive properties, white-glove service
- Communication: High-touch, personalized outreach

## Investor
- Timeline: Varies widely
- Needs: ROI analysis, market data, portfolio strategy
- Communication: Data-driven, analytical approach',
  true,
  ARRAY['personas', 'targeting', 'strategy']
);

COMMENT ON COLUMN academy_content.body IS 'Markdown-formatted content body';
COMMENT ON COLUMN template_marketplace.branding_placeholders IS 'JSONB object with logo_url, colors, from_name, phone placeholders';
