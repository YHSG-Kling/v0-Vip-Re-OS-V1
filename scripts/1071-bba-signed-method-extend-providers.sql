-- ============================================================================
-- Migration 1071 — Extend buyer_broker_agreements.signed_method allowed values
-- ============================================================================
--
-- WHY:
--   The CHECK constraint allowed only docusign / wet_signature / click_through
--   / dotloop. The voice cockpit + esign webhook helpers now record the e-sign
--   provider that finalized the BBA, which can also be 'skyslope' or
--   'authentisign'. Without this extension, the helper update would fail at
--   runtime for those two providers.
-- ============================================================================

ALTER TABLE public.buyer_broker_agreements DROP CONSTRAINT IF EXISTS buyer_broker_agreements_signed_method_check;
ALTER TABLE public.buyer_broker_agreements ADD CONSTRAINT buyer_broker_agreements_signed_method_check
  CHECK (signed_method = ANY (ARRAY[
    'docusign',
    'dotloop',
    'skyslope',
    'authentisign',
    'wet_signature',
    'click_through'
  ]));
