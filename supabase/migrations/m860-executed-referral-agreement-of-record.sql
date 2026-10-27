-- ── APPLIED LIVE 2026-10-27 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 145, lane 145C; a DROP TRIGGER / DROP POLICY IF EXISTS of an object that did not yet exist was skipped where the MCP would have held the batch ──
--
-- m860 — A REFERRAL PAYOUT NEEDS AN EXECUTED REFERRAL AGREEMENT ON RECORD (wave 145, lane 145C).
--
-- Owner ruling 9 (2026-10-27), verbatim: "There will be agreed and executed referral agreements if a brokerage needs to pay
-- the referral on a transaction." — a referral payout requires an executed referral agreement on record, whether the
-- referring party is an inside agent or an outside partner.
--
-- AUDIT FIRST (CLAUDE.md §1) — measured live 2026-10-27 and in code at b364eb4b:
--   · referrals: referral_fee_pct (the agreed percent — m812/143C made it the fee term), transaction_id (m812, the CAS link),
--     partner_id. NO pointer to any executed agreement: an inside referral pays on a percent typed into the row. 0 rows live.
--   · referral_partners: agreement_type (reciprocal | one_way | paid | informal — 'informal' is literally "no paper"),
--     agreement_date, agreement_end_date, commission_split_percentage, referral_fee_flat. A DATE of an agreement, never the
--     executed agreement itself. 0 rows live.
--   · documents is THE stored-paper survivor (brokerage_id, classification, signature_completeness, storage_url) — the same
--     one contract_term_versions.document_id cites for an executed addendum. No new document store is created here.
--   · The payout rule is lib/commission/referral-payout.ts pickReferralForDeal (stage 03b). VERDICT: PARTIAL — the rule pays
--     without asking for the agreement; this adds the record it asks for and the rule now HOLDS a final without it.
--
-- WHAT THIS ADDS (additive, inert for existing rows):
--   referrals          + referral_agreement_document_id (FK documents, NO ACTION — the executed agreement is retained)
--                      + referral_agreement_executed_on (date the agreement was fully executed, as printed on it)
--                      + referral_agreement_recorded_by (FK users, ON DELETE SET NULL) + referral_agreement_recorded_at
--                      CHECK: the document and its executed date are recorded together (both or neither).
--   referral_partners  + agreement_document_id (FK documents, NO ACTION) — a partner's STANDING executed referral agreement;
--                        agreement_date / agreement_end_date (existing) bound the window it governs.
--                      + agreement_recorded_by (FK users, ON DELETE SET NULL) + agreement_recorded_at.
--   A trigger refuses a document from another brokerage on either table (the document is the tenant's own paper).
--
-- AFTER APPLYING: regenerate scripts/schema-snapshot.ts (referrals +4, referral_partners +3) and scripts/schema-fk-map.ts
-- (+5 FKs). No IN-list CHECK, so scripts/check-vocabularies.ts is unchanged. Flip line 1.

ALTER TABLE public.referrals
  ADD COLUMN IF NOT EXISTS referral_agreement_document_id uuid        NULL REFERENCES public.documents(id),
  ADD COLUMN IF NOT EXISTS referral_agreement_executed_on date        NULL,
  ADD COLUMN IF NOT EXISTS referral_agreement_recorded_by uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS referral_agreement_recorded_at timestamptz NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'referrals_agreement_document_and_date') THEN
    ALTER TABLE public.referrals
      ADD CONSTRAINT referrals_agreement_document_and_date
      CHECK ((referral_agreement_document_id IS NULL) = (referral_agreement_executed_on IS NULL));
  END IF;
END $$;

COMMENT ON COLUMN public.referrals.referral_agreement_document_id IS
  'm860 (wave 145, lane 145C — owner ruling 9): the EXECUTED referral agreement for this referral (documents). lib/commission/referral-payout.ts pays a referral fee only when this (or, for an outside partner, the partner''s standing executed agreement in force on the deal''s date) is on record; otherwise a FINAL calculation holds by name.';

ALTER TABLE public.referral_partners
  ADD COLUMN IF NOT EXISTS agreement_document_id uuid        NULL REFERENCES public.documents(id),
  ADD COLUMN IF NOT EXISTS agreement_recorded_by uuid        NULL REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS agreement_recorded_at timestamptz NULL;

COMMENT ON COLUMN public.referral_partners.agreement_document_id IS
  'm860: the partner''s STANDING executed referral agreement (documents); agreement_date / agreement_end_date bound the window it governs. An agreement_type of informal with no document never authorizes a payout (owner ruling 9).';

CREATE INDEX IF NOT EXISTS referrals_agreement_document_idx ON public.referrals (referral_agreement_document_id) WHERE referral_agreement_document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS referral_partners_agreement_document_idx ON public.referral_partners (agreement_document_id) WHERE agreement_document_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.referral_agreement_document_in_tenant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_doc_id uuid;
  v_doc_brokerage uuid;
BEGIN
  IF TG_TABLE_NAME = 'referrals' THEN
    v_doc_id := NEW.referral_agreement_document_id;
  ELSE
    v_doc_id := NEW.agreement_document_id;
  END IF;
  IF v_doc_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT brokerage_id INTO v_doc_brokerage FROM public.documents WHERE id = v_doc_id;
  IF v_doc_brokerage IS DISTINCT FROM NEW.brokerage_id THEN
    RAISE EXCEPTION '%: the referral agreement document % is not in brokerage %', TG_TABLE_NAME, v_doc_id, NEW.brokerage_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS referrals_agreement_document_in_tenant ON public.referrals;
CREATE TRIGGER referrals_agreement_document_in_tenant
  BEFORE INSERT OR UPDATE OF referral_agreement_document_id, brokerage_id ON public.referrals
  FOR EACH ROW EXECUTE FUNCTION public.referral_agreement_document_in_tenant();

DROP TRIGGER IF EXISTS referral_partners_agreement_document_in_tenant ON public.referral_partners;
CREATE TRIGGER referral_partners_agreement_document_in_tenant
  BEFORE INSERT OR UPDATE OF agreement_document_id, brokerage_id ON public.referral_partners
  FOR EACH ROW EXECUTE FUNCTION public.referral_agreement_document_in_tenant();

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'referrals' AND column_name = 'referral_agreement_document_id') THEN
    RAISE EXCEPTION 'm860 postcondition: referrals.referral_agreement_document_id missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'referral_partners' AND column_name = 'agreement_document_id') THEN
    RAISE EXCEPTION 'm860 postcondition: referral_partners.agreement_document_id missing';
  END IF;
END $$;
