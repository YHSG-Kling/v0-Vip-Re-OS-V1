-- ============================================================================
-- Migration 1060 — Brokerage lifecycle states + superadmin audit log
-- ============================================================================
--
-- WHY:
--   To run the platform, superadmin needs:
--   1. A way to suspend a brokerage (e.g. failed payment, abuse) without
--      destroying their data — NAR record-retention requires 3 years on
--      closed transactions, so hard-delete is never the answer.
--   2. A cancel state that severs billing but retains data 90 days before
--      archive.
--   3. An audit trail of EVERY superadmin action that doesn't depend on
--      activities.agent_id FK (which requires a matching agents row).
--
-- WHAT:
--   1. brokerages.status — active | suspended | cancelled | archived
--      Default 'active'. Driver of: login gates (suspended/cancelled blocks
--      tenant logins), feature access (cancel disables AI calls), purge
--      eligibility (archived → safe to delete after retention window).
--   2. brokerages.suspended_at, cancelled_at, archived_at timestamps.
--   3. superadmin_audit_log — pure audit table with NO FK to agents/users
--      (uses auth.uid() reference only, kept as uuid). RLS: superadmin
--      read-all, service-write.
-- ============================================================================

BEGIN;

ALTER TABLE public.brokerages
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS suspended_at timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_at timestamptz,
  ADD COLUMN IF NOT EXISTS archived_at  timestamptz;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='brokerages_status_check') THEN
    ALTER TABLE public.brokerages
      ADD CONSTRAINT brokerages_status_check
      CHECK (status IN ('active','suspended','cancelled','archived'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_brokerages_status ON public.brokerages(status);

-- Superadmin audit log
CREATE TABLE IF NOT EXISTS public.superadmin_audit_log (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id   uuid NOT NULL,
  actor_email     text,
  action          text NOT NULL,
  target_type     text NOT NULL,
  target_id       uuid,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip_address      text,
  user_agent      text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sal_actor      ON public.superadmin_audit_log(actor_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sal_target     ON public.superadmin_audit_log(target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sal_action     ON public.superadmin_audit_log(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sal_created_at ON public.superadmin_audit_log(created_at DESC);

ALTER TABLE public.superadmin_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sal_svc_all ON public.superadmin_audit_log;
CREATE POLICY sal_svc_all ON public.superadmin_audit_log
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS sal_superadmin_read ON public.superadmin_audit_log;
CREATE POLICY sal_superadmin_read ON public.superadmin_audit_log
  FOR SELECT USING (current_user_type() = 'superadmin');

COMMENT ON TABLE public.superadmin_audit_log IS
  'Append-only audit trail for every superadmin action (tier change, suspend, cancel, manual provision). Independent of activities table to avoid FK constraints requiring an agents row.';

COMMIT;
