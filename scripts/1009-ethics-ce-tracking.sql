-- Migration 1009: Ethics + Continuing Education tracking for agents.
-- License expiry already tracked in agents.license_expiry; this layer adds
-- NAR-style ethics + state-mandated CE hour tracking that runs alongside.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS ethics_completed_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ethics_due_date            DATE,
  ADD COLUMN IF NOT EXISTS ce_hours_required          INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ce_hours_completed         NUMERIC(6,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ce_cycle_end_date          DATE;

CREATE INDEX IF NOT EXISTS idx_agents_ethics_due_date  ON agents(ethics_due_date);
CREATE INDEX IF NOT EXISTS idx_agents_ce_cycle_end     ON agents(ce_cycle_end_date);

-- CE log: each course/credit the agent completes
CREATE TABLE IF NOT EXISTS agent_ce_completions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  brokerage_id    UUID REFERENCES brokerages(id) ON DELETE SET NULL,
  course_name     TEXT NOT NULL,
  provider        TEXT,
  category        TEXT
                  CHECK (category IN ('ethics','core','elective','fair_housing','other')),
  hours           NUMERIC(6,2) NOT NULL,
  completed_on    DATE NOT NULL,
  certificate_url TEXT,
  notes           TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_agent_ce_completions_agent ON agent_ce_completions(agent_id);
CREATE INDEX IF NOT EXISTS idx_agent_ce_completions_category ON agent_ce_completions(category);
ALTER TABLE agent_ce_completions ENABLE ROW LEVEL SECURITY;
