-- ── APPLIED LIVE 2026-10-27 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 145, lane 145Z ──
--
-- m871 — THE FINANCING SUBTYPE IS A TYPED COLUMN (wave 145, lane 145C requirement 7 decided it; lane 145Z writes it)
--
-- Wave 144A made ONE financing-type list (lib/compliance/checklist-dimensions.ts FINANCING_TYPES) and let a brokerage add
-- its own terms through the adaptive vocabulary (m847): a brokerage term ROLLS UP to one platform key, and the columns
-- that platform-only code reads (offers.financing_type / transactions.financing_type — offer strength, the
-- government-loan amendatory addendum, financingKindFor) store the roll-up. `vocabularyWriteValue("financing_type", …)`
-- hands back the brokerage's own term as `subtype` — and NO column held it, so "FHA 203(k)" was written as `fha` and the
-- 203(k) was lost (lane 144A Still open 3). Lane 145C decided a typed column over offers.metadata.financing_subtype.
--
--   · offers.financing_subtype        — the brokerage term the offer was written with (NULL = a platform type, or unknown)
--   · transactions.financing_subtype  — the same term, carried 1:1 by the offer → transaction bridge
--                                        (lib/transactions/offer-bridge.ts, through lib/offers/financing-subtype.ts)
--
-- NO IN-LIST CHECK: the tenant's adaptive vocabulary admits the values (a brokerage's approved term is valid in that
-- brokerage only). The FORMAT CHECK below holds the column to the vocabulary's own key shape
-- (lib/compliance/adaptive-vocabulary.ts KEY_RE = ^[a-z][a-z0-9_]{1,47}$), so a label or free text can never land here.
--
-- MEASURED BEFORE WRITING (scripts/schema-snapshot.ts, 2026-10-27): neither table has a financing_subtype column; no
-- CHECK pins offers.financing_type or transactions.financing_type (scripts/check-vocabularies.ts).
--
-- SAFE IN EITHER ORDER: the code writes the column ONLY in its own UPDATE (never inside the offer/transaction INSERT
-- or a SELECT list), and reads it ONLY through lib/offers/financing-subtype.ts, which treats 42703 / PGRST204 as
-- "m871 not applied" — the offer and the transaction are written either way.
--
-- AFTER APPLYING: regenerate scripts/schema-snapshot.ts (offers +1, transactions +1). The CHECKs are format CHECKs,
-- not IN-lists, so scripts/check-vocabularies.ts does not change (read it back to confirm).

ALTER TABLE public.offers ADD COLUMN IF NOT EXISTS financing_subtype text NULL;
ALTER TABLE public.transactions ADD COLUMN IF NOT EXISTS financing_subtype text NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offers_financing_subtype_key_format') THEN
    ALTER TABLE public.offers ADD CONSTRAINT offers_financing_subtype_key_format
      CHECK (financing_subtype IS NULL OR financing_subtype ~ '^[a-z][a-z0-9_]{1,47}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'transactions_financing_subtype_key_format') THEN
    ALTER TABLE public.transactions ADD CONSTRAINT transactions_financing_subtype_key_format
      CHECK (financing_subtype IS NULL OR financing_subtype ~ '^[a-z][a-z0-9_]{1,47}$');
  END IF;
END $$;

COMMENT ON COLUMN public.offers.financing_subtype IS
  'The brokerage''s own financing term (adaptive vocabulary key, m847) the offer was written with; financing_type holds its platform roll-up. NULL = a platform type or unknown. Written by lib/offers/financing-subtype.ts (wave 145, m871).';
COMMENT ON COLUMN public.transactions.financing_subtype IS
  'The brokerage financing term carried 1:1 from the accepted offer (lib/transactions/offer-bridge.ts); financing_type holds the platform roll-up (wave 145, m871).';

-- VERIFY (read back):
--   SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
--    WHERE table_schema = 'public' AND column_name = 'financing_subtype' AND table_name IN ('offers', 'transactions');
--   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--    WHERE conname IN ('offers_financing_subtype_key_format', 'transactions_financing_subtype_key_format');
