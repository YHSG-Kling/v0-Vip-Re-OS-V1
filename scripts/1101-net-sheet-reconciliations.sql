-- 1101: net_sheet_reconciliations — the audit + idempotency ledger for the NET-SHEET
-- SURPRISE GUARD. The system ESTIMATES a seller net sheet (offers.seller_net_estimate) but
-- never reconciled it against the FINAL settlement statement / Closing Disclosure, so a
-- material gap between the promised net and the actual net went uncaught. Each row records
-- one reconciliation of a deal's settlement vs its estimate (variance, per-line deltas,
-- surprise level, whether it was escalated). Additive, decoupled (no FK to offers/txns to
-- stay drop-safe), tenant-scoped. Applied live via Supabase MCP migration
-- `create_net_sheet_reconciliations`.

CREATE TABLE IF NOT EXISTS net_sheet_reconciliations (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id         uuid        NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  transaction_id       uuid,
  offer_id             uuid,
  estimated_net        numeric,
  actual_net           numeric,
  variance_amount      numeric,
  variance_pct         numeric,
  surprise_level       text        NOT NULL,
  line_item_deltas     jsonb,
  settlement_signature text,
  escalated            boolean     NOT NULL DEFAULT false,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nsr_brokerage   ON net_sheet_reconciliations(brokerage_id, created_at);
CREATE INDEX IF NOT EXISTS idx_nsr_transaction ON net_sheet_reconciliations(transaction_id, created_at);

ALTER TABLE net_sheet_reconciliations ENABLE ROW LEVEL SECURITY;
CREATE POLICY net_sheet_reconciliations_service ON net_sheet_reconciliations FOR ALL TO service_role USING (true) WITH CHECK (true);
