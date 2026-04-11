-- ============================================================
-- MIGRATION: Create brokerage_forms table
-- KERNEL RULE: brokerage_forms = reusable form templates owned by brokerage.
--              client_documents = contact-owned signed docs ONLY.
-- ============================================================

CREATE TABLE IF NOT EXISTS brokerage_forms (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id  uuid NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  form_name     text NOT NULL,
  -- category: 'listing' | 'offer' | 'transaction' | 'disclosure' | 'addendum'
  form_category text NOT NULL,
  form_type     text,
  document_url  text,
  is_required   boolean NOT NULL DEFAULT false,
  -- state: two-letter state code for state-specific forms; NULL = applies to all states
  state         char(2),
  is_active     boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS brokerage_forms_brokerage_id_idx
  ON brokerage_forms(brokerage_id);

CREATE INDEX IF NOT EXISTS brokerage_forms_category_idx
  ON brokerage_forms(brokerage_id, form_category);

CREATE INDEX IF NOT EXISTS brokerage_forms_active_idx
  ON brokerage_forms(brokerage_id, is_active, form_category);

-- Row Level Security
ALTER TABLE brokerage_forms ENABLE ROW LEVEL SECURITY;

CREATE POLICY brokerage_forms_brokerage_isolation ON brokerage_forms
  FOR ALL
  USING (brokerage_id IN (
    SELECT brokerage_id FROM users WHERE id = auth.uid()
    UNION
    SELECT id FROM brokerages WHERE id = auth.uid()
  ));

-- ============================================================
-- Fix feature_flags seed: seo_blog_engine
-- The column is feature_key (not feature_name). Use ON CONFLICT DO NOTHING.
-- ============================================================
INSERT INTO feature_flags (
  feature_key, display_name, description, category,
  solo_agent_access, team_access, brokerage_access, multi_location_access,
  enabled, beta
)
VALUES (
  'seo_blog_engine',
  'SEO Blog Engine',
  'AI-powered blog post generation for SEO-optimized content',
  'marketing',
  true, true, true, true,
  true, false
)
ON CONFLICT (feature_key) DO NOTHING;
