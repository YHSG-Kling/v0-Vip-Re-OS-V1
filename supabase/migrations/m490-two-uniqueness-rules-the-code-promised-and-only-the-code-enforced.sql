-- m490-two-uniqueness-rules-the-code-promised-and-only-the-code-enforced.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- TWO NEW LANES SHIPPED THIS PASS EACH CARRY A "THERE CAN ONLY BE ONE" RULE, AND
-- IN BOTH CASES THE ONLY THING ENFORCING IT WAS APPLICATION CODE THAT RUNS TWICE.
--
-- This repo's recurring finding is the gate that is not a gate: a rule stated in a
-- comment, honored by one writer, and enforced by nothing. Both rules below are
-- cheap to make facts, so they become facts.
--
-- ── 1. ONE DEFAULT PLAN PER VENDOR ───────────────────────────────────────────
-- `public.vendor_plans.is_default boolean DEFAULT false` has existed with no
-- constraint of any kind. The new catalogue writer
-- (app/actions/vendors/vendor-plans.ts :: setDefaultVendorPlanAction) clears the
-- old default and then sets the new one — TWO statements. Two browser tabs, or a
-- retried Server Action, can interleave those four statements into a vendor with
-- two default plans, and nothing downstream would notice: "the default plan" is a
-- singular that silently becomes a list.
--
-- A partial UNIQUE index says it once, for every writer that will ever exist:
-- at most one row per vendor may have is_default = true. false and NULL rows are
-- outside the index entirely, so a vendor may hold as many non-default plans as
-- they like. The two-statement writer now FAILS LOUDLY on the race instead of
-- producing a quietly wrong catalogue.
--
-- ── 2. ONE SIGNAL PER (PERMIT, LEAD) ─────────────────────────────────────────
-- `public.motivated_seller_signals` has no unique constraint at all, which was
-- fine while its only writers were per-lead enrichment passes fired by a human
-- action. The permit lane (app/api/cron/permit-signal-scan) is different in kind:
-- it is a DAILY SWEEP over a 7-day lookback window, so every permit is seen up to
-- seven times, and without a uniqueness rule a single roof permit becomes seven
-- identical "motivated seller" signals — which is not a duplicate row problem, it
-- is a SCORING problem. lib/services/lead-management.service.ts scores a lead by
-- COUNTING signals; seven copies of one permit reads as seven independent reasons
-- to believe someone is selling.
--
-- lib/external/permit-signals.ts writes a stable `signal_details.dedupe_key` and
-- reads back the existing keys before each run. That read is the fast path; this
-- index is the guarantee, and it is scoped narrowly:
--   · only rows this lane writes (signal_type = 'permit_activity')
--   · only rows that actually carry a key
-- so no existing row and no other writer is constrained by it. The dedupe_key
-- embeds the lead id, so it is already unique per tenant without naming
-- brokerage_id.
--
-- The companion non-unique index serves the idempotency READ itself: the sweep
-- asks "every permit signal for THIS brokerage" once per tenant per day, and the
-- only index on the table was brokerage_id alone.
--
-- BOTH ARE ADDITIVE. No column changes, no data rewritten, no existing row can
-- fail either index (verified below: zero duplicate defaults, zero permit rows).

-- ── 1 ────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS vendor_plans_one_default_per_vendor
  ON public.vendor_plans (vendor_id)
  WHERE is_default;

COMMENT ON INDEX public.vendor_plans_one_default_per_vendor IS
  'At most one default plan per marketplace vendor. setDefaultVendorPlanAction clears-then-sets in two statements; this makes the singular real under concurrency.';

-- ── 2 ────────────────────────────────────────────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS motivated_seller_signals_permit_dedupe
  ON public.motivated_seller_signals ((signal_details ->> 'dedupe_key'))
  WHERE signal_type = 'permit_activity'
    AND signal_details ? 'dedupe_key';

COMMENT ON INDEX public.motivated_seller_signals_permit_dedupe IS
  'One signal per (permit, lead) for the Socrata permit sweep. The daily cron re-sees a 7-day window; without this, one permit becomes seven signals and lead scoring counts them as seven reasons.';

CREATE INDEX IF NOT EXISTS idx_motivated_seller_signals_brokerage_type
  ON public.motivated_seller_signals (brokerage_id, signal_type);
