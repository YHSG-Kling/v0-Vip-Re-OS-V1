-- m502 — A CMA CAN SHOW A PROVIDER AVM BASELINE, BUT HAS NO COLUMN THAT CAN
--        TELL IT APART FROM THE RECOMMENDATION.
--
-- NOT APPLIED. Written by the CMA provider lane; the integrator applies it.
--
-- ─── WHAT IS MISSING ────────────────────────────────────────────────────────
-- Owner, verbatim: "rentcast does ovver an avm which can be argued but a
-- possible baseline."
--
-- The engine now carries that baseline. `lib/cma/comp-provider.ts` reads
-- RentCast's automated valuation off the SAME `/avm/value` response the
-- comparables come from (no second billed call), labels it, and hands it to
-- `runAiCma` as `providerAvmBaseline`. It reaches the narrative, the
-- disclaimers and the provenance notes.
--
-- It reaches NO COLUMN. `public.cma_reports` holds exactly three price columns:
--
--     recommended_price     numeric   -- the agent-facing list-price recommendation
--     price_range_low       numeric   -- ∓3% of the ADJUSTED CLOSED comps
--     price_range_high      numeric
--
-- Every one of them is comp-derived. There is nowhere to put a vendor's
-- automated estimate, so a saved CMA loses the baseline entirely — and the only
-- way to persist it without this migration would be to write it into one of the
-- three columns above, which is precisely the confusion the feature exists to
-- prevent. `recommended_price` is read by the seller portal, the net sheet, the
-- offer wizard and `app/actions/appraisal-defense.ts`, which argues it to a
-- LICENSED APPRAISER. A black-box AVM must never arrive there.
--
-- ─── WHY FOUR COLUMNS AND NOT ONE ───────────────────────────────────────────
-- Because "no baseline" is a real, common and reportable outcome, and a single
-- nullable numeric cannot say WHICH kind of nothing happened. RentCast is not
-- called at all for a tenant who has connected their own IDX Broker feed (owner
-- ruling); it is not called when the platform key is unset or the vendor budget
-- is exhausted; and it can be called and simply have no estimate for an address.
-- Those are four different sentences to a seller and to an operator. A NULL that
-- means all four is the "refused read renders as no data" failure this codebase
-- keeps paying for, so the reason travels with the number.
--
--   avm_baseline_value / _low / _high  — NULL when there is no baseline. NEVER 0.
--   avm_baseline_provider              — who produced it ('rentcast' today).
--   avm_baseline_unavailable_reason    — the plain sentence, when there is none.
--
-- A row therefore always answers "was there a baseline, and if not why not?"
-- without the reader having to infer it from a null.
--
-- ─── THE CHECK CONSTRAINT IS THE POINT ──────────────────────────────────────
-- `cma_avm_baseline_value_or_reason` makes the two halves mutually exclusive at
-- the storage layer: a row may carry a positive baseline value OR a reason it
-- has none, never both and never neither-when-a-provider-was-named. A writer
-- that "helpfully" defaults the value to 0 is rejected rather than persisted,
-- because a $0 baseline sitting next to a $600,000 range is a defect that looks
-- like data.
--
-- Additive and nullable throughout: no existing row changes, no existing writer
-- breaks, and `app/actions/ai-cma.ts` keeps writing `recommended_price` from the
-- comp-bounded pricing strategy exactly as it does today.

ALTER TABLE public.cma_reports
  ADD COLUMN IF NOT EXISTS avm_baseline_value              numeric,
  ADD COLUMN IF NOT EXISTS avm_baseline_low                numeric,
  ADD COLUMN IF NOT EXISTS avm_baseline_high               numeric,
  ADD COLUMN IF NOT EXISTS avm_baseline_provider           text,
  ADD COLUMN IF NOT EXISTS avm_baseline_unavailable_reason text;

COMMENT ON COLUMN public.cma_reports.avm_baseline_value IS
  'The data provider''s OWN automated valuation (AVM), stored as a BASELINE FOR COMPARISON ONLY. It is not derived from this report''s comparable sales, it has had no state appraiser adjustment applied, and it must NEVER be copied into recommended_price, price_range_low or price_range_high — those are comp-derived and are what the seller portal, the net sheet and the appraisal-defense package read. NULL means no baseline was available; see avm_baseline_unavailable_reason. Never 0.';
COMMENT ON COLUMN public.cma_reports.avm_baseline_low IS
  'Low end of the PROVIDER''S OWN range around avm_baseline_value. Not this analysis''s price_range_low. NULL when unknown.';
COMMENT ON COLUMN public.cma_reports.avm_baseline_high IS
  'High end of the PROVIDER''S OWN range around avm_baseline_value. Not this analysis''s price_range_high. NULL when unknown.';
COMMENT ON COLUMN public.cma_reports.avm_baseline_provider IS
  'Which provider produced the AVM baseline (''rentcast''). Set whenever a baseline was attempted, including when it came back unavailable, so the report can name who was asked.';
COMMENT ON COLUMN public.cma_reports.avm_baseline_unavailable_reason IS
  'Plain-language sentence saying WHY there is no AVM baseline — deliberately not called (the tenant has their own IDX feed), platform key unset, vendor budget exhausted, lookup failed, or the provider published no estimate for this address. Populated exactly when avm_baseline_value IS NULL and a provider was named. These are four different facts and a bare NULL cannot tell them apart.';

-- Value XOR reason, enforced where it cannot be forgotten.
ALTER TABLE public.cma_reports
  DROP CONSTRAINT IF EXISTS cma_avm_baseline_value_or_reason;
ALTER TABLE public.cma_reports
  ADD CONSTRAINT cma_avm_baseline_value_or_reason CHECK (
    -- No baseline was attempted at all: everything null. (Every row that exists
    -- today.)
    (avm_baseline_provider IS NULL
       AND avm_baseline_value IS NULL
       AND avm_baseline_low IS NULL
       AND avm_baseline_high IS NULL
       AND avm_baseline_unavailable_reason IS NULL)
    -- A baseline was published: a POSITIVE value, and no "why not".
    OR (avm_baseline_provider IS NOT NULL
       AND avm_baseline_value IS NOT NULL
       AND avm_baseline_value > 0
       AND avm_baseline_unavailable_reason IS NULL)
    -- A provider was asked and there is no baseline: a reason, and no number
    -- masquerading as one.
    OR (avm_baseline_provider IS NOT NULL
       AND avm_baseline_value IS NULL
       AND avm_baseline_low IS NULL
       AND avm_baseline_high IS NULL
       AND avm_baseline_unavailable_reason IS NOT NULL)
  );
