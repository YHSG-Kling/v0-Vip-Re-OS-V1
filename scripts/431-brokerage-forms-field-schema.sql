-- scripts/431-brokerage-forms-field-schema.sql
-- Add field_schema JSONB column to brokerage_forms table.
-- This stores the ordered array of form fields with type, label, section, and
-- required metadata so TransactionFormEsignFlow can render real form fields
-- instead of a generic hardcoded list.
--
-- Field schema entry shape:
-- {
--   "key": "buyer_name",
--   "label": "Buyer Name",
--   "type": "text" | "email" | "phone" | "date" | "number" | "select" | "checkbox" | "textarea",
--   "section": "Transaction Parties",
--   "required": true,
--   "placeholder": "Full legal name",
--   "options": ["Option A", "Option B"]   -- for select type only
-- }

ALTER TABLE brokerage_forms
  ADD COLUMN IF NOT EXISTS field_schema JSONB NOT NULL DEFAULT '[]';

COMMENT ON COLUMN brokerage_forms.field_schema IS
  'Ordered array of form field definitions. Each entry: { key, label, type, section, required, placeholder?, options? }';
