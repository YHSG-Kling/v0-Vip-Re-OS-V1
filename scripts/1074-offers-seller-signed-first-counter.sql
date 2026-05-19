-- ============================================================================
-- Migration 1074 — offers: seller-signed-first columns for counter flow
-- ============================================================================
--
-- WHY:
--   Counters are seller-initiated: the seller signs first, then sends the
--   counter to the buyer's agent. When the buyer signs, the counter is
--   FULLY EXECUTED (no separate "seller signs back" step).
--
--   Until now the schema only had buyer_signed_at + seller_response_*
--   columns geared toward the buyer-first sequence. For counters we need
--   to capture WHEN the seller signed + the seller-signed document URL,
--   so the buyer-signing webhook can detect "both sides have signed" and
--   flip esign_status to 'fully_signed' in one shot.
-- ============================================================================

ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS seller_signed_at            timestamp with time zone,
  ADD COLUMN IF NOT EXISTS seller_signed_document_url  text;

CREATE INDEX IF NOT EXISTS offers_seller_signed_buyer_pending_idx
  ON public.offers (provider_envelope_id)
  WHERE seller_signed_at IS NOT NULL AND buyer_signed_at IS NULL;
