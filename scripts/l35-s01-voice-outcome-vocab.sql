-- l35-s01-voice-outcome-vocab.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- LIVE-CHECK CATCH: voice_calls.outcome had a CHECK missing values the Twilio
-- lanes write (opt_out / voicemail / busy / failed / canceled) — those
-- best-effort updates dropped SILENTLY, taking status/ended_at with them —
-- plus the new warm-bridge states. Widened. Idempotent.
ALTER TABLE public.voice_calls DROP CONSTRAINT IF EXISTS voice_calls_outcome_check;
ALTER TABLE public.voice_calls ADD CONSTRAINT voice_calls_outcome_check
CHECK ((outcome = ANY (ARRAY['appointment_set'::text,'callback_requested'::text,'not_interested'::text,'voicemail_left'::text,'no_answer'::text,'transferred'::text,'completed'::text,'authority_blocked'::text,'opt_out'::text,'voicemail'::text,'busy'::text,'failed'::text,'canceled'::text,'warm_bridge_ringing'::text,'warm_transferred'::text,'warm_bridge_missed'::text])));
