-- ============================================================================
-- Migration 1062 — Buyer Broker Agreement (BBA) workflow — NAR 2024 Settlement
-- ============================================================================
--
-- WHY:
--   August 17, 2024 NAR settlement requires a SIGNED buyer broker agreement
--   BEFORE a buyer is shown any property the agent represents. Violation
--   exposure: $5K–$50K per incident + DOJ scrutiny + loss of MLS access.
--
--   Existing infrastructure that we leverage:
--     - signable_doc_types already includes 'buyer_representation_agreement'
--     - signature_requests table integrates with Dotloop/DocuSign
--     - contacts.buyer_stage state machine has natural gate points:
--       BUYER_FINANCIALLY_VERIFIED → BUYER_TOUR_ELIGIBLE  (showing gate)
--       BUYER_OFFER_ELIGIBLE       → offer creation       (offer gate)
--
-- WHAT:
--   1. buyer_broker_agreements table — one row per active BBA per
--      (buyer_contact_id, agent_id) tuple. Status lifecycle:
--        draft → pending_signature → active → (expired | cancelled | superseded)
--   2. Commission terms: percentage / flat amount + payer (seller/buyer/split).
--   3. Scope: geographic_scope + property_type_scope (so an agent can have
--      "showing-only" scope limited to a county before the buyer commits).
--   4. Signing method: docusign / wet_signature / click_through.
--      click_through records IP + UA for audit trail.
--   5. Unique partial index: only ONE active BBA per (buyer, agent) tuple.
--   6. RLS: tenant-scoped via brokerage_id.
--
-- CALL SITES (wired in app/actions/showings.ts + app/actions/buyer-offer/create-offer.ts):
--   - requestShowing → require active BBA before insert
--   - createBuyerOffer → require active BBA before draft
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.buyer_broker_agreements (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id            uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  buyer_contact_id        uuid NOT NULL REFERENCES public.contacts(id)   ON DELETE CASCADE,
  agent_id                uuid NOT NULL REFERENCES public.agents(id)     ON DELETE RESTRICT,
  agreement_type          text NOT NULL DEFAULT 'exclusive'
                          CHECK (agreement_type IN ('exclusive','non_exclusive','showing_only','open')),
  -- Commission terms (NAR settlement requires EXPLICIT compensation written here)
  commission_percentage   numeric(5,2),     -- e.g. 2.50 = 2.5% of purchase
  commission_flat_amount  numeric(12,2),    -- alternative to percentage
  commission_payer        text NOT NULL DEFAULT 'seller'
                          CHECK (commission_payer IN ('seller','buyer','split','either')),
  commission_notes        text,             -- e.g. "Buyer covers any gap above 2.5% from seller"
  -- Scope (geographic + property type)
  geographic_scope        text,             -- e.g. "Travis County, TX"
  property_type_scope     jsonb NOT NULL DEFAULT '["residential"]'::jsonb,
  -- Lifecycle
  status                  text NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','pending_signature','active','expired','cancelled','superseded')),
  effective_date          date,
  expiration_date         date,
  -- Signing
  signed_at               timestamptz,
  signed_method           text CHECK (signed_method IN ('docusign','wet_signature','click_through','dotloop')),
  signed_document_url     text,
  signature_request_id    uuid,  -- loose link to signature_requests if/when the table is materialized
  click_through_ip        text,
  click_through_user_agent text,
  -- Audit
  created_by              uuid NOT NULL REFERENCES public.users(id) ON DELETE SET NULL,
  cancelled_at            timestamptz,
  cancelled_by            uuid REFERENCES public.users(id) ON DELETE SET NULL,
  cancellation_reason     text,
  superseded_by           uuid REFERENCES public.buyer_broker_agreements(id) ON DELETE SET NULL,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),

  -- At least one commission term is required when not in draft
  CONSTRAINT bba_commission_required CHECK (
    status = 'draft'
    OR commission_percentage IS NOT NULL
    OR commission_flat_amount IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_bba_buyer_status     ON public.buyer_broker_agreements(buyer_contact_id, status);
CREATE INDEX IF NOT EXISTS idx_bba_agent_status     ON public.buyer_broker_agreements(agent_id, status);
CREATE INDEX IF NOT EXISTS idx_bba_brokerage        ON public.buyer_broker_agreements(brokerage_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_bba_expiration       ON public.buyer_broker_agreements(expiration_date) WHERE status = 'active';

-- Only ONE active BBA per (buyer, agent) tuple. Buyer can have BBAs with
-- different agents simultaneously (e.g. switching agents) but only one
-- active per pairing.
CREATE UNIQUE INDEX IF NOT EXISTS uq_bba_active_per_buyer_agent
  ON public.buyer_broker_agreements(buyer_contact_id, agent_id)
  WHERE status = 'active';

ALTER TABLE public.buyer_broker_agreements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bba_svc_all ON public.buyer_broker_agreements;
CREATE POLICY bba_svc_all ON public.buyer_broker_agreements
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS bba_tenant_read ON public.buyer_broker_agreements;
CREATE POLICY bba_tenant_read ON public.buyer_broker_agreements
  FOR SELECT
  USING (brokerage_id = current_user_brokerage_id() OR current_user_type() = 'superadmin');

DROP POLICY IF EXISTS bba_tenant_write ON public.buyer_broker_agreements;
CREATE POLICY bba_tenant_write ON public.buyer_broker_agreements
  FOR ALL
  USING (
    brokerage_id = current_user_brokerage_id()
    AND current_user_type() IN ('broker','broker_admin','admin','superadmin','team_lead','agent')
  )
  WITH CHECK (
    brokerage_id = current_user_brokerage_id()
    AND current_user_type() IN ('broker','broker_admin','admin','superadmin','team_lead','agent')
  );

DROP POLICY IF EXISTS bba_buyer_read_own ON public.buyer_broker_agreements;
CREATE POLICY bba_buyer_read_own ON public.buyer_broker_agreements
  FOR SELECT
  USING (
    buyer_contact_id IN (
      SELECT id FROM public.contacts WHERE user_id = auth.uid()
    )
  );

CREATE OR REPLACE FUNCTION public.touch_bba_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END$$;

DROP TRIGGER IF EXISTS trg_touch_bba ON public.buyer_broker_agreements;
CREATE TRIGGER trg_touch_bba BEFORE UPDATE ON public.buyer_broker_agreements
  FOR EACH ROW EXECUTE FUNCTION public.touch_bba_updated_at();

-- Auto-expire job (called by a cron, also safe to call directly)
CREATE OR REPLACE FUNCTION public.expire_buyer_broker_agreements()
RETURNS int LANGUAGE sql AS $$
  WITH expired AS (
    UPDATE public.buyer_broker_agreements
      SET status = 'expired', updated_at = now()
      WHERE status = 'active'
        AND expiration_date IS NOT NULL
        AND expiration_date < CURRENT_DATE
      RETURNING id
  )
  SELECT COUNT(*)::int FROM expired;
$$;

COMMIT;
