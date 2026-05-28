-- Migration 1001: Workflow Orchestrator engine tables
-- Tracks multi-step chain runs and per-step status. Sits on top of the
-- existing lifecycle_events orchestrator. Chains are defined in code
-- (lib/workflow-orchestrator/chains/) — only INSTANCES live in DB.

CREATE TABLE IF NOT EXISTS workflow_runs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id        UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  chain_key           TEXT NOT NULL,           -- e.g. 'listing-appt-prep'
  trigger_event       TEXT,                    -- e.g. 'listing.appointment_set'
  trigger_event_id    UUID REFERENCES lifecycle_events(id) ON DELETE SET NULL,
  contact_id          UUID REFERENCES contacts(id) ON DELETE SET NULL,
  listing_id          UUID REFERENCES listings(id) ON DELETE SET NULL,
  transaction_id      UUID REFERENCES transactions(id) ON DELETE SET NULL,
  agent_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  status              TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running','paused','completed','failed','cancelled')),
  current_step_index  INT NOT NULL DEFAULT 0,
  metadata            JSONB DEFAULT '{}'::jsonb,
  step_outputs        JSONB DEFAULT '{}'::jsonb,  -- step_key → output
  started_at          TIMESTAMPTZ DEFAULT NOW(),
  completed_at        TIMESTAMPTZ,
  failed_at           TIMESTAMPTZ,
  error_message       TEXT,
  updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_runs_brokerage ON workflow_runs(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_status    ON workflow_runs(status);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_contact   ON workflow_runs(contact_id);
CREATE INDEX IF NOT EXISTS idx_workflow_runs_chain     ON workflow_runs(chain_key);

ALTER TABLE workflow_runs ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS workflow_run_steps (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id            UUID NOT NULL REFERENCES workflow_runs(id) ON DELETE CASCADE,
  step_index        INT NOT NULL,
  step_key          TEXT NOT NULL,
  step_label        TEXT,
  status            TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','running','done','failed','skipped','needs_approval')),
  output            JSONB,
  error_message     TEXT,
  attempt_count     INT NOT NULL DEFAULT 0,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  UNIQUE(run_id, step_index)
);

CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_run    ON workflow_run_steps(run_id);
CREATE INDEX IF NOT EXISTS idx_workflow_run_steps_status ON workflow_run_steps(status);

ALTER TABLE workflow_run_steps ENABLE ROW LEVEL SECURITY;

-- Trigger: workflow_runs.updated_at
CREATE OR REPLACE FUNCTION update_workflow_runs_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_workflow_runs_updated_at ON workflow_runs;
CREATE TRIGGER trg_workflow_runs_updated_at
  BEFORE UPDATE ON workflow_runs
  FOR EACH ROW EXECUTE FUNCTION update_workflow_runs_updated_at();
