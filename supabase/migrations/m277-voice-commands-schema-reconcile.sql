-- m277 — voice_commands schema reconcile (documentation / fresh-DB parity)
--
-- The voice_commands table (originally created by scripts/098-voice-assistant-
-- system.sql) was reshaped out-of-band on the live database: the command-history
-- writers in app/api/internal/voice-command/route.ts and app/actions/voice-
-- assistant.ts write a NEW column set (user_id / brokerage_id / raw_transcript /
-- parsed_intent / command_type / entities / action_result / error_message /
-- processing_ms / source) that the checked-in migration never declared, and the
-- original columns (session_id / agent_id / contact_id / command_text /
-- intent_detected / entities_extracted / response_text) were dropped.
--
-- The running code and the LIVE schema already agree — the schema-drift guard
-- passes — so this migration changes NOTHING on the live database (every clause
-- is IF [NOT] EXISTS). Its purpose is repo↔live parity so a fresh database
-- provisions the true, current shape, and so the phased voice-admin
-- consolidation has an accurate on-disk record to work from.

-- 1. Ensure the canonical (current live) columns exist.
ALTER TABLE public.voice_commands ADD COLUMN IF NOT EXISTS user_id          uuid;
ALTER TABLE public.voice_commands ADD COLUMN IF NOT EXISTS brokerage_id     uuid;
ALTER TABLE public.voice_commands ADD COLUMN IF NOT EXISTS raw_transcript   text;
ALTER TABLE public.voice_commands ADD COLUMN IF NOT EXISTS parsed_intent    text;
ALTER TABLE public.voice_commands ADD COLUMN IF NOT EXISTS command_type     text;
ALTER TABLE public.voice_commands ADD COLUMN IF NOT EXISTS entities         jsonb;
ALTER TABLE public.voice_commands ADD COLUMN IF NOT EXISTS action_taken     text;
ALTER TABLE public.voice_commands ADD COLUMN IF NOT EXISTS action_result    jsonb;
ALTER TABLE public.voice_commands ADD COLUMN IF NOT EXISTS success          boolean;
ALTER TABLE public.voice_commands ADD COLUMN IF NOT EXISTS error_message    text;
ALTER TABLE public.voice_commands ADD COLUMN IF NOT EXISTS confidence_score numeric;
ALTER TABLE public.voice_commands ADD COLUMN IF NOT EXISTS processing_ms    integer;
ALTER TABLE public.voice_commands ADD COLUMN IF NOT EXISTS source           text;

-- 2. Drop the superseded original-shape columns (already gone on live; this only
--    corrects a fresh database that ran scripts/098's original CREATE TABLE).
ALTER TABLE public.voice_commands DROP COLUMN IF EXISTS session_id;
ALTER TABLE public.voice_commands DROP COLUMN IF EXISTS agent_id;
ALTER TABLE public.voice_commands DROP COLUMN IF EXISTS contact_id;
ALTER TABLE public.voice_commands DROP COLUMN IF EXISTS command_text;
ALTER TABLE public.voice_commands DROP COLUMN IF EXISTS intent_detected;
ALTER TABLE public.voice_commands DROP COLUMN IF EXISTS entities_extracted;
ALTER TABLE public.voice_commands DROP COLUMN IF EXISTS response_text;

COMMENT ON TABLE public.voice_commands IS
  'Voice-admin command history (Stack B /api/internal/voice-command + Stack D voice-assistant.ts). Canonical shape reconciled in m277; the phased voice-admin consolidation will unify audit onto agent_assistant_tool_calls.';
