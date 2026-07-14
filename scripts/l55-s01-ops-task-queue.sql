-- l55-s01: COMPUTER-USING OPS-TASK RAIL (shine #3) — governance spine only.
-- The browser-driving EXECUTION engine stays behind a per-brokerage capability
-- flag (ops_bot_execution_enabled, default OFF) until a Playwright runner +
-- secure credential vault are provisioned. Honest, not faked.
CREATE TABLE IF NOT EXISTS ops_task_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id   uuid NOT NULL,
  requested_by   uuid,
  task_type      text NOT NULL,
  target_system  text NOT NULL,
  instructions   text NOT NULL,
  guardrails     jsonb NOT NULL DEFAULT '{}'::jsonb,
  status         text NOT NULL DEFAULT 'queued'
                 CHECK (status IN ('queued','approved','running','succeeded','failed','blocked','cancelled')),
  approved_by    uuid,
  approved_at    timestamptz,
  result_summary text,
  audit_log      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ops_task_runs_brokerage_status ON ops_task_runs (brokerage_id, status);
ALTER TABLE brokerages ADD COLUMN IF NOT EXISTS ops_bot_execution_enabled boolean NOT NULL DEFAULT false;
