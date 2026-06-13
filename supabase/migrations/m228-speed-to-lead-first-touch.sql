-- m228-speed-to-lead-first-touch.sql
-- Add first_touched_at + first_touch_channel to leads + contacts.
-- Partial indexes on brokerage_id WHERE first_touched_at IS NULL for fast
-- "needs first touch" scans without a seq-scan across fully-touched records.
-- Idempotent: ADD COLUMN IF NOT EXISTS throughout.

ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS first_touched_at   timestamptz,
  ADD COLUMN IF NOT EXISTS first_touch_channel text;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS first_touched_at   timestamptz,
  ADD COLUMN IF NOT EXISTS first_touch_channel text;

-- Partial index: leads that still need a first touch (fast sweep in runSpeedToLead)
CREATE INDEX IF NOT EXISTS idx_leads_needs_first_touch
  ON leads (brokerage_id)
  WHERE first_touched_at IS NULL;

-- Partial index: contacts that still need a first touch
CREATE INDEX IF NOT EXISTS idx_contacts_needs_first_touch
  ON contacts (brokerage_id)
  WHERE first_touched_at IS NULL;
