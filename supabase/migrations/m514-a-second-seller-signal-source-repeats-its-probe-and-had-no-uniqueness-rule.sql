-- m514-a-second-seller-signal-source-repeats-its-probe-and-had-no-uniqueness-rule.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- THE DEFECT: motivated_seller_signals now has a SECOND external source that
-- re-reads the same facts on a repeating cadence, and the only uniqueness rule
-- on the table is scoped to the FIRST one's two signal_types.
--
-- m490 created `motivated_seller_signals_permit_dedupe` for signal_type
-- 'permit_activity'. m499 superseded it with
-- `motivated_seller_signals_socrata_dedupe`, widening the predicate to
--
--     WHERE signal_type IN ('permit_activity','code_violation')
--       AND signal_details ? 'dedupe_key'
--
-- Both of those files state the stake in the same sentence, and it has not
-- changed: lib/services/lead-management.service.ts scores a lead by COUNTING
-- signals, so one fact re-filed seven times becomes seven independent reasons
-- to believe somebody is selling. That is a scoring defect wearing a
-- duplicate-row costume.
--
-- lib/external/batchdata-seller-signals.ts is the second source (owner
-- directive: "we need to find another way to find out signs for motivated
-- sellers besides permits, maybe use our connection to batchdata?"). It probes
-- the tenant's OWN leads against the property provider on a rotation, so the
-- same unchanged property is re-read every rotation by design — exactly the
-- shape m490 was written for, arriving a second time from a different provider.
--
-- Under m499's predicate those rows carry NO uniqueness guarantee whatsoever.
-- Not a weaker one: none. Every one of the ten signal_types below falls outside
-- the index, so Postgres would accept the identical dedupe_key on every
-- rotation, and the only thing between an absentee owner in Tampa and a fresh
-- "motivated seller" signal every pass would be an application-level read that
-- a concurrent run, a re-dispatch or a partially-failed batch can lose. This
-- repo's recurring finding is the gate that is not a gate.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────────────
-- ONE index for the whole table rather than a third parallel one. The unit of
-- uniqueness is already stated correctly by m499 — "one row per (signal_type,
-- dedupe_key)" — and it is the same rule this lane implements, so the predicate
-- is widened to the full set of swept signal_types instead of a second index
-- being created beside the first. Two indexes over one column pair with
-- overlapping predicates is how a later author ends up unsure which one is the
-- rule.
--
-- `signal_details ? 'dedupe_key'` is retained and is load-bearing HERE in a way
-- it was not before. Two of the ten types below — 'high_equity' and
-- 'market_timing' — are DELIBERATELY REUSED spellings: they already have a
-- writer at app/actions/lead-intelligence.ts:1197 and :1180 for exactly these
-- facts (CLAUDE.md §6 — merge onto one spelling rather than coining
-- `equity_position` and `ownership_tenure` beside them). That writer stores NO
-- dedupe_key, so its rows fall outside this predicate and are unaffected: the
-- index constrains the rows that carry a key and ignores the rows that do not.
-- Removing the `?` clause would retroactively impose a uniqueness rule on a
-- writer that never promised one, and refuse its inserts.
--
-- ── ORDER OF OPERATIONS ─────────────────────────────────────────────────────
-- The widened index is CREATED FIRST under a new name and the narrower one
-- dropped after. For the moment both exist the permit rows are doubly
-- constrained, which is harmless — the two predicates agree exactly on that
-- subset. Dropping first would leave a window with no guarantee at all: small,
-- but this is the third file in a row whose entire subject is that a small
-- window with no guarantee is how duplicates get in.
--
-- ADDITIVE AND SAFE. No column changes, no data rewritten. Verified against the
-- live project (hrvaqgvukzxfskkcrwbt) on 2026-08-20:
--   select count(*) from motivated_seller_signals             → 0
--   pg_constraint on the table                                → pkey,
--     brokerage_id fkey, and motivated_seller_signals_signal_strength_check
--     (m500, applied) — there is NO check constraint on signal_type, so the ten
--     values below are already accepted values and this index is the only
--     schema object that has to learn about them.
-- so no existing row can fail the new index.

-- ── 1. the widened guarantee ────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS motivated_seller_signals_external_dedupe
  ON public.motivated_seller_signals
     (signal_type, (signal_details ->> 'dedupe_key'))
  WHERE signal_type IN (
          -- lib/external/permit-signals.ts (Socrata + ArcGIS)
          'permit_activity', 'code_violation',
          -- lib/external/batchdata-seller-signals.ts
          'sale_propensity', 'preforeclosure', 'tax_delinquent', 'involuntary_lien',
          'vacancy', 'absentee_owner', 'tired_landlord', 'listing_withdrawn',
          'high_equity', 'market_timing'
        )
    AND signal_details ? 'dedupe_key';

COMMENT ON INDEX public.motivated_seller_signals_external_dedupe IS
  'One signal per (signal_type, dedupe_key) for every EXTERNAL seller-signal sweep — the Socrata/ArcGIS permit + code-violation lane and the BatchData property-probe lane. Both re-read the same facts on a repeating cadence; without this, one fact becomes one signal per pass and lead scoring counts each as an independent reason to believe somebody is selling. Supersedes motivated_seller_signals_socrata_dedupe (m499), which covered permit_activity and code_violation only. The `signal_details ? dedupe_key` predicate is deliberate: app/actions/lead-intelligence.ts also writes high_equity and market_timing WITHOUT a dedupe_key and must stay unconstrained by this rule.';

-- ── 2. retire the narrower one it supersedes ────────────────────────────────
DROP INDEX IF EXISTS public.motivated_seller_signals_socrata_dedupe;
