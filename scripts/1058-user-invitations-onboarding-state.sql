-- ============================================================================
-- Migration 1058 — User invitations table + brokerage onboarding state machine
-- ============================================================================
--
-- WHY:
--   Commit C added brokerages.onboarding_status but nothing advances it past
--   'pending'. We have inviteUser (admin-side) and signupBrokerageAction
--   (top-of-funnel) and vendor_invitations (Commit D), but no general
--   user_invitations table to track who was invited, by whom, and when they
--   actually accepted the magic link. Without that, the admin can't see
--   "3 invites pending" and the onboarding state machine can't know when
--   a brokerage has moved from setup to active use.
--
-- WHAT:
--   user_invitations — one row per Supabase invite issued by inviteUser.
--   Tenant-scoped via brokerage_id with RLS. Lifecycle:
--     pending → accepted | expired | revoked
--
--   advance_brokerage_onboarding() function — single canonical entry point
--   that moves brokerages.onboarding_status forward:
--     pending      → in_progress  (when first non-admin user accepts)
--     in_progress  → completed    (when admin explicitly marks setup done)
--
--   v_brokerage_onboarding_progress — per-brokerage rollup for the superadmin
--   platform dashboard: invited_count, accepted_count, days_since_signup.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS public.user_invitations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id    uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  team_id         uuid REFERENCES public.teams(id) ON DELETE SET NULL,
  invited_by      uuid NOT NULL REFERENCES public.users(id) ON DELETE SET NULL,
  email           text NOT NULL,
  user_type       text NOT NULL,
  first_name      text,
  last_name       text,
  status          text NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','accepted','expired','revoked')),
  accepted_user_id  uuid REFERENCES public.users(id) ON DELETE SET NULL,
  accepted_at       timestamptz,
  expires_at        timestamptz NOT NULL DEFAULT (now() + interval '14 days'),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_invitations_brokerage_status
  ON public.user_invitations(brokerage_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_user_invitations_email
  ON public.user_invitations(LOWER(email), status);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_invitations_pending_email
  ON public.user_invitations(brokerage_id, LOWER(email))
  WHERE status = 'pending';

ALTER TABLE public.user_invitations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS user_invitations_svc_all ON public.user_invitations;
CREATE POLICY user_invitations_svc_all ON public.user_invitations
  FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS user_invitations_tenant_read ON public.user_invitations;
CREATE POLICY user_invitations_tenant_read ON public.user_invitations
  FOR SELECT
  USING (brokerage_id = current_user_brokerage_id() OR current_user_type() = 'superadmin');

DROP POLICY IF EXISTS user_invitations_tenant_write ON public.user_invitations;
CREATE POLICY user_invitations_tenant_write ON public.user_invitations
  FOR ALL
  USING (brokerage_id = current_user_brokerage_id()
         AND current_user_type() IN ('broker','broker_admin','admin','superadmin','team_lead'))
  WITH CHECK (brokerage_id = current_user_brokerage_id()
              AND current_user_type() IN ('broker','broker_admin','admin','superadmin','team_lead'));

-- Touch trigger
CREATE OR REPLACE FUNCTION public.touch_user_invitations_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END$$;

DROP TRIGGER IF EXISTS trg_touch_user_invitations ON public.user_invitations;
CREATE TRIGGER trg_touch_user_invitations
  BEFORE UPDATE ON public.user_invitations
  FOR EACH ROW EXECUTE FUNCTION public.touch_user_invitations_updated_at();

-- Onboarding state machine — single canonical advance function.
-- Caller is always a server action (service client) so we don't gate this
-- with role checks; the gate is in the action layer.
CREATE OR REPLACE FUNCTION public.advance_brokerage_onboarding(
  p_brokerage_id uuid,
  p_target_status text
) RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  current_status text;
BEGIN
  IF p_target_status NOT IN ('pending','in_progress','completed','abandoned') THEN
    RAISE EXCEPTION 'invalid target status: %', p_target_status;
  END IF;

  SELECT onboarding_status INTO current_status
  FROM public.brokerages WHERE id = p_brokerage_id;

  IF current_status IS NULL THEN
    RETURN 'brokerage_not_found';
  END IF;

  -- Only allow forward transitions (or abandoned). Idempotent.
  IF (current_status = 'pending'      AND p_target_status IN ('in_progress','completed','abandoned'))
  OR (current_status = 'in_progress'  AND p_target_status IN ('completed','abandoned'))
  OR (current_status = p_target_status) THEN
    UPDATE public.brokerages
      SET onboarding_status = p_target_status, updated_at = now()
      WHERE id = p_brokerage_id;
    RETURN p_target_status;
  END IF;

  RETURN current_status;  -- no-op if illegal transition (e.g. completed → pending)
END$$;

-- Onboarding progress rollup view (per-brokerage). Used by superadmin
-- platform dashboard to spot brokerages stalled in onboarding.
CREATE OR REPLACE VIEW public.v_brokerage_onboarding_progress AS
SELECT
  b.id                                            AS brokerage_id,
  b.name                                          AS brokerage_name,
  b.onboarding_status,
  b.signup_source,
  b.trial_ends_at,
  b.plan_tier,
  b.created_at                                    AS signed_up_at,
  EXTRACT(epoch FROM (now() - b.created_at))/86400 AS days_since_signup,
  COUNT(ui.id) FILTER (WHERE ui.status = 'pending')   AS pending_invites,
  COUNT(ui.id) FILTER (WHERE ui.status = 'accepted')  AS accepted_invites,
  COUNT(u.id)  FILTER (WHERE u.brokerage_id = b.id
                       AND u.user_type NOT IN ('contact','vendor'))
                                                  AS team_member_count
FROM public.brokerages b
LEFT JOIN public.user_invitations ui ON ui.brokerage_id = b.id
LEFT JOIN public.users u             ON u.brokerage_id  = b.id
GROUP BY b.id;

COMMENT ON FUNCTION public.advance_brokerage_onboarding IS
  'Move brokerages.onboarding_status forward through the canonical state machine. Refuses backward transitions (idempotent on same-state).';
COMMENT ON VIEW public.v_brokerage_onboarding_progress IS
  'Per-brokerage onboarding rollup. Joins brokerages + user_invitations + users to surface stalled tenants.';

COMMIT;
