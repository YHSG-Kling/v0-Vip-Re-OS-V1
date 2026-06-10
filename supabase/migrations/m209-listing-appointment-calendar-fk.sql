-- m209 — listing presentation appointment as a first-class CALENDAR EVENT, linked
-- from the listing (Listing Concierge burn). The seller consultation appointment was
-- written to phantom listings.appointment_date/appointment_time/notes — every
-- scheduleListingAppointment silently failed. Now it creates a calendar_events row
-- (so it flows to the agent's daily briefing, calendar view, and Google sync) and the
-- listing carries the denormalized time + a FK to the event for the listing card.
-- estimated_close_date is also a real listing field (the lifecycle's go-live math
-- selected it; it never existed).
ALTER TABLE public.listings
  ADD COLUMN IF NOT EXISTS appointment_at            timestamptz,
  ADD COLUMN IF NOT EXISTS appointment_notes         text,
  ADD COLUMN IF NOT EXISTS appointment_event_id      uuid REFERENCES public.calendar_events(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS estimated_close_date      date;
