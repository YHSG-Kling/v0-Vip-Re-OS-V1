-- ============================================================================
-- Migration 1075 — Counter checkbox on parent offer + universal document
--                  classification + summarization columns
-- ============================================================================

ALTER TABLE public.offers
  ADD COLUMN IF NOT EXISTS has_counter boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS offers_has_counter_idx
  ON public.offers (has_counter)
  WHERE has_counter = true;

ALTER TABLE public.documents
  ADD COLUMN IF NOT EXISTS classification     text,
  ADD COLUMN IF NOT EXISTS classification_confidence text,
  ADD COLUMN IF NOT EXISTS summary            text,
  ADD COLUMN IF NOT EXISTS extracted_fields   jsonb DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS scanned_at         timestamp with time zone,
  ADD COLUMN IF NOT EXISTS scan_error         text;

ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS documents_classification_check;
ALTER TABLE public.documents ADD CONSTRAINT documents_classification_check
  CHECK (
    classification IS NULL OR classification = ANY (ARRAY[
      'pre_approval_letter','proof_of_funds','id_document','signed_contract',
      'counter_offer','addendum','disclosure','inspection_report',
      'appraisal_report','title_report','hoa_documents','closing_disclosure',
      'wire_instructions','agency_disclosure','commission_agreement',
      'lender_letter','other'
    ])
  );

ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS documents_classification_confidence_check;
ALTER TABLE public.documents ADD CONSTRAINT documents_classification_confidence_check
  CHECK (
    classification_confidence IS NULL OR classification_confidence = ANY (ARRAY['high','medium','low'])
  );

CREATE INDEX IF NOT EXISTS documents_classification_idx
  ON public.documents (brokerage_id, classification)
  WHERE classification IS NOT NULL;

CREATE INDEX IF NOT EXISTS documents_unscanned_idx
  ON public.documents (brokerage_id, created_at)
  WHERE scanned_at IS NULL;
