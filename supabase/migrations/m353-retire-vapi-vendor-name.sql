-- l40-s02/s03 — RETIRE THE VENDOR NAME ITSELF.
--
-- The owner's ruling is "no VAPI at all — only Twilio and ElevenLabs", and the
-- vendor's CODE was removed long ago. What survived was its VOCABULARY, sitting
-- on the tables and columns the Twilio-native lane actually uses. l40-s01 fixed
-- one column of it; this finishes the job.
--
-- WHY A NAME IS NOT COSMETIC HERE. Every defect in this sweep has the same
-- shape: a name that says one thing while the value means another. A ledger
-- called vapi_phone_numbers that only ever holds Twilio numbers teaches every
-- future reader — human or model — that the two are interchangeable, and the
-- next person to wire something reaches for the wrong provider's identifier.
-- That is exactly how the "cred_xxx into a Twilio SID path" bug was born.
--
-- EVERY TABLE TOUCHED HERE WAS EMPTY except ai_identity_profiles (1 row, whose
-- voice_provider was already 'elevenlabs'). Nothing is rewritten or lost.

-- ── 1. The inventory ledger ─────────────────────────────────────────────────
ALTER TABLE public.vapi_phone_numbers RENAME TO tenant_phone_numbers;
ALTER INDEX vapi_phone_numbers_pkey       RENAME TO tenant_phone_numbers_pkey;
ALTER INDEX idx_vapi_numbers_brokerage    RENAME TO idx_tenant_phone_numbers_brokerage;
ALTER INDEX idx_vapi_numbers_agent        RENAME TO idx_tenant_phone_numbers_agent;
ALTER INDEX idx_vapi_numbers_phone_digits RENAME TO idx_tenant_phone_numbers_phone_digits;
ALTER TABLE public.tenant_phone_numbers
  RENAME CONSTRAINT vapi_phone_numbers_brokerage_id_fkey   TO tenant_phone_numbers_brokerage_id_fkey;
ALTER TABLE public.tenant_phone_numbers
  RENAME CONSTRAINT vapi_phone_numbers_number_source_check TO tenant_phone_numbers_number_source_check;
ALTER TABLE public.tenant_phone_numbers
  RENAME CONSTRAINT vapi_phone_numbers_scope_type_check    TO tenant_phone_numbers_scope_type_check;

-- ── 2. The call ledger's vendor id ──────────────────────────────────────────
-- It holds the Twilio CallSid on the phone lane and "zoom:<uuid>" on the
-- meeting lane. Its own inline comment already said "vendor call id (Twilio
-- CallSid here)" — the code knew; only the column disagreed. vendor_call_id is
-- the honest name precisely BECAUSE two vendors write it.
ALTER TABLE public.voice_calls RENAME COLUMN vapi_call_id TO vendor_call_id;

-- ── 3. call_type ────────────────────────────────────────────────────────────
-- 'vapi_inbound' labels a call the Twilio-native lane answers. It means "the
-- AI picked up", which is what the value now says.
ALTER TABLE public.voice_calls DROP CONSTRAINT IF EXISTS voice_calls_call_type_check;
ALTER TABLE public.voice_calls ADD CONSTRAINT voice_calls_call_type_check
  CHECK (call_type = ANY (ARRAY['agent_call'::text, 'ai_isa_call'::text,
                                'ai_inbound'::text, 'warm_transfer'::text,
                                'zoom_meeting'::text]));

-- ── 4. Four vestigial columns, each verified to have no consumer ────────────
--   · ai_identity_profiles.vapi_assistant_id — m327 removed its two readers.
--     build-call-context still SELECTed it but reads only elevenlabs_voice_id,
--     so the select was dropped with the column.
--   · ai_isa_settings.vapi_assistant_id / .vapi_phone_number_id — zero readers.
--   · phone_number_events.vapi_number_id — written from an optional parameter
--     no caller ever passes, and read by nothing.
ALTER TABLE public.ai_identity_profiles DROP COLUMN IF EXISTS vapi_assistant_id;
ALTER TABLE public.ai_isa_settings      DROP COLUMN IF EXISTS vapi_assistant_id;
ALTER TABLE public.ai_isa_settings      DROP COLUMN IF EXISTS vapi_phone_number_id;
ALTER TABLE public.phone_number_events  DROP COLUMN IF EXISTS vapi_number_id;

-- ── 5. voice_provider (l40-s03) ─────────────────────────────────────────────
-- The CHECK still admitted the retired vendor, so a profile could name an
-- engine nothing dispatches to — the same collect-then-ignore shape as the
-- phone form. The Settings control that offered it has been replaced by a
-- statement of fact, since each agent uses their OWN clone and there is
-- deliberately no brokerage voice to fall back to.
ALTER TABLE public.ai_identity_profiles
  DROP CONSTRAINT IF EXISTS ai_identity_profiles_voice_provider_check;
ALTER TABLE public.ai_identity_profiles
  ADD CONSTRAINT ai_identity_profiles_voice_provider_check
  CHECK (voice_provider = 'elevenlabs'::text);

-- ── WHAT DELIBERATELY KEEPS THE NAME ────────────────────────────────────────
-- The vendor's name survives in exactly two kinds of place, and removing it
-- from either would do harm:
--   · DECOMMISSIONED_PROVIDERS — naming the vendor is the MECHANISM that
--     excludes it from posture and attribution. Delete the name and a stale
--     ledger row resurrects the provider.
--   · VENDOR_PRICING / VENDOR_POLICY / vendor-ownership / tenancy-matrix —
--     keyed to historical vendor_usage_tracking rows. The standing rule is
--     never delete a rate, or old ledger rows stop pricing.
-- Everything else is gone.

-- ── RE-DECLARED FOR THE RECORD ──────────────────────────────────────────────
-- l40-s01 (scripts/l40-s01-phone-inventory-honest-vocabulary.sql) changed two
-- CHECKs on this lane before this file existed. The vocabulary guard resolves
-- the newest declaration per (table, column) from THIS directory, so re-stating
-- them here keeps the migration record and the snapshot in agreement — and
-- keeps the key current under the table's new name.
ALTER TABLE public.tenant_phone_numbers
  DROP CONSTRAINT IF EXISTS tenant_phone_numbers_number_source_check;
ALTER TABLE public.tenant_phone_numbers
  ADD CONSTRAINT tenant_phone_numbers_number_source_check
  CHECK (number_source = ANY (ARRAY['byoc_twilio'::text, 'ported'::text]));

ALTER TABLE public.phone_number_events
  DROP CONSTRAINT IF EXISTS phone_number_events_event_type_check;
ALTER TABLE public.phone_number_events
  ADD CONSTRAINT phone_number_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'purchased'::text, 'manually_added'::text, 'ported_in'::text,
    'released'::text, 'failed'::text, 'webhooks_bound'::text]));
