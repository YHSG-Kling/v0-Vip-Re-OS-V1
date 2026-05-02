-- Property matches cache table.
-- ai-property-matching.ts:171 upserts AI-generated matches per (contact, property)
-- so the buyer portal can read pre-computed scores without re-running the model
-- on every page load.

CREATE TABLE IF NOT EXISTS property_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id uuid REFERENCES contacts(id) ON DELETE CASCADE,
  property_id uuid,
  brokerage_id uuid REFERENCES brokerages(id),
  match_score integer CHECK (match_score BETWEEN 0 AND 100),
  match_reasons text[],
  priority_factors jsonb,
  potential_concerns text[],
  recommended_actions text[],
  ai_generated boolean DEFAULT true,
  generated_at timestamptz DEFAULT now(),
  user_feedback text,
  created_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_property_matches_contact_property
  ON property_matches(contact_id, property_id);
CREATE INDEX IF NOT EXISTS idx_property_matches_contact ON property_matches(contact_id);
CREATE INDEX IF NOT EXISTS idx_property_matches_score ON property_matches(match_score DESC);

ALTER TABLE property_matches ENABLE ROW LEVEL SECURITY;
