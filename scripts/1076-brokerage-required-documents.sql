-- ============================================================================
-- Migration 1076 — Brokerage required-document checklist (compliance gate)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.brokerage_required_documents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    uuid NOT NULL REFERENCES brokerages(id) ON DELETE CASCADE,
  scope_type      text NOT NULL,
  scope_id        uuid NOT NULL,
  classification  text NOT NULL,
  deal_type       text NOT NULL DEFAULT 'buyer',
  state_code      text,
  is_required     boolean NOT NULL DEFAULT true,
  block_on_missing boolean NOT NULL DEFAULT true,
  description     text,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamp with time zone NOT NULL DEFAULT now(),
  updated_at      timestamp with time zone NOT NULL DEFAULT now()
);

ALTER TABLE public.brokerage_required_documents ADD CONSTRAINT brd_scope_type_check
  CHECK (scope_type = ANY (ARRAY['brokerage','team','agent']));
ALTER TABLE public.brokerage_required_documents ADD CONSTRAINT brd_deal_type_check
  CHECK (deal_type = ANY (ARRAY['buyer','seller','dual']));
ALTER TABLE public.brokerage_required_documents ADD CONSTRAINT brd_classification_check
  CHECK (classification = ANY (ARRAY[
    'pre_approval_letter','proof_of_funds','id_document','signed_contract',
    'counter_offer','addendum','disclosure','inspection_report',
    'appraisal_report','title_report','hoa_documents','closing_disclosure',
    'wire_instructions','agency_disclosure','commission_agreement',
    'lender_letter','other'
  ]));

CREATE INDEX IF NOT EXISTS brd_resolver_idx
  ON public.brokerage_required_documents (brokerage_id, scope_type, scope_id, deal_type)
  WHERE is_required = true;
CREATE INDEX IF NOT EXISTS brd_by_classification_idx
  ON public.brokerage_required_documents (brokerage_id, classification, deal_type);

CREATE OR REPLACE FUNCTION public.set_brd_updated_at() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_brd_updated_at ON public.brokerage_required_documents;
CREATE TRIGGER trg_brd_updated_at BEFORE UPDATE ON public.brokerage_required_documents
  FOR EACH ROW EXECUTE FUNCTION public.set_brd_updated_at();

ALTER TABLE public.brokerage_required_documents ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS brd_select ON public.brokerage_required_documents;
CREATE POLICY brd_select ON public.brokerage_required_documents
  FOR SELECT USING (brokerage_id = current_user_brokerage_id());
DROP POLICY IF EXISTS brd_modify ON public.brokerage_required_documents;
CREATE POLICY brd_modify ON public.brokerage_required_documents
  FOR ALL USING (brokerage_id = current_user_brokerage_id())
  WITH CHECK (brokerage_id = current_user_brokerage_id());
