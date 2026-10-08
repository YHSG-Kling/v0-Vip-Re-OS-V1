-- m499-a-second-signal-type-swept-daily-had-no-uniqueness-rule-at-all.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- THE DEFECT: m490's uniqueness rule for the Socrata sweep is scoped to ONE
-- signal_type, and the sweep now writes TWO.
--
-- m490 created `motivated_seller_signals_permit_dedupe`, a partial UNIQUE index
-- on signal_details->>'dedupe_key' with the predicate
--
--     WHERE signal_type = 'permit_activity' AND signal_details ? 'dedupe_key'
--
-- That predicate was exactly right for what shipped: one lane, one signal_type,
-- one daily sweep over a rolling 7-day window. m490's own header states the
-- stake plainly — lib/services/lead-management.service.ts scores a lead by
-- COUNTING signals, so a permit re-seen seven times becomes seven independent
-- reasons to believe somebody is selling. That is a scoring defect wearing a
-- duplicate-row costume.
--
-- lib/external/permit-signals.ts now also ingests city CODE VIOLATIONS as
-- signal_type = 'code_violation' (registered in socrata-market-registry.ts since
-- it was written, and until today discarded by `if (kind !== "permits") continue`
-- — dead weight that looked like coverage). Those rows are produced by the SAME
-- daily cron, over the SAME rolling window, and land in the SAME table.
--
-- Under m490's predicate they would carry NO uniqueness guarantee whatsoever.
-- Not a weaker one — none. Every code_violation row falls outside the index, so
-- Postgres would accept the identical dedupe_key on every run, and the only
-- thing standing between a broken handrail in Chicago and seven "motivated
-- seller" signals a week would be an application-level read that a concurrent
-- run, a re-dispatch, or a partially-failed batch can lose. This repo's
-- recurring finding is the gate that is not a gate; shipping the second
-- signal_type before widening this index would have built one on purpose.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────────────
-- The predicate is widened to the set of signal_types this lane writes, and
-- signal_type joins the key. Two reasons for the composite key rather than
-- widening the predicate alone:
--
--   1. It is honest about the unit of uniqueness. "One row per (signal_type,
--      dedupe_key)" is the rule the code actually implements; dedupe_key already
--      embeds the dataset id and the lead id, so a cross-type collision is not
--      possible today, but the index should not depend on that staying true.
--   2. It serves the idempotency READ, which is now
--      `.eq(brokerage_id).in(signal_type, [...])` — a leading signal_type gives
--      that predicate an index to stand on.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- The new index is CREATED FIRST and the old one dropped after. For the moment
-- both exist the table is doubly constrained on permit rows, which is harmless
-- (the two predicates agree on that subset). Dropping first would leave a
-- window with no guarantee at all — small, but this is the file whose entire
-- subject is that "small window with no guarantee" is how duplicates get in.
--
-- ADDITIVE AND SAFE. No column changes and no data rewritten. Verified against
-- the live project (hrvaqgvukzxfskkcrwbt) on 2026-08-20:
--   select count(*) from motivated_seller_signals  → 0
-- so no existing row can fail the new index, and
--   motivated_seller_signals.signal_type is text NOT NULL with NO check
--   constraint (pg_constraint carries only the pkey and the brokerage_id FK),
-- so 'code_violation' is already an accepted value — this index is the ONLY
-- schema object that had to learn about it.

-- ── 1. the widened guarantee ────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS motivated_seller_signals_socrata_dedupe
  ON public.motivated_seller_signals
     (signal_type, (signal_details ->> 'dedupe_key'))
  WHERE signal_type IN ('permit_activity', 'code_violation')
    AND signal_details ? 'dedupe_key';

COMMENT ON INDEX public.motivated_seller_signals_socrata_dedupe IS
  'One signal per (signal_type, dedupe_key) for the Socrata sweep — building permits and code violations. The daily cron re-reads a rolling window; without this, one record becomes one signal per day and lead scoring counts each as an independent reason. Supersedes motivated_seller_signals_permit_dedupe, which covered permit_activity only.';

-- ── 2. retire the narrower one it supersedes ────────────────────────────────
DROP INDEX IF EXISTS public.motivated_seller_signals_permit_dedupe;
