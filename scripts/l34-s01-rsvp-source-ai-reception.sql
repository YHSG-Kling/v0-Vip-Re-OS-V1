-- l34-s01-rsvp-source-ai-reception.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- THE RECEPTION AI RSVPs CALLERS TO OPEN HOUSES on a live call — the RSVP
-- rail's source CHECK gains 'ai_reception' so the channel is attributable.
-- Idempotent.
ALTER TABLE public.open_house_rsvp_tracking DROP CONSTRAINT IF EXISTS open_house_rsvp_tracking_source_check;
ALTER TABLE public.open_house_rsvp_tracking ADD CONSTRAINT open_house_rsvp_tracking_source_check
CHECK ((source = ANY (ARRAY['email'::text, 'sms'::text, 'qr_code'::text, 'walk_in'::text, 'ai_reception'::text])));
