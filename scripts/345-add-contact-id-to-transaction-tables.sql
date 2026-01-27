-- Add contact_id to transaction-related tables for easier client-scoped queries
-- This allows clients to see only their own transaction data

-- Ensure transactions has contact_id (for backward compatibility)
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES contacts(id);

-- Add contact_id to transaction_documents for direct client document access
ALTER TABLE transaction_documents ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES contacts(id);

-- Add contact_id to transaction_timeline for client activity visibility
ALTER TABLE transaction_timeline ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES contacts(id);

-- Add contact_id to transaction_deadlines for client deadline visibility  
ALTER TABLE transaction_deadlines ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES contacts(id);

-- Add contact_id to showing_requests for client showing history
ALTER TABLE showing_requests ADD COLUMN IF NOT EXISTS contact_id UUID REFERENCES contacts(id);

-- Create indexes for efficient contact-scoped queries
CREATE INDEX IF NOT EXISTS idx_transactions_contact ON transactions(contact_id);
CREATE INDEX IF NOT EXISTS idx_transaction_documents_contact ON transaction_documents(contact_id);
CREATE INDEX IF NOT EXISTS idx_transaction_timeline_contact ON transaction_timeline(contact_id);
CREATE INDEX IF NOT EXISTS idx_transaction_deadlines_contact ON transaction_deadlines(contact_id);
CREATE INDEX IF NOT EXISTS idx_showing_requests_contact ON showing_requests(contact_id);

-- Create a function to automatically set contact_id on transaction-related inserts
-- by looking up the transaction's contact_id
CREATE OR REPLACE FUNCTION set_contact_id_from_transaction()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.contact_id IS NULL AND NEW.transaction_id IS NOT NULL THEN
    SELECT contact_id INTO NEW.contact_id
    FROM transactions
    WHERE id = NEW.transaction_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to auto-set contact_id on transaction_documents
DROP TRIGGER IF EXISTS set_contact_id_transaction_documents ON transaction_documents;
CREATE TRIGGER set_contact_id_transaction_documents
  BEFORE INSERT ON transaction_documents
  FOR EACH ROW
  EXECUTE FUNCTION set_contact_id_from_transaction();

-- Apply trigger to auto-set contact_id on transaction_timeline
DROP TRIGGER IF EXISTS set_contact_id_transaction_timeline ON transaction_timeline;
CREATE TRIGGER set_contact_id_transaction_timeline
  BEFORE INSERT ON transaction_timeline
  FOR EACH ROW
  EXECUTE FUNCTION set_contact_id_from_transaction();

-- Apply trigger to auto-set contact_id on transaction_deadlines
DROP TRIGGER IF EXISTS set_contact_id_transaction_deadlines ON transaction_deadlines;
CREATE TRIGGER set_contact_id_transaction_deadlines
  BEFORE INSERT ON transaction_deadlines
  FOR EACH ROW
  EXECUTE FUNCTION set_contact_id_from_transaction();

-- Backfill existing records with contact_id from their transactions (only if transactions has contact_id populated)
UPDATE transaction_documents td
SET contact_id = t.contact_id
FROM transactions t
WHERE td.transaction_id = t.id
AND td.contact_id IS NULL
AND t.contact_id IS NOT NULL;

UPDATE transaction_timeline tt
SET contact_id = t.contact_id
FROM transactions t
WHERE tt.transaction_id = t.id
AND tt.contact_id IS NULL
AND t.contact_id IS NOT NULL;

UPDATE transaction_deadlines tdd
SET contact_id = t.contact_id
FROM transactions t
WHERE tdd.transaction_id = t.id
AND tdd.contact_id IS NULL
AND t.contact_id IS NOT NULL;
