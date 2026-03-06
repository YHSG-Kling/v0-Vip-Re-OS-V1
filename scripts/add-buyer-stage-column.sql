-- Migration: add contacts.buyer_stage column
-- Represents the 13-state buyer journey (distinct from contacts.status which tracks raw lead state)

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS buyer_stage text DEFAULT 'prospect';

-- Index for efficient querying by brokerage + buyer_stage
CREATE INDEX IF NOT EXISTS idx_contacts_buyer_stage
  ON contacts (brokerage_id, buyer_stage)
  WHERE buyer_stage IS NOT NULL;

COMMENT ON COLUMN contacts.buyer_stage IS
  '13-state buyer journey managed by buyer_lifecycle ENTITY_MAP in lib/kernel/lifecycle.ts. '
  'Distinct from contacts.status which tracks raw CRM lead/contact state.';
