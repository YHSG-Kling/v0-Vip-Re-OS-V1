-- ─────────────────────────────────────────────────────────────────────────────
-- 999c — Extend closing_disclosure_agreement to support the full CDA flow
--
-- Mirrors the migration applied live to the prod DB on 2026-05-05.
-- Adds the columns the existing lib/transactions/cda-workflow.ts already
-- tries to write, plus the agent draft / sign-off / send-back fields the
-- portal flow needs. Also adds a side table for revision history so the
-- prior commission_breakdown values are preserved across "changes
-- requested" cycles.
--
-- IMPORTANT: this DOES NOT add new commission tables — the production DB
-- already has commission_calculations, commission_distributions,
-- commission_adjustments, transaction_commissions, agent_commission_profiles,
-- team_commission_profiles, and closing_disclosure_agreement. Reuse those.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.closing_disclosure_agreement
  ADD COLUMN IF NOT EXISTS brokerage_id                    uuid REFERENCES public.brokerages(id),
  ADD COLUMN IF NOT EXISTS calculation_version             text,
  ADD COLUMN IF NOT EXISTS gross_commission                numeric(12,2),
  ADD COLUMN IF NOT EXISTS agent_net                       numeric(12,2),
  ADD COLUMN IF NOT EXISTS brokerage_net                   numeric(12,2),

  ADD COLUMN IF NOT EXISTS preliminary_cd_uploaded_at      timestamptz,
  ADD COLUMN IF NOT EXISTS preliminary_cd_document_id      uuid REFERENCES public.transaction_documents(id),
  ADD COLUMN IF NOT EXISTS preliminary_cd_uploaded_by      uuid REFERENCES public.users(id),

  ADD COLUMN IF NOT EXISTS agent_drafted_at                timestamptz,
  ADD COLUMN IF NOT EXISTS agent_submitted_at              timestamptz,
  ADD COLUMN IF NOT EXISTS agent_submitted_by              uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS agent_signed_off_at             timestamptz,
  ADD COLUMN IF NOT EXISTS agent_signed_off_by             uuid REFERENCES public.users(id),

  ADD COLUMN IF NOT EXISTS compliance_approved_at          timestamptz,
  ADD COLUMN IF NOT EXISTS compliance_approved_by          uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS changes_requested_at            timestamptz,
  ADD COLUMN IF NOT EXISTS changes_requested_by            uuid REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS changes_requested_notes         text,
  ADD COLUMN IF NOT EXISTS revision_number                 integer NOT NULL DEFAULT 1;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.constraint_column_usage
    WHERE table_name = 'closing_disclosure_agreement'
      AND column_name = 'status'
      AND constraint_name = 'closing_disclosure_agreement_status_check'
  ) THEN
    ALTER TABLE public.closing_disclosure_agreement
      DROP CONSTRAINT closing_disclosure_agreement_status_check;
  END IF;
END$$;

ALTER TABLE public.closing_disclosure_agreement
  ADD CONSTRAINT closing_disclosure_agreement_status_check CHECK (
    status IN (
      'awaiting_preliminary_cd',
      'pending',
      'drafting',
      'submitted',
      'changes_requested',
      'approved',
      'rejected',
      'cancelled'
    )
  );

CREATE INDEX IF NOT EXISTS idx_cda_transaction
  ON public.closing_disclosure_agreement(transaction_id);
CREATE INDEX IF NOT EXISTS idx_cda_status
  ON public.closing_disclosure_agreement(status);
CREATE INDEX IF NOT EXISTS idx_cda_brokerage
  ON public.closing_disclosure_agreement(brokerage_id);

CREATE TABLE IF NOT EXISTS public.closing_disclosure_agreement_revisions (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cda_id                   uuid NOT NULL REFERENCES public.closing_disclosure_agreement(id) ON DELETE CASCADE,
  revision_number          integer NOT NULL,
  status_at_snapshot       text NOT NULL,
  commission_breakdown     jsonb,
  notes                    text,
  changes_requested_notes  text,
  acted_by                 uuid REFERENCES public.users(id),
  acted_at                 timestamptz NOT NULL DEFAULT now(),
  action                   text NOT NULL CHECK (action IN (
    'drafted','submitted','signed_off','changes_requested','approved','rejected','cancelled'
  ))
);

CREATE INDEX IF NOT EXISTS idx_cda_revisions_cda
  ON public.closing_disclosure_agreement_revisions(cda_id);

ALTER TABLE public.closing_disclosure_agreement_revisions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cda_revisions_select ON public.closing_disclosure_agreement_revisions;
CREATE POLICY cda_revisions_select ON public.closing_disclosure_agreement_revisions
  FOR SELECT USING (
    EXISTS (
      SELECT 1
      FROM public.closing_disclosure_agreement c
      JOIN public.users u ON u.id = auth.uid()
      WHERE c.id = closing_disclosure_agreement_revisions.cda_id
        AND (
          u.user_type IN ('compliance_officer','admin','broker','broker_admin','superadmin')
          OR EXISTS (
            SELECT 1 FROM public.agents a
            WHERE a.id = c.agent_id AND a.user_id = u.id
          )
        )
    )
  );

DROP POLICY IF EXISTS cda_revisions_insert ON public.closing_disclosure_agreement_revisions;
CREATE POLICY cda_revisions_insert ON public.closing_disclosure_agreement_revisions
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid())
  );
