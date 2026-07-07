-- l27-s01-vapi-number-nullable.sql — BUG FIX caught by the voice-rail live
-- proof: vapi_phone_numbers.vapi_phone_number_id was NOT NULL while the
-- provisioning insert omits it (and never checked the insert error) — so every
-- auto-provisioned number PURCHASED the Twilio number and then silently failed
-- to save the row. The Vapi id is genuinely unknown until the number is
-- registered with Vapi (the new inbound binding fills it), so nullable is the
-- correct model.
ALTER TABLE public.vapi_phone_numbers ALTER COLUMN vapi_phone_number_id DROP NOT NULL;

-- 'vapi_registered' joins the provisioning audit vocabulary (the inbound
-- binding logs when a number is imported into Vapi).
ALTER TABLE public.phone_number_events DROP CONSTRAINT phone_number_events_event_type_check;
ALTER TABLE public.phone_number_events ADD CONSTRAINT phone_number_events_event_type_check
  CHECK (event_type = ANY (ARRAY['purchased','manually_added','ported_in','released','failed','vapi_registered']));
