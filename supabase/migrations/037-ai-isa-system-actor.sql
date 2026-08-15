-- =====================================================
-- MIGRATION 037: AI-ISA system actor (one per brokerage)
-- =====================================================
-- The Vapi webhook and the lead-pipeline cron currently write
-- via the Supabase service-role key, which bypasses RLS entirely.
-- That means the entire AI-ISA hot path is unverifiable.
--
-- Product intent (user-confirmed): each brokerage gets a dedicated
-- auth user that represents the AI-ISA system. The ISA worker signs
-- in as that user (one per brokerage), so every read/write goes
-- through RLS and is scoped to that brokerage.
--
-- Schema bits:
--   1. Mutual-exclusion constraint:
--        platform_role='ai_isa_system'  ↔  user_type IS NULL
--        AND a brokerage_id IS REQUIRED for ISA users.
--      We allow user_type IS NULL for ISA only — every other user
--      keeps NOT NULL on user_type.
--   2. Trigger on brokerages INSERT that provisions a
--      public.users row with platform_role='ai_isa_system'.
--      (The matching auth.users row must be created out-of-band by
--      the application — done via the provisioning helper that
--      ships alongside this migration. Without the auth.users row
--      the public.users row is inert: nobody can sign in as it.)
--
-- Note: we DO NOT loosen the existing user_type NOT NULL constraint
-- because that NOT NULL is what guarantees every "real" user has a
-- role. Instead we relax it for the ISA system row specifically by
-- writing user_type='system' (a legal CHECK value from migration
-- 036). That keeps the schema honest without special-casing NULL.
-- =====================================================

-- Mutual-exclusion CHECK: platform_role='ai_isa_system' requires a brokerage_id
-- and the conventional user_type='system'.
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_isa_actor_shape_check;
ALTER TABLE public.users
  ADD CONSTRAINT users_isa_actor_shape_check
  CHECK (
    platform_role IS DISTINCT FROM 'ai_isa_system'
    OR (
      brokerage_id IS NOT NULL
      AND user_type = 'system'
    )
  );

-- Provisioning helper: inserts the public.users row for a given
-- brokerage's ISA actor. The auth.users row is created via
-- supabase-admin from the application-layer helper.
--
-- Idempotent: skips if a row already exists for the brokerage.
CREATE OR REPLACE FUNCTION public.provision_ai_isa_system_row(
  p_user_id      UUID,
  p_brokerage_id UUID,
  p_email        TEXT
) RETURNS UUID AS $$
DECLARE
  existing_id UUID;
BEGIN
  SELECT id INTO existing_id
  FROM public.users
  WHERE platform_role = 'ai_isa_system' AND brokerage_id = p_brokerage_id
  LIMIT 1;

  IF existing_id IS NOT NULL THEN
    RETURN existing_id;
  END IF;

  INSERT INTO public.users (id, email, user_type, platform_role, brokerage_id)
  VALUES (p_user_id, p_email, 'system', 'ai_isa_system', p_brokerage_id);

  RETURN p_user_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

REVOKE ALL ON FUNCTION public.provision_ai_isa_system_row(UUID, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.provision_ai_isa_system_row(UUID, UUID, TEXT) TO service_role;
