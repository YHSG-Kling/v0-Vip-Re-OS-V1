-- ─────────────────────────────────────────────────────────────────────────────
-- 999b — Commission Disbursement (Compliance Manager owned)
--
-- Two tables that close the loop the existing CDA workflow leaves open:
--   • commission_disbursements          : per-agent net calculations the
--     Compliance Officer reviews + approves at CDA approval time.
--   • commission_disbursement_authorizations : the formal Disbursement
--     Authorization Letter routed to title (or the closing attorney,
--     state-dependent) that releases funds at the table.
--
-- Hard rule: an agent does not get paid until the Compliance Officer
-- approves the disbursement and the authorization is delivered to the
-- payee. The agent dashboard shows a READ-ONLY summary; controls live
-- only on the Compliance dashboard.
-- ─────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.commission_disbursements (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id                uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  transaction_id              uuid        NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  cda_id                      uuid,                                  -- soft FK (cdas table varies across migrations)
  agent_id                    uuid        NOT NULL REFERENCES public.agents(id) ON DELETE RESTRICT,

  side                        text        NOT NULL CHECK (side IN ('listing','buying','referral','team_lead_override')),
  gross_commission            numeric(12,2) NOT NULL,
  brokerage_split_percent     numeric(5,2) NOT NULL,
  brokerage_split_amount      numeric(12,2) NOT NULL,
  agent_split_amount          numeric(12,2) NOT NULL,

  referral_amount             numeric(12,2) NOT NULL DEFAULT 0,
  referral_payee              text,                                  -- name of referring brokerage / agent
  team_override_amount        numeric(12,2) NOT NULL DEFAULT 0,
  team_lead_id                uuid        REFERENCES public.agents(id),
  franchise_fee_amount        numeric(12,2) NOT NULL DEFAULT 0,
  e_and_o_amount              numeric(12,2) NOT NULL DEFAULT 0,
  transaction_fees_amount     numeric(12,2) NOT NULL DEFAULT 0,
  other_deductions_amount     numeric(12,2) NOT NULL DEFAULT 0,
  other_deductions_notes      text,

  net_to_agent                numeric(12,2) NOT NULL,

  payment_routing             text        NOT NULL CHECK (payment_routing IN ('title_direct','closing_attorney','wire_to_brokerage')),
  status                      text        NOT NULL DEFAULT 'draft'
                                          CHECK (status IN ('draft','pending_review','approved','paid','rejected','cancelled')),
  reviewed_by                 uuid        REFERENCES public.users(id),
  reviewed_at                 timestamptz,
  rejected_reason             text,
  paid_at                     timestamptz,

  created_by                  uuid        REFERENCES public.users(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_commission_disbursements_brokerage      ON public.commission_disbursements(brokerage_id);
CREATE INDEX IF NOT EXISTS idx_commission_disbursements_transaction    ON public.commission_disbursements(transaction_id);
CREATE INDEX IF NOT EXISTS idx_commission_disbursements_agent          ON public.commission_disbursements(agent_id);
CREATE INDEX IF NOT EXISTS idx_commission_disbursements_status         ON public.commission_disbursements(status);

ALTER TABLE public.commission_disbursements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS commission_disbursements_select ON public.commission_disbursements;
CREATE POLICY commission_disbursements_select ON public.commission_disbursements
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid()
        AND (
          u.user_type IN ('compliance_officer','admin','broker','broker_admin','superadmin')
          OR EXISTS (
            SELECT 1 FROM public.agents a
            WHERE a.id = commission_disbursements.agent_id
              AND a.user_id = u.id
          )
        )
    )
  );

DROP POLICY IF EXISTS commission_disbursements_modify ON public.commission_disbursements;
CREATE POLICY commission_disbursements_modify ON public.commission_disbursements
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid()
        AND u.user_type IN ('compliance_officer','admin','broker','broker_admin','superadmin')
    )
  );

-- ── Authorization (the document delivered to title/attorney) ─────────────────
CREATE TABLE IF NOT EXISTS public.commission_disbursement_authorizations (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id             uuid        NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  transaction_id           uuid        NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  payee_type               text        NOT NULL CHECK (payee_type IN ('title_company','closing_attorney','direct_wire')),
  payee_name               text        NOT NULL,
  payee_email              text,
  payee_phone              text,
  delivered_at             timestamptz,
  delivery_method          text        CHECK (delivery_method IN ('email','docusign','manual_upload')),
  document_url             text,
  payment_received_at      timestamptz,
  payment_amount_received  numeric(12,2),

  notes                    text,
  created_by               uuid        REFERENCES public.users(id),
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_disbursement_auth_transaction ON public.commission_disbursement_authorizations(transaction_id);
CREATE INDEX IF NOT EXISTS idx_disbursement_auth_brokerage   ON public.commission_disbursement_authorizations(brokerage_id);

ALTER TABLE public.commission_disbursement_authorizations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS disbursement_auth_select ON public.commission_disbursement_authorizations;
CREATE POLICY disbursement_auth_select ON public.commission_disbursement_authorizations
  FOR SELECT USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid()
        AND u.user_type IN ('compliance_officer','admin','broker','broker_admin','superadmin')
    )
  );

DROP POLICY IF EXISTS disbursement_auth_modify ON public.commission_disbursement_authorizations;
CREATE POLICY disbursement_auth_modify ON public.commission_disbursement_authorizations
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid()
        AND u.user_type IN ('compliance_officer','admin','broker','broker_admin','superadmin')
    )
  );

-- updated_at trigger
CREATE OR REPLACE FUNCTION public.set_updated_at_now()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_commission_disbursements_updated ON public.commission_disbursements;
CREATE TRIGGER trg_commission_disbursements_updated
BEFORE UPDATE ON public.commission_disbursements
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_now();

DROP TRIGGER IF EXISTS trg_disbursement_auth_updated ON public.commission_disbursement_authorizations;
CREATE TRIGGER trg_disbursement_auth_updated
BEFORE UPDATE ON public.commission_disbursement_authorizations
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at_now();
