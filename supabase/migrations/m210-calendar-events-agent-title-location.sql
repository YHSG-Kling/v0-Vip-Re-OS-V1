-- m210 — give calendar_events the agent owner + display fields its writers have always
-- used (Deal Coordinator burn). The ISA appointment scheduler, copilot coaching sessions,
-- and the voice assistant insert agent_user_id/title/location/attendees/status — none
-- existed, so EVERY calendar insert silently failed (no ISA appointments, coaching
-- sessions, or voice-booked events ever persisted). start_at/end_at already exist
-- (writers using start_time/end_time are renamed in code).
ALTER TABLE public.calendar_events
  ADD COLUMN IF NOT EXISTS agent_user_id uuid,
  ADD COLUMN IF NOT EXISTS title         text,
  ADD COLUMN IF NOT EXISTS location      text,
  ADD COLUMN IF NOT EXISTS attendees     jsonb,
  ADD COLUMN IF NOT EXISTS status        text;
