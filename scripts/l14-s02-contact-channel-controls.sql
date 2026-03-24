-- l14-s02-contact-channel-controls.sql
-- Adds preferred_channel, social_handles, and call_stop_flag to contacts.
-- Unified inbox view built on existing tables — no new table needed.
-- All columns are additive, no existing data is modified.

-- 1. preferred_channel — text enum-like column: sms, email, phone, direct_mail,
--    facebook, instagram, linkedin. NULL means system chooses best channel.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS preferred_channel text,
  ADD COLUMN IF NOT EXISTS social_handles jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS call_stop_flag boolean NOT NULL DEFAULT false;

-- 2. Same additions to leads (leads may not yet have a contact_id resolved)
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS preferred_channel text,
  ADD COLUMN IF NOT EXISTS call_stop_flag boolean NOT NULL DEFAULT false;

-- 3. Index for quick call-stop lookups in webhook handlers
CREATE INDEX IF NOT EXISTS idx_contacts_call_stop_flag
  ON contacts (id, call_stop_flag)
  WHERE call_stop_flag = true;

CREATE INDEX IF NOT EXISTS idx_leads_call_stop_flag
  ON leads (id, call_stop_flag)
  WHERE call_stop_flag = true;

-- 4. Index for preferred_channel lookups in dispatch routing
CREATE INDEX IF NOT EXISTS idx_contacts_preferred_channel
  ON contacts (id, preferred_channel)
  WHERE preferred_channel IS NOT NULL;
