-- compliance_checks: stores results of compliance scans on documents/contracts.
-- Distinct from compliance_events (which logs kernel gate decisions).
-- Used by ai-contract-review.reviewContract and documents.processDocumentWithAI.

CREATE TABLE IF NOT EXISTS public.compliance_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_review_id uuid,
  check_type text NOT NULL,
  status text DEFAULT 'pending',
  findings jsonb,
  resolved_at timestamptz,
  created_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_compliance_checks_status ON public.compliance_checks(status);
CREATE INDEX IF NOT EXISTS idx_compliance_checks_check_type ON public.compliance_checks(check_type);

ALTER TABLE public.compliance_checks ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE policyname = 'Service role manages compliance_checks' AND tablename = 'compliance_checks'
  ) THEN
    CREATE POLICY "Service role manages compliance_checks"
      ON public.compliance_checks FOR ALL USING (true);
  END IF;
END$$;
