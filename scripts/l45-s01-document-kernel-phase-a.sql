-- l45-s01 · DOCUMENT KERNEL PHASE A (applied live 2026-07-11 via MCP)
-- Per-field extraction ledger + green/amber/red policy decisions +
-- document-derived deadline provenance on transaction_deadlines.

-- (1) Per-field extraction ledger: every field the scanner pulls out of a
--     document becomes an auditable row with its own confidence + provenance.
CREATE TABLE IF NOT EXISTS document_field_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id uuid NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  field_key text NOT NULL,
  field_value_json jsonb NOT NULL,
  confidence text NOT NULL CHECK (confidence IN ('high','medium','low')),
  extraction_model text,
  verified_by_user_id uuid,
  verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, field_key)
);
CREATE INDEX IF NOT EXISTS idx_dfe_brokerage ON document_field_extractions(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_dfe_document ON document_field_extractions(document_id);

-- (2) Policy decisions: the green/amber/red ledger every gated document
--     action records BEFORE acting (green = auto, amber = human gate, red = stop).
CREATE TABLE IF NOT EXISTS policy_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id uuid NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  transaction_id uuid,
  document_id uuid REFERENCES documents(id) ON DELETE CASCADE,
  target_type text NOT NULL,
  target_id text,
  decision text NOT NULL CHECK (decision IN ('green','amber','red')),
  reasons_json jsonb NOT NULL DEFAULT '[]'::jsonb,
  evidence_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  recommended_action text,
  required_approver_role text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_pd_brokerage ON policy_decisions(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_pd_document ON policy_decisions(document_id);
CREATE INDEX IF NOT EXISTS idx_pd_transaction ON policy_decisions(transaction_id);

-- (3) Deadline provenance: a document-derived deadline must point back at
--     the document + field it came from.
ALTER TABLE transaction_deadlines ADD COLUMN IF NOT EXISTS source_document_id uuid REFERENCES documents(id) ON DELETE SET NULL;
ALTER TABLE transaction_deadlines ADD COLUMN IF NOT EXISTS source_field_key text;

-- (4) RLS: tenant read (ledgers are kernel-written via service role)
CREATE POLICY dfe_tenant_select ON document_field_extractions FOR SELECT
  USING (brokerage_id = current_user_brokerage_id());
CREATE POLICY pd_tenant_select ON policy_decisions FOR SELECT
  USING (brokerage_id = current_user_brokerage_id());
