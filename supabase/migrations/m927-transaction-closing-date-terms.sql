-- WRITTEN, NOT APPLIED (wave 148, lane 148I) — the integrator applies via Supabase MCP; DROP INDEX / DROP COLUMN are owner SQL-editor
--
-- m927 — THE CLOSING-DATE MODEL: the contract's deadline, the anticipated day and the actual day are THREE facts
-- (owner ruling 21, 2026-11-01: "a closing date can also be worded as 'on or before' … lending/title/closing attorney
-- (depends on state) would know best").
--
-- WHAT WAS THERE (audited at ebed6c44 + live 2026-11-01). transactions.close_date carried TWO senses in one column: the
-- offer bridge writes the CONTRACT's scheduled closing at creation (lib/transactions/offer-bridge.ts), and the gated close
-- (lib/transactions/stage-progression.ts) / closeTransactionCommand OVERWRITE it with the day the deal really closed — so
-- after a close the contract's own deadline is gone, and before one nothing distinguishes a deadline from a guess.
-- estimated_close_date (the ANTICIPATED day) is a copy of the same contract date at creation. Nothing recorded HOW the
-- contract words its date ("on" a day vs "on or before" a day), so an earlier closing could not be judged against the
-- contract at all, and the public updateTransaction door could rewrite close_date as if an amendment had been executed.
--
-- SURVIVORS KEPT (extend before replacing, LAW 1): close_date stays the EFFECTIVE closing date every finance / commission /
-- review-ask / scorecard reader uses (unchanged writers, unchanged meaning to them); estimated_close_date stays the
-- ANTICIPATED day. This migration ADDS only what no column carries:
--   contract_closing_date            the executed contract's closing deadline — written from the executed offer when the
--                                    deal is created, changed ONLY by an EXECUTED amendment (never by a proposed early close)
--   contract_closing_terms           how the contract words it: 'on' (that day) | 'on_or_before' (that day or earlier);
--                                    NULL = not yet read from the contract (unknown — never assumed)
--   contract_closing_source          'executed_contract' | 'executed_amendment' — where the deadline came from
--   contract_closing_amendment_ref   the executed amendment's document reference (required when the source is an amendment)
--   actual_close_date                the VERIFIED closing day (the gated close, closeTransactionCommand, the C23 override)
-- Writers: lib/transactions/closing-dates.ts (seedContractClosing — offer bridge; recordActualClosing — the closes) and
-- app/actions/transactions.ts recordClosingDateChange (anticipated vs executed amendment, with proof). Readers:
-- resolveClosingDates (the transaction's closing-dates panel, the unattended-answer facts).
--
-- BACKFILL. The live rows (2 at 2026-11-01, both open) carry the contract date in close_date — copied into
-- contract_closing_date with source 'executed_contract' only where the deal is NOT closed (a closed row's close_date is
-- already the actual day and the contract date is unrecoverable from this column; those stay NULL — honest).
--
-- AFTER APPLYING: regenerate scripts/schema-snapshot.ts, scripts/check-vocabularies.ts (two CHECKs:
-- transactions.contract_closing_terms, transactions.contract_closing_source), scripts/live-tables.ts (unchanged tables).

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS contract_closing_date date,
  ADD COLUMN IF NOT EXISTS contract_closing_terms text,
  ADD COLUMN IF NOT EXISTS contract_closing_source text,
  ADD COLUMN IF NOT EXISTS contract_closing_amendment_ref text,
  ADD COLUMN IF NOT EXISTS actual_close_date date;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_contract_closing_terms_check') THEN
    ALTER TABLE public.transactions ADD CONSTRAINT transactions_contract_closing_terms_check
      CHECK (contract_closing_terms IS NULL OR contract_closing_terms = ANY (ARRAY['on'::text, 'on_or_before'::text]));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_contract_closing_source_check') THEN
    ALTER TABLE public.transactions ADD CONSTRAINT transactions_contract_closing_source_check
      CHECK (contract_closing_source IS NULL OR contract_closing_source = ANY (ARRAY['executed_contract'::text, 'executed_amendment'::text]));
  END IF;
  -- An amended deadline names the executed amendment that set it.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_contract_closing_amendment_ref_required') THEN
    ALTER TABLE public.transactions ADD CONSTRAINT transactions_contract_closing_amendment_ref_required
      CHECK (contract_closing_source IS DISTINCT FROM 'executed_amendment' OR (contract_closing_amendment_ref IS NOT NULL AND length(btrim(contract_closing_amendment_ref)) >= 3));
  END IF;
END $$;

COMMENT ON COLUMN public.transactions.contract_closing_date IS 'm927 — the executed contract''s closing deadline; changed only by an executed amendment (lib/transactions/closing-dates.ts).';
COMMENT ON COLUMN public.transactions.contract_closing_terms IS 'm927 — how the contract words the closing date: on | on_or_before; NULL = not yet read (unknown).';
COMMENT ON COLUMN public.transactions.actual_close_date IS 'm927 — the verified closing day (gated close / closeTransactionCommand / C23 override).';

-- Backfill: open deals only (see header).
UPDATE public.transactions
   SET contract_closing_date = close_date, contract_closing_source = 'executed_contract'
 WHERE contract_closing_date IS NULL AND close_date IS NOT NULL
   AND status NOT IN ('closed', 'funded', 'lost', 'archived');

-- VERIFY:
--   select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.transactions'::regclass
--     and conname like 'transactions_contract_closing%';
--   select count(*) filter (where contract_closing_date is not null) as seeded, count(*) from public.transactions;
-- ROLLBACK (owner SQL editor — DROP COLUMN):
--   alter table public.transactions drop constraint if exists transactions_contract_closing_amendment_ref_required,
--     drop constraint if exists transactions_contract_closing_source_check, drop constraint if exists transactions_contract_closing_terms_check,
--     drop column if exists actual_close_date, drop column if exists contract_closing_amendment_ref,
--     drop column if exists contract_closing_source, drop column if exists contract_closing_terms, drop column if exists contract_closing_date;
