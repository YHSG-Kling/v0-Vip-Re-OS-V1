-- ============================================================================
-- Migration 1057 — Vendor invite-to-platform handshake
-- ============================================================================
--
-- WHY:
--   Agents and brokerage admins can add vendors (vendors table exists, has
--   brokerage_id, vendor user_type is in the CHECK, vendor portal renders
--   from user_role_assignments.vendor_id). What's MISSING is the email →
--   magic-link → portal arc — today a vendor record gets created but the
--   vendor has no account, can't log in, and can't see deals they're on.
--
-- WHAT:
--   vendor_invitations — one row per pending invite. Carries a
--   cryptographically random token (lib/vendors/invitations.ts) that the
--   accept-flow verifies. Tenant-scoped via brokerage_id with RLS.
--
--   Lifecycle:
--     pending → accepted | declined | expired | revoked
--
--   On accept:
--     1. Supabase auth user created (or linked if email already exists)
--     2. users row with user_type='vendor', brokerage_id from the invitation
--     3. user_role_assignments row linking auth user_id ↔ vendor_id
--     4. Invitation row marked 'accepted'
--
--   Both invitations and acceptance happen through service-client server
--   actions so RLS bypass is contained to the explicit code paths.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.vendor_invitations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendor_id       uuid NOT NULL REFERENCES public.vendors(id) ON DELETE CASCADE,
  brokerage_id    uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  invited_by      uuid NOT NULL REFERENCES public.users(id) ON DELETE SET NULL,
  email           text NOT NULL,
  token           text NOT NULL UNIQUE,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','accepted','declined','expired','revoked')),
  expires_at      timestamptz NOT NULL,
  custom_message  text,
  accepted_by     uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  accepted_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_vendor_invitations_token
  ON public.vendor_invitations(token);
CREATE INDEX IF NOT EXISTS idx_vendor_invitations_vendor
  ON public.vendor_invitations(vendor_id, status);
CREATE INDEX IF NOT EXISTS idx_vendor_invitations_brokerage_status
  ON public.vendor_invitations(brokerage_id, status, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_vendor_invitations_email
  ON public.vendor_invitations(LOWER(email), status);

ALTER TABLE public.vendor_invitations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vendor_invitations_svc_all ON public.vendor_invitations;
CREATE POLICY vendor_invitations_svc_all ON public.vendor_invitations
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS vendor_invitations_tenant_read ON public.vendor_invitations;
CREATE POLICY vendor_invitations_tenant_read ON public.vendor_invitations
  FOR SELECT
  USING (brokerage_id = current_user_brokerage_id()
         OR current_user_type() = 'superadmin');

DROP POLICY IF EXISTS vendor_invitations_tenant_insert ON public.vendor_invitations;
CREATE POLICY vendor_invitations_tenant_insert ON public.vendor_invitations
  FOR INSERT
  WITH CHECK (
    brokerage_id = current_user_brokerage_id()
    AND current_user_type() IN ('broker','broker_admin','admin','superadmin','team_lead','agent')
  );

DROP POLICY IF EXISTS vendor_invitations_tenant_update ON public.vendor_invitations;
CREATE POLICY vendor_invitations_tenant_update ON public.vendor_invitations
  FOR UPDATE
  USING (
    brokerage_id = current_user_brokerage_id()
    AND current_user_type() IN ('broker','broker_admin','admin','superadmin','team_lead')
  )
  WITH CHECK (
    brokerage_id = current_user_brokerage_id()
    AND current_user_type() IN ('broker','broker_admin','admin','superadmin','team_lead')
  );

-- Auto-bump updated_at
CREATE OR REPLACE FUNCTION public.touch_vendor_invitations_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS trg_touch_vendor_invitations ON public.vendor_invitations;
CREATE TRIGGER trg_touch_vendor_invitations
  BEFORE UPDATE ON public.vendor_invitations
  FOR EACH ROW EXECUTE FUNCTION public.touch_vendor_invitations_updated_at();

COMMIT;
