-- ============================================================================
-- Migration 1066 — Buyer-side commission disclosure pre-offer gate (NAR 2024)
-- ============================================================================
--
-- WHY:
--   NAR 2024 settlement requires the BUYER to acknowledge the exact
--   compensation their agent will receive BEFORE the offer is submitted.
--   This is separate from the BBA (Commit H) — BBA establishes representation;
--   the disclosure is per-offer because the seller's offered compensation can
--   differ from what the BBA stipulates.
--
--   Exposure: $2,500–$10,000 per offer + reputational + listing-agent disputes
--   if compensation terms are unclear at submission time.
--
-- WHAT:
--   Adds offer-level disclosure fields to offers table:
--     - buyer_commission_acknowledged_at + acknowledged_by_ip + acknowledged_by_ua
--     - disclosed_buyer_commission_pct / disclosed_buyer_commission_flat
--     - disclosed_commission_payer
--     - disclosed_commission_notes
--     - commission_disclosure_method (click_through | wet_signature | docusign)
--
--   Gates createBuyerOffer to require the acknowledgment field is set.
-- ============================================================================

BEGIN;

ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS buyer_commission_acknowledged_at  timestamptz,
  ADD COLUMN IF NOT EXISTS buyer_commission_acknowledged_ip  text,
  ADD COLUMN IF NOT EXISTS buyer_commission_acknowledged_ua  text,
  ADD COLUMN IF NOT EXISTS disclosed_buyer_commission_pct    numeric(5,2),
  ADD COLUMN IF NOT EXISTS disclosed_buyer_commission_flat   numeric(12,2),
  ADD COLUMN IF NOT EXISTS disclosed_commission_payer        text,
  ADD COLUMN IF NOT EXISTS disclosed_commission_notes        text,
  ADD COLUMN IF NOT EXISTS commission_disclosure_method      text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='offers_disclosed_payer_check') THEN
    ALTER TABLE public.offers ADD CONSTRAINT offers_disclosed_payer_check
      CHECK (disclosed_commission_payer IS NULL
             OR disclosed_commission_payer IN ('seller','buyer','split','either'));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='offers_disclosure_method_check') THEN
    ALTER TABLE public.offers ADD CONSTRAINT offers_disclosure_method_check
      CHECK (commission_disclosure_method IS NULL
             OR commission_disclosure_method IN ('click_through','wet_signature','docusign','dotloop'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_offers_commission_acknowledged
  ON public.offers(buyer_commission_acknowledged_at) WHERE buyer_commission_acknowledged_at IS NOT NULL;

COMMIT;
