-- l56-s01: THE SELF-HEALING LEDGER — unified append-only record of every
-- autonomous repair (data flows + connectors). Agentic-OS append-only
-- decision records; makes "the OS heals itself" visible + auditable.
CREATE TABLE IF NOT EXISTS self_heal_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id  uuid,
  domain        text NOT NULL CHECK (domain IN ('data_flow','connector')),
  subject       text NOT NULL,
  action        text NOT NULL,
  outcome       text NOT NULL CHECK (outcome IN ('healed','failed','escalated')),
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_self_heal_events_brokerage ON self_heal_events (brokerage_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_self_heal_events_domain ON self_heal_events (domain, outcome);
