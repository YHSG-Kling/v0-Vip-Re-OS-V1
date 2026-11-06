-- ── APPLIED LIVE 2026-11-06 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 150, lane 150JNAD ──
--
-- m970 — movement_signals: THE C37 MOVING-MOMENT FIELDS on the EXISTING C9 record (wave 150, lane 150JNAD — directive 150J + 150N;
-- contract C37). NOT a second prediction store: the evidence stays the C9 row (m892), the frozen forecast is an ai_predictions row
-- (prediction_type 'decision_window', m971 adds only its index), and the moment itself is computed in code
-- (lib/intent/moving-moments.ts buildMovingMoment).
--
-- Per RECORD (what one piece of evidence documents — written by lib/intent/movement-signals.ts movementRowFor ONLY when present,
-- so an ordinary row names no m970 column):
--   known_deadline_kind / known_deadline_at  a date the evidence itself documents (a lease end in the person's own words, a planned
--                                            list date) — a stated date beats any inferred range (KNOWN_DEADLINE_KINDS, one spelling)
--   stated_timeline                          the timeline bucket the person THEMSELVES stated in this evidence (a public post in their
--                                            own voice — the classifier's timeline_bucket, previously dropped on the floor); the
--                                            contacts.timeline vocabulary plus the classifier's short spellings
-- Per SUBJECT at a decision (stamped by evaluateMovementSubject on every row of the decided evidence set, beside `decision`):
--   decision_window                          the reporting interval of the subject's moment (0_30 / 31_90 / 91_180 / 181_365 /
--                                            over_365 / unknown — DECISION_WINDOWS) — never a follow-up cadence
--   moment                                   the C37 summary (readiness per side, desire, expectation, ability, barriers, known
--                                            deadline, identity / source confidence, rights, negative evidence, outreach permission,
--                                            labelled vendor-score units, published probability or null, unread facts, open plays)
-- Readers: lib/intent/movement-signals.ts (observationOf → the moment; loadMomentFacts reads stated_timeline), lib/intelligence/
-- strategy-learning.ts tenantMovementOutcomeLearning (decision_window + decision.holdout by outcome).
--
-- DEPLOY ORDER: evaluateMovementSubject names decision_window / moment in its decision UPDATE for every person subject — a deploy
-- ahead of this migration makes that UPDATE refused whole (PGRST204) and the decision stamp is lost (the ledger row still records
-- the decision). Apply this migration WITH the code.

ALTER TABLE public.movement_signals
  ADD COLUMN IF NOT EXISTS known_deadline_kind text,
  ADD COLUMN IF NOT EXISTS known_deadline_at   timestamptz,
  ADD COLUMN IF NOT EXISTS stated_timeline     text,
  ADD COLUMN IF NOT EXISTS decision_window     text,
  ADD COLUMN IF NOT EXISTS moment              jsonb;

ALTER TABLE public.movement_signals DROP CONSTRAINT IF EXISTS movement_signals_known_deadline_kind_check;
ALTER TABLE public.movement_signals ADD CONSTRAINT movement_signals_known_deadline_kind_check
  CHECK (known_deadline_kind IS NULL OR known_deadline_kind IN ('lease_end', 'planned_list_date', 'closing_date', 'relocation_start', 'other_stated'));

-- A kind without a date (or a date without a kind) is not a known deadline.
ALTER TABLE public.movement_signals DROP CONSTRAINT IF EXISTS movement_signals_known_deadline_pair_check;
ALTER TABLE public.movement_signals ADD CONSTRAINT movement_signals_known_deadline_pair_check
  CHECK ((known_deadline_kind IS NULL) = (known_deadline_at IS NULL));

ALTER TABLE public.movement_signals DROP CONSTRAINT IF EXISTS movement_signals_stated_timeline_check;
ALTER TABLE public.movement_signals ADD CONSTRAINT movement_signals_stated_timeline_check
  CHECK (stated_timeline IS NULL OR stated_timeline IN ('immediate', '1-3_months', '3-6_months', '6-12_months', '12+_months', 'researching', '1-3', '3-6', '6-12'));

ALTER TABLE public.movement_signals DROP CONSTRAINT IF EXISTS movement_signals_decision_window_check;
ALTER TABLE public.movement_signals ADD CONSTRAINT movement_signals_decision_window_check
  CHECK (decision_window IS NULL OR decision_window IN ('0_30', '31_90', '91_180', '181_365', 'over_365', 'unknown'));

-- Outcome learning reads closed rows by window inside a tenant.
CREATE INDEX IF NOT EXISTS movement_signals_brokerage_window_outcome_idx
  ON public.movement_signals (brokerage_id, decision_window, outcome_at)
  WHERE outcome IS NOT NULL;

-- VERIFY (integrator, after apply):
--   SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='movement_signals'
--     AND column_name IN ('known_deadline_kind','known_deadline_at','stated_timeline','decision_window','moment');   -- 5 rows
--   then regenerate scripts/schema-snapshot.ts and scripts/check-vocabularies.ts (CLAUDE.md §3).
