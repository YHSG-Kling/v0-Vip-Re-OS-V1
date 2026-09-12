-- m505 — state_appraiser_adjustment_rates COULD NOT STORE THE OWNER'S RULING.
--
-- OWNER, VERBATIM: "we use the current years state appraiser guidelines for
-- adjustments."
--
-- That sentence had no implementation and, more seriously, no STORAGE. Two
-- separate facts, and the second is why the first was never a small fix:
--
--   1. THE COLUMN WAS NEVER READ. `effective_year` has been on this table since
--      1006-state-appraiser-adjustment-rates.sql created it. Nothing has ever
--      selected it. lib/cma/state-adjustment-rates.ts filtered on `state` alone,
--      so every CMA this product has produced was priced with whatever vintage
--      happened to be sitting in the table — and all 39 live rows are 2024. The
--      report never said which year it was quoting, and an unstated basis is
--      read as a current one. In 2027 it would still have been 2024.
--
--   2. THE KEY COULD NOT HOLD TWO VINTAGES. UNIQUE (state, adjustment_type,
--      rate_basis) admits exactly ONE row per rate, forever. Seeding a 2026
--      FL waterfront rate beside the 2024 one was not merely undone — it was
--      REJECTED BY THE DATABASE. The only way to "update to the current year"
--      was to overwrite the old row, which destroys the ability of any CMA
--      already on file to say what priced it. The owner's requirement was
--      literally unstorable, which is why this is a schema change and not a
--      one-line select.
--
-- ── WHAT CHANGES ────────────────────────────────────────────────────────────
--
-- (1) THE UNIQUE KEY GAINS effective_year, so vintages COEXIST. A rate is now
--     identified by what it prices AND when it was published. Adding next
--     year's table becomes an INSERT, never an overwrite, and last year's rows
--     stay readable so a CMA generated under them can still be reconstructed.
--
-- (2) effective_year BECOMES NOT NULL AND LOSES ITS DEFAULT. Both halves matter
--     and the default is the more dangerous one. `DEFAULT 2024` means any future
--     seeder who forgets the column silently files new guidance under 2024 —
--     re-creating this exact defect with fresh numbers wearing a stale year. A
--     rate that cannot name its year is not a published guideline, so the column
--     is now a required statement rather than something the table guesses.
--     (Verified before writing: 39 rows, zero NULLs, so NOT NULL validates.)
--
-- (3) AN INDEX FOR THE RESOLVER'S ACTUAL QUERY. The reader asks
--     `state IN (:st,'US') AND effective_year <= :year`; the only indexes were
--     on (state) and (state, adjustment_type).
--
-- ── WHAT DELIBERATELY DOES NOT CHANGE: NO 2026 ROWS ARE SEEDED ──────────────
--
-- This migration inserts NOTHING. That is the honest half of the fix and it was
-- the tempting one to get wrong.
--
-- The obvious "completion" here is to copy the 39 rows, stamp them 2026, and
-- report the ruling satisfied. That would be a FABRICATION — not a stale number,
-- an INVENTED one, because a row stamped 2026 asserts that a state appraiser
-- board published those figures for 2026, and no such publication was consulted.
-- The number then appears on a document a seller sets a list price from and an
-- appraiser reads, wearing a year that certifies it.
--
-- So the 2024 rows are carried forward AS THEMSELVES. They keep effective_year
-- 2024, the resolver takes the most recent vintage AT OR BEFORE the CMA's own
-- year, and every surface says which vintage it used and that it is not the
-- current one: lib/cma/state-adjustment-rates.ts `vintageNote`, the narrative
-- prompt's hard rule, the seller-facing disclaimer ("THE ADJUSTMENT RATES IN
-- THIS REPORT ARE NOT <year> RATES"), and `rateEffectiveYear` on every line
-- persisted to cma_price_adjustments. A stale rate labelled stale is honest; a
-- stale rate relabelled current is not.
--
-- WHAT REMAINS OPEN, and it is a sourcing task rather than a code one: real
-- current-year figures from the state boards have to be obtained and inserted.
-- After this migration that is a pure INSERT — no schema decision, no overwrite,
-- and no code change, because the resolver picks up a newer vintage the moment
-- one exists.

-- ── 1 · vintages may coexist ────────────────────────────────────────────────
ALTER TABLE public.state_appraiser_adjustment_rates
  DROP CONSTRAINT IF EXISTS state_appraiser_adjustment_ra_state_adjustment_type_rate_ba_key;

ALTER TABLE public.state_appraiser_adjustment_rates
  ADD CONSTRAINT state_appraiser_adjustment_rates_state_type_basis_year_key
  UNIQUE (state, adjustment_type, rate_basis, effective_year);

-- ── 2 · a rate must name its year ───────────────────────────────────────────
UPDATE public.state_appraiser_adjustment_rates
  SET effective_year = 2024
  WHERE effective_year IS NULL;

ALTER TABLE public.state_appraiser_adjustment_rates
  ALTER COLUMN effective_year SET NOT NULL;

ALTER TABLE public.state_appraiser_adjustment_rates
  ALTER COLUMN effective_year DROP DEFAULT;

-- ── 3 · the resolver's read ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_state_adjustment_rates_state_year
  ON public.state_appraiser_adjustment_rates (state, effective_year);

COMMENT ON COLUMN public.state_appraiser_adjustment_rates.effective_year IS
  'The year of the published state appraiser guidance THIS row states. Part of the unique key: vintages coexist, so a new year is an INSERT and never an overwrite. NOT NULL with no default on purpose — a defaulted year silently files new guidance under an old one, which is the defect m505 closes. Readers resolve the most recent vintage AT OR BEFORE the CMA''s own effective year (lib/cma/state-adjustment-rates.ts getStateAdjustmentRates) and REPORT which vintage they used; never re-date a row to make it look current.';

COMMENT ON TABLE public.state_appraiser_adjustment_rates IS
  'Per-state, per-feature sales-comparison adjustment rates, VERSIONED BY effective_year. Seeded reference data (no runtime writer). Owner ruling: "we use the current years state appraiser guidelines for adjustments" — implemented as a most-recent-vintage-at-or-before-the-CMA-year resolution that names the vintage on the report rather than assuming the newest row is current.';
