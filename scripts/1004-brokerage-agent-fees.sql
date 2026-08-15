-- Migration 1004: Brokerage-charged agent fees
--
-- Brokerages charge their agents recurring (monthly desk fee, tech fee, E&O)
-- and one-time fees (training, supplies). Agent commissions still flow
-- through CDA at closing (title/closing-attorney pays out) — these are the
-- separate tech-stack-style charges the agent owes the brokerage.

-- 1. Fee TYPES — defined by brokerage, applied to agents
CREATE TABLE IF NOT EXISTS brokerage_fee_types (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,                            -- e.g. 'Tech Fee', 'Desk Fee', 'E&O'
  description     TEXT,
  amount          NUMERIC(10,2) NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'usd',
  cadence         TEXT NOT NULL DEFAULT 'monthly'
                  CHECK (cadence IN ('monthly','quarterly','annual','per_transaction','one_time')),
  applies_to      TEXT NOT NULL DEFAULT 'all_agents'
                  CHECK (applies_to IN ('all_agents','specific_agents','role','team')),
  applies_to_role TEXT,                                     -- when applies_to='role'
  applies_to_team UUID,                                     -- when applies_to='team'
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  start_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date        DATE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brokerage_fee_types_brokerage ON brokerage_fee_types(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_brokerage_fee_types_active   ON brokerage_fee_types(is_active);
ALTER TABLE brokerage_fee_types ENABLE ROW LEVEL SECURITY;

-- 2. Per-agent fee assignments (when applies_to='specific_agents')
CREATE TABLE IF NOT EXISTS agent_fee_assignments (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fee_type_id     UUID NOT NULL REFERENCES brokerage_fee_types(id) ON DELETE CASCADE,
  agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  brokerage_id    UUID NOT NULL REFERENCES brokerages(id),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  start_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  end_date        DATE,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(fee_type_id, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_agent_fee_assignments_agent ON agent_fee_assignments(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_fee_assignments_fee   ON agent_fee_assignments(fee_type_id);
ALTER TABLE agent_fee_assignments ENABLE ROW LEVEL SECURITY;

-- 3. Generated charges — one row per cycle for each (agent, fee_type)
CREATE TABLE IF NOT EXISTS agent_fee_charges (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id           UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  agent_id               UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  fee_type_id            UUID NOT NULL REFERENCES brokerage_fee_types(id),
  period_start           DATE NOT NULL,
  period_end             DATE,
  amount                 NUMERIC(10,2) NOT NULL,
  currency               TEXT NOT NULL DEFAULT 'usd',
  status                 TEXT NOT NULL DEFAULT 'open'
                         CHECK (status IN ('open','paid','overdue','waived','disputed')),
  due_date               DATE,
  paid_at                TIMESTAMPTZ,
  payment_method         TEXT,
  stripe_invoice_id      TEXT,
  stripe_payment_intent_id TEXT,
  notes                  TEXT,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(agent_id, fee_type_id, period_start)
);

CREATE INDEX IF NOT EXISTS idx_agent_fee_charges_agent  ON agent_fee_charges(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_fee_charges_status ON agent_fee_charges(status);
CREATE INDEX IF NOT EXISTS idx_agent_fee_charges_period ON agent_fee_charges(period_start);
ALTER TABLE agent_fee_charges ENABLE ROW LEVEL SECURITY;

-- 4. Stripe customer association on agents (for autopay)
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
  ADD COLUMN IF NOT EXISTS fees_autopay_enabled BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS default_payment_method_id TEXT;

-- 5. Trigger: brokerage_fee_types.updated_at
CREATE OR REPLACE FUNCTION update_brokerage_fee_types_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_brokerage_fee_types_updated_at ON brokerage_fee_types;
CREATE TRIGGER trg_brokerage_fee_types_updated_at
  BEFORE UPDATE ON brokerage_fee_types
  FOR EACH ROW EXECUTE FUNCTION update_brokerage_fee_types_updated_at();

DROP TRIGGER IF EXISTS trg_agent_fee_charges_updated_at ON agent_fee_charges;
CREATE TRIGGER trg_agent_fee_charges_updated_at
  BEFORE UPDATE ON agent_fee_charges
  FOR EACH ROW EXECUTE FUNCTION update_brokerage_fee_types_updated_at();
