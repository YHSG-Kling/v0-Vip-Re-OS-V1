-- Migration: add AI ISA control columns to contacts
-- contacts.ai_outreach_paused  — gates AI outreach per contact (engage-contact.ts)
-- contacts.last_contacted_at   — drives stale/ghosted detection thresholds

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS ai_outreach_paused   boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_contacted_at    timestamp with time zone;

-- Useful index for stale-contact queries
CREATE INDEX IF NOT EXISTS idx_contacts_last_contacted_at
  ON contacts (brokerage_id, last_contacted_at)
  WHERE deleted_at IS NULL AND ai_outreach_paused = false;
