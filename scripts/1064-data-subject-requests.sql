-- ============================================================================
-- Migration 1064 — Data Subject Access Requests (CCPA / CPRA / GDPR)
-- ============================================================================
--
-- WHY:
--   CCPA: 45-day response clock once a DSAR (export/delete) is submitted.
--   CPRA: extends 45→45+45 with notice. GDPR: 30 days (extendable to 90).
--   Exposure: $7,500 per intentional violation × class action × per-incident.
--
-- WHAT:
--   1. data_subject_requests — one row per request. Public submission via
--      app/actions/privacy/submit-dsar.ts (no auth — anyone can request).
--      Status: received → in_progress → fulfilled | denied | withdrawn.
--      Auto-computed due_at = received_at + 45 days (CCPA default; configurable
--      per brokerage state of operation).
--   2. privacy_acceptances — versioned audit trail of who accepted what privacy
--      notice and when. Required to defend against "I never saw the policy."
--   3. contacts.privacy_anonymized_at — set when right-to-be-forgotten is
--      fulfilled. Replaces PII with hashes; preserves transaction record for
--      state RE retention.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.data_subject_requests (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_type          text NOT NULL
                        CHECK (request_type IN ('export','delete','access','portability','correction','opt_out_sale','opt_out_sharing')),
  -- Subject identification (the requester may not be a user — they're often anonymous prospects)
  subject_email         text NOT NULL,
  subject_phone         text,
  subject_name          text,
  subject_user_id       uuid REFERENCES public.users(id)    ON DELETE SET NULL,
  subject_contact_id    uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  brokerage_id          uuid REFERENCES public.brokerages(id) ON DELETE SET NULL,
  -- Identity verification (CCPA §1798.130 — verify before fulfilling)
  identity_verified     boolean NOT NULL DEFAULT false,
  identity_verified_at  timestamptz,
  identity_verified_by  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  identity_method       text,  -- 'magic_link' | 'matching_user' | 'manual_review' | 'driver_license'
  -- Lifecycle
  status                text NOT NULL DEFAULT 'received'
                        CHECK (status IN ('received','in_progress','fulfilled','denied','withdrawn','expired')),
  -- 45-day CCPA clock (configurable per state). Set at insert via trigger.
  received_at           timestamptz NOT NULL DEFAULT now(),
  due_at                timestamptz NOT NULL,
  fulfilled_at          timestamptz,
  fulfilled_by          uuid REFERENCES public.users(id) ON DELETE SET NULL,
  denied_reason         text,
  -- Artifact (export request → S3 URL; delete → manifest of what was deleted)
  response_artifact_url text,
  response_summary      text,
  -- Source + audit
  source                text NOT NULL DEFAULT 'web_form'
                        CHECK (source IN ('web_form','email','phone','postal','api')),
  ip_address            text,
  user_agent            text,
  notes                 text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dsr_status_due   ON public.data_subject_requests(status, due_at);
CREATE INDEX IF NOT EXISTS idx_dsr_brokerage    ON public.data_subject_requests(brokerage_id, status, due_at);
CREATE INDEX IF NOT EXISTS idx_dsr_subject_email ON public.data_subject_requests(LOWER(subject_email));
CREATE INDEX IF NOT EXISTS idx_dsr_overdue      ON public.data_subject_requests(due_at)
  WHERE status IN ('received','in_progress');

-- Auto-set due_at on insert (received_at + 45 days CCPA default)
CREATE OR REPLACE FUNCTION public.set_dsr_due_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.due_at IS NULL THEN
    NEW.due_at := NEW.received_at + interval '45 days';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS trg_set_dsr_due_at ON public.data_subject_requests;
CREATE TRIGGER trg_set_dsr_due_at
  BEFORE INSERT OR UPDATE ON public.data_subject_requests
  FOR EACH ROW EXECUTE FUNCTION public.set_dsr_due_at();

ALTER TABLE public.data_subject_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS dsr_svc_all ON public.data_subject_requests;
CREATE POLICY dsr_svc_all ON public.data_subject_requests FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS dsr_tenant_read ON public.data_subject_requests;
CREATE POLICY dsr_tenant_read ON public.data_subject_requests FOR SELECT
  USING (brokerage_id = current_user_brokerage_id() OR current_user_type() = 'superadmin');

DROP POLICY IF EXISTS dsr_admin_write ON public.data_subject_requests;
CREATE POLICY dsr_admin_write ON public.data_subject_requests FOR UPDATE
  USING (brokerage_id = current_user_brokerage_id()
         AND current_user_type() IN ('broker','broker_admin','admin','superadmin','compliance_officer'))
  WITH CHECK (brokerage_id = current_user_brokerage_id()
              AND current_user_type() IN ('broker','broker_admin','admin','superadmin','compliance_officer'));

DROP POLICY IF EXISTS dsr_subject_read ON public.data_subject_requests;
CREATE POLICY dsr_subject_read ON public.data_subject_requests FOR SELECT
  USING (
    subject_user_id = auth.uid()
    OR subject_contact_id IN (SELECT id FROM public.contacts WHERE user_id = auth.uid())
  );

-- ── Privacy notice acceptance ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.privacy_acceptances (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid REFERENCES public.users(id)    ON DELETE CASCADE,
  contact_id      uuid REFERENCES public.contacts(id) ON DELETE CASCADE,
  brokerage_id    uuid REFERENCES public.brokerages(id) ON DELETE CASCADE,
  policy_type     text NOT NULL CHECK (policy_type IN ('privacy_policy','tcpa_consent','ccpa_notice','gdpr_notice','terms_of_service','cookie_policy')),
  policy_version  text NOT NULL,
  accepted_at     timestamptz NOT NULL DEFAULT now(),
  accepted_ip     text,
  accepted_ua     text,
  acceptance_text text,
  CHECK (user_id IS NOT NULL OR contact_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_pa_user ON public.privacy_acceptances(user_id, policy_type, accepted_at DESC);
CREATE INDEX IF NOT EXISTS idx_pa_contact ON public.privacy_acceptances(contact_id, policy_type, accepted_at DESC);

ALTER TABLE public.privacy_acceptances ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS pa_svc_all ON public.privacy_acceptances;
CREATE POLICY pa_svc_all ON public.privacy_acceptances FOR ALL USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS pa_tenant_read ON public.privacy_acceptances;
CREATE POLICY pa_tenant_read ON public.privacy_acceptances FOR SELECT
  USING (brokerage_id = current_user_brokerage_id() OR current_user_type() = 'superadmin');

-- ── Anonymization flag on contacts ───────────────────────────────────────────
ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS privacy_anonymized_at timestamptz,
  ADD COLUMN IF NOT EXISTS privacy_anonymized_reason text;

COMMIT;
