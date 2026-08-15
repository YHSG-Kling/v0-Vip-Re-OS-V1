-- 1029-open-house-instant-greeting.sql
--
-- Adds tracking columns for the Open House Concierge Mobile "90-second
-- auto-text" surface — when an attendee checks in via QR sign-in kiosk,
-- sendInstantOpenHouseGreeting() (lib/open-house/instant-greeting.ts)
-- fires an evaluateOutbound-gated personalized message in the agent's
-- voice and stamps these columns so the agent's open-house dashboard can
-- show the auto-greeting status per attendee.
--
-- Applied to live via Supabase MCP migration
-- "open_house_instant_greeting_tracking". Committed here for parity.

ALTER TABLE open_house_attendees
  ADD COLUMN IF NOT EXISTS instant_greeting_sent_at     timestamptz,
  ADD COLUMN IF NOT EXISTS instant_greeting_channel     text CHECK (instant_greeting_channel IN ('sms','email')),
  ADD COLUMN IF NOT EXISTS instant_greeting_message_id  uuid;

CREATE INDEX IF NOT EXISTS idx_open_house_attendees_instant_greeting
  ON open_house_attendees (event_id, instant_greeting_sent_at)
  WHERE instant_greeting_sent_at IS NOT NULL;

COMMENT ON COLUMN open_house_attendees.instant_greeting_sent_at IS
  'When the 90-second auto-text was sent via sendInstantOpenHouseGreeting() in lib/open-house/instant-greeting.ts. NULL until the greeting fires.';
COMMENT ON COLUMN open_house_attendees.instant_greeting_channel IS
  'sms or email — chosen based on contact.phone presence + TCPA consent.';
COMMENT ON COLUMN open_house_attendees.instant_greeting_message_id IS
  'messages.id of the queued outbound message — outbound dispatcher delivers via Twilio (sms) / SendGrid (email).';
