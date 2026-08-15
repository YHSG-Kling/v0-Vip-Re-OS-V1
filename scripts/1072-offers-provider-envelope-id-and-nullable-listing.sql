-- ============================================================================
-- Migration 1072 — offers.provider_envelope_id + nullable listing_id
-- ============================================================================
--
-- WHY:
--   1. Webhook lookup by envelope id was broken because the only column on
--      offers that came close was esign_provider, which is the platform NAME
--      ("dotloop"/"docusign"/...) not the envelope id. We add a real
--      provider_envelope_id text column + index for the finalize-packet
--      helper to match against.
--
--   2. offers.listing_id was NOT NULL. The voice cockpit stages offers for
--      properties that may not be in our listings table (FSBO, external MLS
--      properties, etc.). Making listing_id nullable lets the voice path
--      write an offers row immediately while still supporting in-house
--      listings (when known).
-- ============================================================================

ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS provider_envelope_id text;

CREATE INDEX IF NOT EXISTS offers_provider_envelope_id_idx
  ON public.offers (provider_envelope_id)
  WHERE provider_envelope_id IS NOT NULL;

ALTER TABLE public.offers ALTER COLUMN listing_id DROP NOT NULL;
