-- ── APPLIED LIVE 2026-10-27 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 145, lane 145C; a DROP TRIGGER / DROP POLICY IF EXISTS of an object that did not yet exist was skipped where the MCP would have held the batch ──
--
-- m861 — AN AGENT CONCESSION PROMISED ON AN OFFER, BEFORE ANY TRANSACTION EXISTS (wave 145, lane 145C; closes lane 144D
-- Still open "pre-contract concessions" and lane 144C Still open 1).
--
-- AUDIT (live 2026-10-27, project hrvaqgvukzxfskkcrwbt): commission_adjustments.transaction_id is NOT NULL (FK transactions
-- ON DELETE CASCADE), so the ONE concession record (lib/commission/agent-concession.ts, m850) could only be opened AFTER the
-- contract had already committed the credit — the inversion of owner ruling 4 ("ask permission FIRST … block unauthorized
-- commitment"). 0 rows live. No other store of a pre-contract concession exists (offers carry no concession column or key).
--
-- CHANGE: + offer_id (FK offers, NO ACTION — an offer with a concession record is not deleted out from under it);
-- transaction_id becomes NULLABLE (ALTER COLUMN … DROP NOT NULL — not a DROP COLUMN); CHECK commission_adjustments_anchor_check:
-- a row names a transaction OR an offer (never neither). At promotion (offer → transaction) the chain's offer-anchored rows are
-- RE-POINTED to the new transaction by a counted UPDATE (lib/offers/governing-terms.ts freezeExecutedTermsAfterPromotion →
-- lib/commission/agent-concession.ts anchorOfferConcessionsToTransaction); offer_id stays as provenance. A trigger keeps the
-- offer in the row's brokerage. Every existing reader filters by transaction_id, so a row that has no transaction yet is
-- invisible to the commission engine until promotion — and stage 03 holds a FINAL on any still-requested concession.
--
-- NOT HERE — the financing subtype (lane 144A Still open 3). The decision is a TYPED column on offers + transactions (carried by
-- CONTRACT_TERM_COLUMNS, admitted by the brokerage's adaptive vocabulary like m847), NOT offers.metadata — but creating it now
-- would add two columns with no writer and no reader (the offer-intake writers and the checklist reader are other lanes'
-- files), which is the writerless-column defect schema-drift exists to stop. The exact DDL and wiring are in the lane notes
-- (Still open / Outside-lane) for the lane that owns the writer to land with it.
--
-- AFTER APPLYING: regenerate scripts/schema-snapshot.ts (commission_adjustments +offer_id), scripts/schema-fk-map.ts (+1 FK
-- commission_adjustments.offer_id → offers). No IN-list CHECK, so scripts/check-vocabularies.ts is unchanged. Flip line 1.

ALTER TABLE public.commission_adjustments
  ADD COLUMN IF NOT EXISTS offer_id uuid NULL REFERENCES public.offers(id);

ALTER TABLE public.commission_adjustments
  ALTER COLUMN transaction_id DROP NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commission_adjustments_anchor_check') THEN
    ALTER TABLE public.commission_adjustments
      ADD CONSTRAINT commission_adjustments_anchor_check CHECK (transaction_id IS NOT NULL OR offer_id IS NOT NULL);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS commission_adjustments_offer_idx
  ON public.commission_adjustments (brokerage_id, offer_id) WHERE offer_id IS NOT NULL;

COMMENT ON COLUMN public.commission_adjustments.offer_id IS
  'm861 (wave 145, lane 145C — owner ruling 4): the OFFER an agent concession was requested on before a transaction existed. Re-pointed to the transaction at promotion (transaction_id set; offer_id kept as provenance). CHECK commission_adjustments_anchor_check: transaction OR offer.';

CREATE OR REPLACE FUNCTION public.commission_adjustments_offer_in_tenant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_brokerage uuid;
BEGIN
  IF NEW.offer_id IS NULL THEN
    RETURN NEW;
  END IF;
  SELECT brokerage_id INTO v_brokerage FROM public.offers WHERE id = NEW.offer_id;
  IF v_brokerage IS DISTINCT FROM NEW.brokerage_id THEN
    RAISE EXCEPTION 'commission_adjustments %: offer % is not in brokerage %', NEW.id, NEW.offer_id, NEW.brokerage_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS commission_adjustments_offer_in_tenant ON public.commission_adjustments;
CREATE TRIGGER commission_adjustments_offer_in_tenant
  BEFORE INSERT OR UPDATE OF offer_id, brokerage_id ON public.commission_adjustments
  FOR EACH ROW EXECUTE FUNCTION public.commission_adjustments_offer_in_tenant();

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'commission_adjustments_anchor_check') THEN
    RAISE EXCEPTION 'm861 postcondition: commission_adjustments_anchor_check missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'commission_adjustments' AND column_name = 'offer_id') THEN
    RAISE EXCEPTION 'm861 postcondition: commission_adjustments.offer_id missing';
  END IF;
END $$;
