-- ── APPLIED LIVE 2026-10-27 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 145, lane 145Z ──
--
-- m873 — THE DEAL'S TAX-PRORATION INSTRUCTION (wave 145, lane 145C requirement 7 "proration input screen"; lane 145Z builds it)
--
-- Wave 144D made the property-tax proration deterministic with EVERY convention an input
-- (lib/offers/seller-closing-costs.ts TaxProrationInput: annualTax, periodStart, timing, closeDate, closingDayOwner,
-- dayBasis, source) and refused to default any of them ("never hard-code one state's rule for all"). Nothing captured
-- the settlement agent's instruction per deal, so the proration line was PENDING on every deal. Lane 145C left the
-- storage choice to the building lane: a transactions jsonb, or a versioned contract_term_versions term. A term version
-- is the wrong home — contract_term_versions.source admits only addendum / amendment / counter / offer, and a
-- settlement agent's proration instruction is none of them (writing it as an "addendum" would be a false record).
--
--   · transactions.tax_proration  — the instruction as the TC / agent recorded it from the settlement agent:
--       { annualTax, periodStart, timing, closeDate, closingDayOwner, dayBasis, source, recorded_by, recorded_at }
--     The ONE writer and reader: lib/transactions/tax-proration.ts (validated there — every term required, the source
--     required, no jurisdiction default). NULL = no instruction yet (the line stays pending, the missing terms named).
--
-- CHECK: an object when present (a string, array or scalar can never land here). The keys are validated in code, not
-- pinned by an IN-list: the vocabularies (arrears/advance, buyer/seller, actual_365/actual_actual/banker_360) are the
-- pure engine's types and the guard holds the writer to them.
--
-- MEASURED BEFORE WRITING (scripts/schema-snapshot.ts, 2026-10-27): transactions has no proration column.
--
-- SAFE IN EITHER ORDER: the code writes the column ONLY in its own UPDATE and reads it ONLY through a star select, and
-- treats 42703 / PGRST204 as the column-absent reading (the code's own notApplied message) (said on the card) — no transaction read or write is refused for it.
--
-- AFTER APPLYING: regenerate scripts/schema-snapshot.ts (transactions +1). The CHECK is a type CHECK, not an IN-list, so
-- scripts/check-vocabularies.ts does not change (read it back to confirm).

ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS tax_proration jsonb NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_tax_proration_is_object') THEN
    ALTER TABLE public.transactions ADD CONSTRAINT transactions_tax_proration_is_object
      CHECK (tax_proration IS NULL OR jsonb_typeof(tax_proration) = 'object');
  END IF;
END $$;

COMMENT ON COLUMN public.transactions.tax_proration IS
  'The settlement agent''s property-tax proration instruction for this deal (annualTax, periodStart, timing, closeDate, closingDayOwner, dayBasis, source, recorded_by, recorded_at). Written and read only by lib/transactions/tax-proration.ts; feeds estimateSellerClosingCosts({ taxProration }). NULL = no instruction (the line stays pending). Wave 145, m873.';

-- VERIFY (read back):
--   SELECT column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_schema = 'public' AND table_name = 'transactions' AND column_name = 'tax_proration';
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'transactions_tax_proration_is_object';
