-- l40-s01 — the phone inventory ledger says one provider and means another.
--
-- PROOF, from the code that reads and writes it:
--   · lib/voice/number-provisioning.ts writes  byoc_credential_id: purchasedSid
--     where purchasedSid is the Twilio IncomingPhoneNumbers .sid
--   · app/actions/phone-provisioning.ts writes byoc_credential_id: params.twilioSid
--     — the parameter is ALREADY named twilioSid
--   · lib/voice/twilio-voice.ts reads it as the SID, interpolating it straight
--     into /2010-04-01/Accounts/{acct}/IncomingPhoneNumbers/{sid}.json, and its
--     own error says "Number has no Twilio SID on file"
--   · lib/platform/provider-posture.ts maps it to a field literally called `sid`
-- Four call sites treat it as a Twilio SID. Only the column NAME — and the one
-- UI that collects it — call it a BYOC credential, which is a VAPI concept from
-- a provider this OS retired ("no VAPI at all — only Twilio and ElevenLabs").
--
-- THE BUSINESS CONSEQUENCE, which is why this is not cosmetic. Settings → ISA
-- Calling → Add Number labels the input "BYOC Credential ID (from VAPI
-- Credentials)" and placeholders it "cred_xxx". Whatever the admin pastes lands
-- in the path segment above. Twilio 404s on it, bindNumberToTwilioLane fails,
-- and the number's VoiceUrl/SmsUrl are never registered — so a number added
-- through the admin UI can never receive a call or a text. The UI collected an
-- identifier for a provider that is gone, and the lane silently used it as a
-- different provider's identifier.
--
-- Both tables are EMPTY (0 rows, verified before this ran), so the rename and
-- the drops move no data and can lose none.

-- 1. Name the column for what every reader already believes it holds.
ALTER TABLE public.vapi_phone_numbers
  RENAME COLUMN byoc_credential_id TO twilio_number_sid;

-- 2. vapi_phone_number_id — write-only. The Add-Number dialog REQUIRED it
--    (handleAdd refused to submit without it), so the one manual registration
--    path was gated behind a dashboard this OS has no account for. No reader
--    exists anywhere in app/ or lib/.
ALTER TABLE public.vapi_phone_numbers DROP COLUMN IF EXISTS vapi_phone_number_id;

-- 3. forwarding_target / ivr_enabled / ivr_menu — collected, never delivered.
--    forwarding_target has zero readers; the "Call Forwarding" source it
--    belongs to is inert anyway, because inbound resolution matches
--    phone_digits of OUR numbers and a forwarded row holds someone else's.
--    ivr_* has zero readers AND no UI: updateIsaPhoneIvr was an exported
--    server action with no caller in the tree.
ALTER TABLE public.vapi_phone_numbers DROP COLUMN IF EXISTS forwarding_target;
ALTER TABLE public.vapi_phone_numbers DROP COLUMN IF EXISTS ivr_enabled;
ALTER TABLE public.vapi_phone_numbers DROP COLUMN IF EXISTS ivr_menu;

-- 4. number_source — the vocabulary named three providers this OS does not use
--    (vapi_native, byoc_vonage) or cannot honour (forwarded). Worse, the column
--    DEFAULT was 'vapi_native', so any insert that omitted the field stamped the
--    retired provider. Only byoc_twilio and ported are ever written by real code.
ALTER TABLE public.vapi_phone_numbers
  DROP CONSTRAINT IF EXISTS vapi_phone_numbers_number_source_check;
ALTER TABLE public.vapi_phone_numbers
  ALTER COLUMN number_source SET DEFAULT 'byoc_twilio';
ALTER TABLE public.vapi_phone_numbers
  ADD CONSTRAINT vapi_phone_numbers_number_source_check
  CHECK (number_source = ANY (ARRAY['byoc_twilio'::text, 'ported'::text]));

-- 5. phone_number_events.event_type — 'vapi_registered' is stamped by the
--    TWILIO binding path (twilio-voice.ts) and by A2P registration. It means
--    "the webhooks were bound", and it should say so.
ALTER TABLE public.phone_number_events
  DROP CONSTRAINT IF EXISTS phone_number_events_event_type_check;
ALTER TABLE public.phone_number_events
  ADD CONSTRAINT phone_number_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'purchased'::text, 'manually_added'::text, 'ported_in'::text,
    'released'::text, 'failed'::text, 'webhooks_bound'::text]));
