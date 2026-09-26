-- ═══════════════════════════════════════════════════════════════════════════
-- m386 — CONTENT GENERATION LOG: THE PROMPT COMES WITH THE LOG.
--        One column, added so a duplicate can be deleted without losing what
--        it recorded.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- OWNER ASK: "content generation lane needs investigation to see which one
-- holds the most advanced — keep that one and merge any functions that the
-- other one has and delete the loser." Plus the governing correction: PORT
-- FIRST, delete second, never on a no-caller rationale.
--
-- ── THE DUPLICATE BEING COLLAPSED ──────────────────────────────────────────
-- Two functions in app/actions/ai-content-generation.tsx wrote the SAME
-- generation telemetry — model, token counts, elapsed ms, success flag, error
-- message — into TWO different tables:
--
--   LOSER    logContentGeneration  → ai_generated_content, with the telemetry
--                                    buried in metadata under is_log = true.
--                                    ai_generated_content has NO success,
--                                    NO generation_time_ms and NO tokens_used
--                                    column, so its own reader
--                                    (getContentGenerationStats) read three
--                                    columns that do not exist and reported
--                                    0 / 0 / 0 forever. Verified against the
--                                    live schema, not inferred. It also took
--                                    agentId FROM THE CALLER on a "use server"
--                                    export, and it shared its name with
--                                    lib/content-generation/generation-logger.ts
--                                    ::logContentGeneration, which writes a
--                                    completely different row into `activities`.
--
--   SURVIVOR logGenerationCost     → content_generation_logs, which has a typed
--                                    column for every one of those fields plus
--                                    cost_usd. Resolves the actor from the
--                                    session, stamps brokerage_id at the
--                                    insert, destructures error and returns it.
--
-- The survivor is strictly more capable on every axis EXCEPT ONE: the loser
-- also stored the first 500 characters of the PROMPT that produced the
-- generation. content_generation_logs had nowhere to put it.
--
-- ── WHY THIS COLUMN, NOT A jsonb BAG ───────────────────────────────────────
-- content_generation_logs is NOT a generic table — it is the AI-generation
-- audit ledger and nothing else. Every existing column on it (model_used,
-- prompt_tokens, completion_tokens, total_tokens, cost_usd,
-- generation_time_ms, success, error_message, content_type) is a first-class
-- typed column of exactly this kind. `prompt` is the same kind of fact and is
-- populated on every row the survivor writes, so it is a column, not a bag.
-- There is no CHECK constraint on this table and none is added: a prompt is
-- free text and pinning a vocabulary to it would be nonsense.
--
-- ── WIDENING ONLY ──────────────────────────────────────────────────────────
-- Nullable, no default, no constraint. Existing rows stay valid; nothing that
-- reads this table today selects `prompt`, so no reader changes behaviour on
-- apply. Live at apply time: content_generation_logs = 0 rows.
--
-- scripts/schema-snapshot.ts is updated in the same change. A column added
-- here without the snapshot makes schema-drift blind to it; a snapshot entry
-- without this migration produces a column PostgREST refuses and RESOLVES —
-- i.e. a silent write failure, which is the exact bug class this repo's
-- guards exist to stop.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.content_generation_logs
  ADD COLUMN IF NOT EXISTS prompt text;

COMMENT ON COLUMN public.content_generation_logs.prompt IS
  'First ~500 chars of the prompt that produced this generation. Ported from '
  'app/actions/ai-content-generation.tsx::logContentGeneration (deleted) when '
  'that duplicate collapsed into logGenerationCost. Audit trail only — never '
  'read back into a prompt.';

-- ── PROVE IT LANDED ────────────────────────────────────────────────────────
-- A migration that silently no-ops is worse than one that fails: the code
-- shipped alongside it starts writing a column the database will refuse, and
-- PostgREST resolves that refusal into a swallowed error rather than a throw.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'content_generation_logs'
       AND column_name  = 'prompt'
  ) THEN
    RAISE EXCEPTION
      'm386 FAILED: public.content_generation_logs.prompt was not created. '
      'app/actions/ai-content-generation.tsx::logGenerationCost writes this '
      'column on every insert — without it the prompt capture ported off the '
      'deleted logContentGeneration is lost and the insert is refused.';
  END IF;

  IF (
    SELECT data_type
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name   = 'content_generation_logs'
       AND column_name  = 'prompt'
  ) <> 'text' THEN
    RAISE EXCEPTION
      'm386 FAILED: public.content_generation_logs.prompt exists but is not '
      'text. A pre-existing column of another type would silently truncate or '
      'reject the ported prompt capture.';
  END IF;
END $$;

COMMIT;
