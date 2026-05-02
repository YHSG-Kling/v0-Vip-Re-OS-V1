-- 999-add-closing-checklist-items.sql
-- Creates the closing_checklist_items table consumed by ai-closing-workflow.ts.

CREATE TABLE IF NOT EXISTS closing_checklist_items (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id  uuid REFERENCES transactions(id) ON DELETE CASCADE,
  brokerage_id    uuid REFERENCES brokerages(id),
  agent_user_id   uuid REFERENCES users(id),
  phase           text NOT NULL, -- pre_inspection | loan | title | final_walk | day_of_close
  item_label      text NOT NULL,
  owner           text NOT NULL, -- agent | lender | title | client
  due_date        date,
  completed       boolean DEFAULT false,
  completed_at    timestamptz,
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_closing_checklist_transaction
  ON closing_checklist_items(transaction_id);

CREATE INDEX IF NOT EXISTS idx_closing_checklist_brokerage
  ON closing_checklist_items(brokerage_id);

ALTER TABLE closing_checklist_items ENABLE ROW LEVEL SECURITY;

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_closing_checklist_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_closing_checklist_updated_at ON closing_checklist_items;
CREATE TRIGGER trg_closing_checklist_updated_at
  BEFORE UPDATE ON closing_checklist_items
  FOR EACH ROW EXECUTE FUNCTION update_closing_checklist_updated_at();
