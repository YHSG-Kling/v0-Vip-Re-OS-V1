-- =====================================================
-- MIGRATION 045: Add 'blocked' to voice_calls.status CHECK
-- =====================================================
-- The Vapi webhook writes voice_calls rows with status='blocked' when
-- the inbound authority gate denies the call (TCPA, DNC, restricted
-- state). The existing CHECK omits 'blocked', so every such denial
-- write was failing silently in production.
-- =====================================================

ALTER TABLE public.voice_calls
  DROP CONSTRAINT IF EXISTS voice_calls_status_check;

ALTER TABLE public.voice_calls
  ADD CONSTRAINT voice_calls_status_check
  CHECK (status IN (
    'initiated', 'ringing', 'in_progress',
    'completed', 'failed', 'no_answer', 'voicemail',
    'blocked'
  ));
