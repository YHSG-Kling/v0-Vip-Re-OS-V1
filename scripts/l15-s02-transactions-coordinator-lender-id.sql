-- Add coordinator_id to transactions (FK to transaction_coordinators)
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS coordinator_id UUID REFERENCES transaction_coordinators(id) ON DELETE SET NULL;

-- Add lender_id to transactions (FK to lender_portal_users)
ALTER TABLE transactions
  ADD COLUMN IF NOT EXISTS lender_id UUID REFERENCES lender_portal_users(id) ON DELETE SET NULL;

-- Index for coordinator lookup
CREATE INDEX IF NOT EXISTS idx_transactions_coordinator_id ON transactions(coordinator_id);

-- Index for lender lookup
CREATE INDEX IF NOT EXISTS idx_transactions_lender_id ON transactions(lender_id);

-- Backfill coordinator_id from transaction_assignments (primary assignment)
UPDATE transactions t
SET coordinator_id = ta.coordinator_id
FROM transaction_assignments ta
WHERE ta.transaction_id = t.id
  AND ta.is_primary = true
  AND t.coordinator_id IS NULL;
