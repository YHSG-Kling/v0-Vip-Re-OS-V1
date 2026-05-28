-- Migration 1010: QuickBooks sync log table
--
-- Referenced by ai-financial-management.ts (getProviderConnectionStatus +
-- syncCommissionsToQuickbooks). Counterpart of the existing accounting_sync_log
-- generic adapter table — this one is QuickBooks-specific.

CREATE TABLE IF NOT EXISTS quickbooks_sync_log (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id      UUID NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  agent_id          UUID REFERENCES agents(id) ON DELETE SET NULL,
  sync_type         TEXT NOT NULL,
  direction         TEXT NOT NULL DEFAULT 'push'
                    CHECK (direction IN ('push','pull','bidirectional')),
  records_count     INTEGER NOT NULL DEFAULT 0,
  records_succeeded INTEGER NOT NULL DEFAULT 0,
  records_failed    INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'in_progress'
                    CHECK (status IN ('in_progress','completed','failed','partial')),
  qb_company_id     TEXT,
  qb_realm_id       TEXT,
  error_message     TEXT,
  payload_summary   JSONB DEFAULT '{}'::jsonb,
  started_at        TIMESTAMPTZ DEFAULT NOW(),
  completed_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_quickbooks_sync_log_brokerage ON quickbooks_sync_log(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_quickbooks_sync_log_status   ON quickbooks_sync_log(status);
CREATE INDEX IF NOT EXISTS idx_quickbooks_sync_log_started  ON quickbooks_sync_log(started_at DESC);

ALTER TABLE quickbooks_sync_log ENABLE ROW LEVEL SECURITY;
