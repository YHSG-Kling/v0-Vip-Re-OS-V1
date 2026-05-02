-- property_views table
-- Used by app/actions/ai-property-matching.ts:82 which selects:
--   property_id, view_count, last_viewed_at, time_spent_seconds, contact_id
-- The other property-matching tables (property_preferences, property_alerts, listings)
-- already exist in the live DB.

CREATE TABLE IF NOT EXISTS property_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE,
  brokerage_id uuid REFERENCES brokerages(id),
  property_id uuid,
  view_count int DEFAULT 1,
  first_viewed_at timestamptz DEFAULT now(),
  last_viewed_at timestamptz DEFAULT now(),
  time_spent_seconds int DEFAULT 0,
  source text -- portal | email | agent_share | search
);

CREATE INDEX IF NOT EXISTS idx_property_views_contact ON property_views(contact_id);
CREATE INDEX IF NOT EXISTS idx_property_views_property ON property_views(property_id);
CREATE INDEX IF NOT EXISTS idx_property_views_last_viewed ON property_views(last_viewed_at DESC);

ALTER TABLE property_views ENABLE ROW LEVEL SECURITY;
