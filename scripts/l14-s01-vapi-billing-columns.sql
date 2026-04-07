-- l14-s01: VAPI billing & ISA intent columns
-- Extends existing vapi_voice_calls for superadmin tier billing
-- Extends call_analyses for ISA intent/suggestion intelligence

-- vapi_voice_calls: add billing + scope columns
ALTER TABLE vapi_voice_calls
  ADD COLUMN IF NOT EXISTS duration_seconds integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS minutes_billed   numeric(10,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_per_minute_cents integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS team_id   uuid REFERENCES teams(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS agent_id  uuid REFERENCES agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tier_name text DEFAULT 'starter';

-- call_analyses: add ISA intent columns
ALTER TABLE call_analyses
  ADD COLUMN IF NOT EXISTS intent_primary   text,
  ADD COLUMN IF NOT EXISTS intent_secondary text,
  ADD COLUMN IF NOT EXISTS intent_signals   jsonb DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS urgency_score    integer DEFAULT 0,
  ADD COLUMN IF NOT EXISTS suggested_next_action text,
  ADD COLUMN IF NOT EXISTS agent_id  uuid REFERENCES agents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS contact_id uuid REFERENCES contacts(id) ON DELETE SET NULL;

-- Index for superadmin billing roll-up queries
CREATE INDEX IF NOT EXISTS idx_vapi_voice_calls_brokerage_created
  ON vapi_voice_calls(brokerage_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_vapi_voice_calls_team
  ON vapi_voice_calls(team_id, created_at DESC);
