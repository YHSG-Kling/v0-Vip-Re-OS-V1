-- Migration: add kiosk check-in fields to open_house_attendees
-- These are required for the public kiosk sign-in flow (no auth, no contact_id lookup needed)

ALTER TABLE public.open_house_attendees
  ADD COLUMN IF NOT EXISTS name          text,
  ADD COLUMN IF NOT EXISTS email         text,
  ADD COLUMN IF NOT EXISTS phone         text,
  ADD COLUMN IF NOT EXISTS tcpa_consent  boolean NOT NULL DEFAULT false;

-- Index for quick lookup by event + email (dedup check-ins)
CREATE INDEX IF NOT EXISTS idx_oha_event_email
  ON public.open_house_attendees (event_id, email)
  WHERE email IS NOT NULL;
