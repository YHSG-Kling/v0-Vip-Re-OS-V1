-- ═════════════════════════════════════════════════════════════════════════════
-- ⚠  THE "NOT APPLIED" CLAIM BELOW IS STALE. THIS MIGRATION *IS* APPLIED.
--
--    MEASURED 2026-09-04 against hrvaqgvukzxfskkcrwbt's own migration ledger,
--    `supabase_migrations.schema_migrations`, which carries a row named
--    `m498_…`. It was one of TWENTY files in this directory whose header said
--    it had never run; all twenty were in the ledger. Nobody came back to
--    update the headers after applying them.
--
--    THE EVIDENCE IS ONE-DIRECTIONAL, AND THAT IS STATED RATHER THAN GLOSSED:
--    presence in the ledger PROVES a migration ran. ABSENCE PROVES NOTHING —
--    the ledger only records migrations applied through the migration tool, and
--    m599 and m602–m605 are all applied and all absent from it, because they
--    were executed as direct SQL. So this banner is written only onto files the
--    ledger positively vouches for.
--
--    The original header is preserved below unedited. It is the record of what
--    its author believed when they wrote it, and CLAUDE.md §3 is the reason the
--    belief was wrong: "a migration that exists as a .sql file has not been
--    applied" — which is true, and cuts both ways. A file cannot tell you it
--    ran, and it cannot tell you it did not.
--
--    scripts/migration-claim-guard.ts now holds this class shut.
-- ═════════════════════════════════════════════════════════════════════════════

-- m498 — cma_comparables cannot record a comp's status or source, so an asking
--        price can only be stored in a column named sale_price.
--
-- CONTEXT
-- -------
-- app/actions/ai-cma.ts now persists the comparables behind every CMA (that
-- write did not exist before: cma_comparables had five production readers and
-- zero production writers). The comps come from lib/cma/ai-cma-orchestrator.ts
-- `runAiCma`, whose required mix is 3 SOLD + 2 ACTIVE + 1 PENDING, and each row
-- carries its own `sourceProvider` and `priceBasis`.
--
-- cma_comparables can hold NONE of that. Its columns are:
--   address, sale_price, list_price, price_per_sqft, bedrooms, bathrooms,
--   square_feet, days_on_market, sale_date, distance_miles, similarity_score,
--   adjustments, adjusted_price, ai_score, ai_rationale, risk_flags,
--   coaching_insight, cma_id, created_at, id
--
-- There is no `status`, no `source_provider`, no `price_basis`. So an ACTIVE
-- listing's ASKING price has exactly one numeric home on this table — a column
-- named `sale_price` — and app/actions/appraisal-defense.ts reads that column,
-- calls the rows "closed comparables" in the argument it prints, and hands the
-- result to a licensed appraiser. Writing an asking price there would be the
-- precise fabrication this wave removed from the valuation path.
--
-- Until these columns exist, app/actions/ai-cma.ts persists CLOSED COMPS ONLY
-- and returns the active/pending rows to the caller in memory. That is correct
-- but lossy: the market-direction half of every CMA is unrecoverable once the
-- request ends, and lib/listing-presentation/section-render.ts and
-- lib/predictive-listing/run-scoring.ts can never show it.
--
-- WHAT THIS MIGRATION DOES
-- ------------------------
-- Adds the three facts a comp row needs to be stored honestly, and backfills
-- every existing row as a closed, provider-sourced sale — which is what every
-- row currently on the table is, since the only writer to date wrote closed
-- comps only.
--
-- NOT APPLIED. Reported for the owner to run.

ALTER TABLE public.cma_comparables
  ADD COLUMN IF NOT EXISTS status text,
  ADD COLUMN IF NOT EXISTS source_provider text,
  ADD COLUMN IF NOT EXISTS price_basis text;

-- Backfill BEFORE the constraints, so the NOT VALID checks below cannot be
-- tripped by rows that predate the columns.
UPDATE public.cma_comparables
   SET status      = COALESCE(status, 'closed'),
       price_basis = COALESCE(price_basis, 'closed_sale');

