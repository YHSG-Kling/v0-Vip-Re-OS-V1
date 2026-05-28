-- =====================================================
-- MIGRATION 015: Contact Portal Preferences
-- =====================================================
-- Agents and brokers can configure which transaction milestones
-- are visible to each contact in their client portal, and which
-- portal modules (journey, messages, documents) are enabled.
-- =====================================================

CREATE TABLE IF NOT EXISTS contact_portal_preferences (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id   UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  brokerage_id UUID NOT NULL REFERENCES brokerages(id),
  -- { "milestone_name": true/false } — overrides the default is_client_visible flag
  milestone_overrides       JSONB    NOT NULL DEFAULT '{}',
  portal_modules_enabled    TEXT[]   NOT NULL DEFAULT ARRAY['journey','messages','documents'],
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (contact_id)
);

ALTER TABLE contact_portal_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "agent_manage_portal_prefs"
  ON contact_portal_preferences FOR ALL
  USING (brokerage_id = auth.user_brokerage_id());

CREATE OR REPLACE FUNCTION update_contact_portal_prefs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_contact_portal_prefs_updated_at ON contact_portal_preferences;
CREATE TRIGGER trg_contact_portal_prefs_updated_at
  BEFORE UPDATE ON contact_portal_preferences
  FOR EACH ROW EXECUTE FUNCTION update_contact_portal_prefs_updated_at();
