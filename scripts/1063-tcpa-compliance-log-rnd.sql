-- ============================================================================
-- Migration 1063 — TCPA compliance log + RND (Reassigned Number) tracking
-- ============================================================================
--
-- WHY:
--   Federal TCPA enforcement exposure: $500–$1,500 per call/SMS in violation,
--   class-action multipliers. Audit found:
--     - lib/providers/messaging/index.ts:sendSMS / placeCall called Twilio
--       directly with NO compliance gate (bypassed by notification-service +
--       listing-lifecycle).
--     - No record of WHY a message was sent or blocked (Plaintiff's discovery
--       hits us — "produce all communications + compliance decisions").
--     - No reassigned-number tracking — calling a number that was reassigned
--       after consent was given still violates TCPA.
--
-- WHAT:
--   1. outbound_message_compliance_log — one row per gate decision
--      (allowed | blocked) with the reason. Append-only, 7-year retention.
--   2. contacts.phone_validated_at — last time the phone was checked via
--      Twilio Lookup / RealPhoneValidation. Staleness >90d triggers an RND
--      warning that downgrades consent to "stale" until re-validated.
--   3. contacts.phone_status — 'valid' | 'invalid' | 'reassigned' | 'unknown'
-- ============================================================================

BEGIN;

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS phone_validated_at timestamptz,
  ADD COLUMN IF NOT EXISTS phone_status text NOT NULL DEFAULT 'unknown';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='contacts_phone_status_check') THEN
    ALTER TABLE public.contacts ADD CONSTRAINT contacts_phone_status_check
      CHECK (phone_status IN ('valid','invalid','reassigned','unknown'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_contacts_phone_validated_at
  ON public.contacts(phone_validated_at)
  WHERE phone IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.outbound_message_compliance_log (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id        uuid REFERENCES public.brokerages(id) ON DELETE CASCADE,
  contact_id          uuid REFERENCES public.contacts(id)   ON DELETE SET NULL,
  initiated_by        uuid REFERENCES public.users(id)      ON DELETE SET NULL,
  channel             text NOT NULL CHECK (channel IN ('sms','call','email')),
  phone               text,
  email               text,
  decision            text NOT NULL CHECK (decision IN ('allowed','blocked','warning_logged')),
  block_reason        text,  -- 'dnc' | 'no_consent' | 'quiet_hours' | 'phone_stale' | 'phone_reassigned' | 'opted_out' | 'other'
  details             jsonb NOT NULL DEFAULT '{}'::jsonb,
  recipient_state     text,
  recipient_local_hour int,
  created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_omcl_brokerage    ON public.outbound_message_compliance_log(brokerage_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_omcl_contact      ON public.outbound_message_compliance_log(contact_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_omcl_decision     ON public.outbound_message_compliance_log(decision, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_omcl_block_reason ON public.outbound_message_compliance_log(block_reason, created_at DESC)
  WHERE decision = 'blocked';

ALTER TABLE public.outbound_message_compliance_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS omcl_svc_all ON public.outbound_message_compliance_log;
CREATE POLICY omcl_svc_all ON public.outbound_message_compliance_log
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS omcl_tenant_read ON public.outbound_message_compliance_log;
CREATE POLICY omcl_tenant_read ON public.outbound_message_compliance_log
  FOR SELECT
  USING (brokerage_id = current_user_brokerage_id() OR current_user_type() = 'superadmin');

-- Append-only: no UPDATE or DELETE policy (audit integrity).

COMMENT ON TABLE public.outbound_message_compliance_log IS
  'Append-only audit trail of every outbound message TCPA-gate decision. Required for class-action discovery + state RE commission audits. 7-year retention.';

COMMIT;