-- `status` mirrors lib/cma/comp-types.ts ScoredComp.status.
ALTER TABLE public.cma_comparables
  ALTER COLUMN status SET DEFAULT 'closed';

ALTER TABLE public.cma_comparables
  DROP CONSTRAINT IF EXISTS cma_comparables_status_check;
ALTER TABLE public.cma_comparables
  ADD CONSTRAINT cma_comparables_status_check
  CHECK (status IN ('closed', 'pending', 'active'));

-- `price_basis` mirrors lib/cma/comp-types.ts CompPriceBasis. This is the
-- column that makes the distinction ENFORCEABLE rather than conventional: a
-- reader holding one of these rows never has to infer whether the number in
-- front of it is a sale or an ask.
ALTER TABLE public.cma_comparables
  DROP CONSTRAINT IF EXISTS cma_comparables_price_basis_check;
ALTER TABLE public.cma_comparables
  ADD CONSTRAINT cma_comparables_price_basis_check
  CHECK (price_basis IN ('closed_sale', 'list_price'));

-- THE RULE THAT MATTERS, WRITTEN INTO THE TABLE RATHER THAN TRUSTED TO CALLERS.
-- Only a closed sale may carry a closed_sale basis, and only a closed sale may
-- populate sale_price. An active or pending row's number belongs in list_price.
-- lib/cma/comp-provider.ts already refuses to let an AI web search fill a SOLD
-- slot for the same reason; this is that reasoning made structural.
ALTER TABLE public.cma_comparables
  DROP CONSTRAINT IF EXISTS cma_comparables_sale_price_is_a_sale_check;
ALTER TABLE public.cma_comparables
  ADD CONSTRAINT cma_comparables_sale_price_is_a_sale_check
  CHECK (
    (status = 'closed'  AND price_basis = 'closed_sale')
    OR
    (status IN ('pending', 'active') AND price_basis = 'list_price' AND sale_price IS NULL)
  )
  NOT VALID;

-- `source_provider` mirrors lib/cma/comp-types.ts CompProviderId. NULL is
-- permitted and MEANS "this row predates provenance capture" — it is not
-- backfilled to 'rentcast', because guessing the provenance of an existing row
-- is the same class of error as guessing a sale price. 'perplexity' rows are
-- UNVERIFIED and must be labelled wherever they are shown.
ALTER TABLE public.cma_comparables
  DROP CONSTRAINT IF EXISTS cma_comparables_source_provider_check;
ALTER TABLE public.cma_comparables
  ADD CONSTRAINT cma_comparables_source_provider_check
  CHECK (source_provider IS NULL OR source_provider IN ('idxbroker', 'rentcast', 'perplexity', 'none'));

-- An AI-web-search row can never be a closed sale. This is AI_GAP_FILL_SLOTS
-- (lib/cma/comp-provider.ts) enforced by the database: a wrong AI-sourced sale
-- price does not degrade the estimate, it BECOMES the estimate.
ALTER TABLE public.cma_comparables
  DROP CONSTRAINT IF EXISTS cma_comparables_no_ai_sourced_sale_check;
ALTER TABLE public.cma_comparables
  ADD CONSTRAINT cma_comparables_no_ai_sourced_sale_check
  CHECK (NOT (source_provider = 'perplexity' AND status = 'closed'))
  NOT VALID;

-- Readers overwhelmingly want the closed set for a given CMA (the value range,
-- the appraiser packet), which currently means a full scan of the CMA's rows.
CREATE INDEX IF NOT EXISTS cma_comparables_cma_id_status_idx
  ON public.cma_comparables (cma_id, status);

COMMENT ON COLUMN public.cma_comparables.status IS
  'closed | pending | active. Only a closed row is a sale; pending/active carry ASKING prices in list_price and must never be described to a consumer or an appraiser as sales.';
COMMENT ON COLUMN public.cma_comparables.price_basis IS
  'closed_sale | list_price. Which kind of number this row holds, so no reader has to infer it.';
COMMENT ON COLUMN public.cma_comparables.source_provider IS
  'idxbroker | rentcast | perplexity | none. NULL means the row predates provenance capture. A perplexity row is an AI web-search result, is UNVERIFIED, and can never be a closed sale.';
