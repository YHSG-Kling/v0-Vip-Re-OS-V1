-- m500 — motivated_seller_signals.signal_strength IS A VOCABULARY, AND NOTHING
--        WAS ENFORCING IT.
--
-- WHAT THIS FIXES, and it is a scoring defect not a hygiene one. The column is
-- TEXT with NO CHECK. Every writer in the tree stores a WORD:
--
--   app/actions/lead-intelligence.ts:1187  'moderate'
--   app/actions/lead-intelligence.ts:1203  'strong' | 'moderate'   (equity)
--   app/actions/lead-intelligence.ts:1218  'weak'
--   app/actions/lead-intelligence.ts:1236  'strong' | 'moderate'   (life event)
--   app/actions/lead-intelligence.ts:2394  'urgent' | 'strong' | 'moderate'
--   lib/external/permit-signals.ts:549     'strong' | 'moderate' | 'weak'
--
-- and the ONE reader that scores them compared that text against a NUMBER:
--
--   sellerSignals.filter((s) => s.signal_strength > 0.7).length
--
-- In JavaScript that coerces the string, gets NaN, and NaN > 0.7 is false — for
-- every value in the vocabulary. The motivated-seller component of the lead
-- score has therefore always contributed exactly ZERO of its possible 30 points.
-- The app-side fix is lib/lead-governance/seller-signal-strength.ts, which owns
-- the ladder and the "counts as strong" threshold in one place.
--
-- WHY THE DATABASE ALSO CHANGES. Without a CHECK, the column cannot say which
-- of the two readings it holds, and the tree contains BOTH readings under the
-- same column NAME on other tables:
--
--   intelligence_signals_log.signal_strength — a 0-10 NUMBER
--   signal_reactivations.signal_strength     — a NUMBER
--
-- so the next writer to reach for this column has a coin-flip's chance of
-- storing '8' here and re-creating the same class of bug pointing the other way.
-- A vocabulary that only exists in six scattered string literals is not a
-- vocabulary; it is a convention waiting to be broken. This is the same
-- zero-baseline CHECK rule the repo already holds everywhere else.
--
-- ORDER MATTERS AND IS DELIBERATE: 'urgent' is the top of the ladder, above
-- 'strong'. Only the unified-profile lane emits it, and only from a read of a
-- PERSON'S stated motivation. The permit lane cannot spell it — a building
-- permit is a fact about a structure, and nothing observable there justifies
-- the top of the ladder.
--
-- MEASURED BEFORE WRITING: 0 rows in public.motivated_seller_signals, so this
-- constraint is validated rather than added NOT VALID. If that ever stops being
-- true on another environment, the ADD will fail loudly with the offending rows
-- named — which is the correct outcome, not a reason to weaken it.

ALTER TABLE public.motivated_seller_signals
  DROP CONSTRAINT IF EXISTS motivated_seller_signals_signal_strength_check;

ALTER TABLE public.motivated_seller_signals
  ADD CONSTRAINT motivated_seller_signals_signal_strength_check
  CHECK (signal_strength IS NULL OR signal_strength IN ('weak', 'moderate', 'strong', 'urgent'));

COMMENT ON COLUMN public.motivated_seller_signals.signal_strength IS
  'weak | moderate | strong | urgent — a WORD, never a number, ordered weakest to strongest. NULL means the writing lane could not judge it and is NOT the same as ''weak''. Lead scoring counts strong and urgent only; the ladder and that threshold live in lib/lead-governance/seller-signal-strength.ts. Do NOT copy the numeric reading used by intelligence_signals_log.signal_strength (0-10) or signal_reactivations.signal_strength — same column name, different unit, different table.';
