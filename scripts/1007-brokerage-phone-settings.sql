-- Migration 1007: Brokerage-level phone + ISA voice settings

ALTER TABLE brokerages
  ADD COLUMN IF NOT EXISTS default_isa_voice_id TEXT,
  ADD COLUMN IF NOT EXISTS auto_provision_phone_numbers BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS twilio_subaccount_sid TEXT;

-- Audit log for phone provisioning events
CREATE TABLE IF NOT EXISTS phone_number_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  agent_id        UUID REFERENCES agents(id) ON DELETE SET NULL,
  phone_number    TEXT NOT NULL,
  event_type      TEXT NOT NULL CHECK (event_type IN ('purchased', 'manually_added', 'ported_in', 'released', 'failed')),
  source          TEXT,
  twilio_sid      TEXT,
  vapi_number_id  TEXT,
  cost_usd        NUMERIC(10,2),
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_phone_number_events_brokerage ON phone_number_events(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_phone_number_events_agent ON phone_number_events(agent_id);
ALTER TABLE phone_number_events ENABLE ROW LEVEL SECURITY;
