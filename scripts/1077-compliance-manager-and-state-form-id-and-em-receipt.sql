-- ============================================================================
-- Migration 1077 — compliance_manager + state_form_id + earnest_money_receipt
-- ============================================================================

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_user_type_check;
ALTER TABLE public.users ADD CONSTRAINT users_user_type_check
  CHECK (user_type = ANY (ARRAY[
    'broker','admin','agent','vendor','lender','TC',
    'compliance_officer','compliance_manager','contact','team_lead'
  ]));

ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS state_form_id text;
CREATE INDEX IF NOT EXISTS documents_state_form_id_idx
  ON public.documents (state_form_id) WHERE state_form_id IS NOT NULL;

ALTER TABLE public.documents DROP CONSTRAINT IF EXISTS documents_classification_check;
ALTER TABLE public.documents ADD CONSTRAINT documents_classification_check
  CHECK (classification IS NULL OR classification = ANY (ARRAY[
    'pre_approval_letter','proof_of_funds','id_document','signed_contract',
    'counter_offer','addendum','disclosure','inspection_report',
    'appraisal_report','title_report','hoa_documents','closing_disclosure',
    'wire_instructions','agency_disclosure','commission_agreement',
    'lender_letter','earnest_money_receipt','other'
  ]));

ALTER TABLE public.brokerage_required_documents DROP CONSTRAINT IF EXISTS brd_classification_check;
ALTER TABLE public.brokerage_required_documents ADD CONSTRAINT brd_classification_check
  CHECK (classification = ANY (ARRAY[
    'pre_approval_letter','proof_of_funds','id_document','signed_contract',
    'counter_offer','addendum','disclosure','inspection_report',
    'appraisal_report','title_report','hoa_documents','closing_disclosure',
    'wire_instructions','agency_disclosure','commission_agreement',
    'lender_letter','earnest_money_receipt','other'
  ]));
