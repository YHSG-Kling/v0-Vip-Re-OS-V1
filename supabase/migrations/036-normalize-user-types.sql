-- =====================================================
-- MIGRATION 036: Normalize legacy user_type synonyms
-- =====================================================
-- The DB currently carries several legacy / casing-drift values:
--   - 'TC'                 -> 'tc'
--   - 'compliance_manager' -> 'compliance_officer'   (user-confirmed synonyms)
--   - 'team_leader'        -> 'team_lead'            (existing code paths use both)
--   - 'super_admin'        -> 'superadmin'           (platform_role canonical)
--
-- After normalization, we lock the column with a CHECK so new drift
-- can't appear. platform_role gets its own CHECK.
--
-- We DO NOT drop the legacy `users.role` column in this migration —
-- a separate code-side cleanup is required first (resolveUserRole
-- still falls back to `role`). That drop is deferred to a follow-up
-- migration once the resolveUserRole change has shipped.
-- =====================================================

-- 1. Backfill.
UPDATE public.users SET user_type = 'tc'                 WHERE user_type = 'TC';
UPDATE public.users SET user_type = 'compliance_officer' WHERE user_type = 'compliance_manager';
UPDATE public.users SET user_type = 'team_lead'          WHERE user_type = 'team_leader';

-- platform_role normalization.
UPDATE public.users SET platform_role = 'superadmin'
  WHERE platform_role IN ('super_admin');

-- 2. CHECK constraints (drop+recreate, idempotent).
ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_user_type_check;
ALTER TABLE public.users
  ADD CONSTRAINT users_user_type_check
  CHECK (user_type IN (
    'agent', 'broker', 'broker_owner', 'admin',
    'tc', 'team_lead', 'compliance_officer',
    'vendor', 'lender', 'title_agent',
    'contact', 'isa', 'system',
    'superadmin'  -- platform users sometimes ride on user_type too
  ));

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_platform_role_check;
ALTER TABLE public.users
  ADD CONSTRAINT users_platform_role_check
  CHECK (platform_role IS NULL OR platform_role IN ('superadmin', 'ai_isa_system'));
