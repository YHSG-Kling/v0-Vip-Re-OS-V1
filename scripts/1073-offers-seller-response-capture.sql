-- ============================================================================
-- Migration 1073 — offers: capture seller response + agent-readiness for
-- compliance review
-- ============================================================================
--
-- WHY:
--   Buyer-only signature ≠ executed contract. After the buyer signs:
--     1. Agent forwards to listing agent (external) or seller agent (in-house)
--     2. Seller responds — accepted (signs back) | countered | rejected
--     3. Agent uploads the seller-signed contract OR a seller-signed PDF is
--        ingested from inbound email
--     4. Agent reviews the now-executed contract
--     5. Agent EXPLICITLY signals "submit to compliance" — only then does
--        the chain advance to compliance.passed → ACCEPTED → transaction
--        auto-create
--
--   The schema previously had no way to capture (3) or gate (4)/(5).
--
-- WHAT:
--   - seller_response_received_at        : timestamp seller responded
--   - seller_response_type               : accepted | countered | rejected
--   - seller_response_document_url       : storage URL for the seller-signed
--                                          contract or counter PDF
--   - fully_signed_contract_received_at  : when the agent has the executed
--                                          contract in hand (both parties signed)
--   - ready_for_compliance_at            : timestamp agent clicked
--                                          "submit to compliance" — gate for
--                                          the transaction auto-create chain
-- ============================================================================

ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS seller_response_received_at         timestamp with time zone,
  ADD COLUMN IF NOT EXISTS seller_response_type                text,
  ADD COLUMN IF NOT EXISTS seller_response_document_url        text,
  ADD COLUMN IF NOT EXISTS fully_signed_contract_received_at   timestamp with time zone,
  ADD COLUMN IF NOT EXISTS ready_for_compliance_at             timestamp with time zone;

ALTER TABLE public.offers DROP CONSTRAINT IF EXISTS offers_seller_response_type_check;
ALTER TABLE public.offers ADD CONSTRAINT offers_seller_response_type_check
  CHECK (
    seller_response_type IS NULL
    OR seller_response_type = ANY (ARRAY['accepted'::text, 'countered'::text, 'rejected'::text])
  );

CREATE INDEX IF NOT EXISTS offers_ready_for_compliance_idx
  ON public.offers (brokerage_id, ready_for_compliance_at)
  WHERE ready_for_compliance_at IS NOT NULL AND compliance_passed_at IS NULL;
