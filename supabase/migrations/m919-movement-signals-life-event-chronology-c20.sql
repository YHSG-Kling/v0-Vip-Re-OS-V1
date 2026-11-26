-- ── APPLIED LIVE 2026-11-01 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 148, lane 148F ──
--
-- m919 — movement_signals: THE C20 LIFE-EVENT CHRONOLOGY on the C9 record (wave 148, lane 148F — owner ruling 5, 2026-11-01:
-- "life event spellings need to be set to the chronological vocab map so the code knows how to handle").
--
-- NO PARALLEL VOCABULARY TABLE (the brief, and CLAUDE.md §6): the vocabulary map is CODE — lib/enrichment/life-event-vocabulary.ts
-- LIFE_EVENT_VOCAB (canonical event → aliases → category → chain + stage → supersedes → sensitivity → allowed outreach). The
-- database carries the canonical SPELLING (a CHECK generated from that map's 13 canonical events) and the chronology every
-- life-event record carries:
--   life_event   the canonical event this row is about (NULL on a non-life-event row)
--   event_at     when the event HAPPENED, by the evidence (observed_at — m892 — stays when the source observed it)
--   sequence     the event's ordinal in the subject's life-event history; a second OBSERVATION of the same event keeps it
--   supersedes   the earlier movement_signals row this event replaces as the subject's current state (a relocation supersedes the
--                job change that led to it; an inheritance supersedes the death)
-- Writer: lib/intent/movement-signals.ts recordMovementSignal (movementChronology) — the columns ride LIFE-EVENT rows only, so a
-- non-life C9 row names no m919 column (a deploy ahead of this migration breaks only life-event writes, said in the lane notes).
-- movement_signals has 0 rows live (read 2026-11-01), so no backfill of these columns is owed.

ALTER TABLE public.movement_signals
  ADD COLUMN IF NOT EXISTS life_event text,
  ADD COLUMN IF NOT EXISTS event_at   timestamptz,
  ADD COLUMN IF NOT EXISTS sequence   integer,
  ADD COLUMN IF NOT EXISTS supersedes uuid;

ALTER TABLE public.movement_signals DROP CONSTRAINT IF EXISTS movement_signals_life_event_check;
ALTER TABLE public.movement_signals ADD CONSTRAINT movement_signals_life_event_check
  CHECK (life_event IS NULL OR life_event IN (
    'job_change', 'job_change_to_non_local', 'marriage', 'new_baby', 'kids_graduated', 'empty_nester', 'retirement',
    'divorce_filing', 'foreclosure_filing', 'death_in_household', 'inheritance', 'bankruptcy', 'relocation'
  ));

-- a non-life row carries no chronology; a life row's sequence is positive; a row never supersedes itself
ALTER TABLE public.movement_signals DROP CONSTRAINT IF EXISTS movement_signals_chronology_shape;
ALTER TABLE public.movement_signals ADD CONSTRAINT movement_signals_chronology_shape
  CHECK (
    (life_event IS NOT NULL OR (event_at IS NULL AND sequence IS NULL AND supersedes IS NULL))
    AND (sequence IS NULL OR sequence > 0)
    AND (supersedes IS NULL OR supersedes <> id)
  );

ALTER TABLE public.movement_signals DROP CONSTRAINT IF EXISTS movement_signals_supersedes_fkey;
ALTER TABLE public.movement_signals ADD CONSTRAINT movement_signals_supersedes_fkey
  FOREIGN KEY (supersedes) REFERENCES public.movement_signals (id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS movement_signals_life_event_chronology_idx
  ON public.movement_signals (brokerage_id, contact_id, life_event, sequence)
  WHERE life_event IS NOT NULL;

COMMENT ON COLUMN public.movement_signals.life_event IS 'C20 (wave 148, 148F): the canonical life event (lib/enrichment/life-event-vocabulary.ts LIFE_EVENT_VOCAB); NULL on a non-life row.';
COMMENT ON COLUMN public.movement_signals.event_at IS 'C20: when the event happened, by the evidence (observed_at is when the source observed it).';
COMMENT ON COLUMN public.movement_signals.sequence IS 'C20: the event''s ordinal in the subject''s life-event history (a second observation of the same event keeps it).';
COMMENT ON COLUMN public.movement_signals.supersedes IS 'C20: the earlier movement_signals row this event replaces as the current state (FK, ON DELETE SET NULL).';

-- ── VERIFY (integrator, after apply) ─────────────────────────────────────────────────────────────────────────────────────────
-- 1. INSERT a row with life_event = 'divorce'            → refused by movement_signals_life_event_check (23514) — the retired spelling
-- 2. INSERT a row with life_event NULL and sequence = 1  → refused by movement_signals_chronology_shape (23514)
-- 3. SELECT conname FROM pg_constraint WHERE conname = 'movement_signals_supersedes_fkey';   -- one row
-- Then regenerate scripts/schema-snapshot.ts, scripts/schema-fk-map.ts (+1 FK: movement_signals.supersedes → movement_signals.id)
-- and scripts/check-vocabularies.ts (movement_signals.life_event, 13 values).
