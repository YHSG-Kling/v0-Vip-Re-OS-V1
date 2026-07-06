-- l19-s01-platform-role-admin-marketing.sql
-- ─────────────────────────────────────────────────────────────────────────────
-- Expand the platform-staff role set so superadmin can assign platform ADMIN and
-- MARKETING employees (in addition to superadmin + support). platform_role is the
-- canonical platform-staff marker (distinct from tenant user_type); its CHECK now
-- allows admin/marketing/support. Capability gating lives in
-- lib/platform/platform-staff-roster.ts (platformStaffCan). Idempotent.

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_platform_role_check;
ALTER TABLE public.users ADD CONSTRAINT users_platform_role_check
  CHECK (platform_role IS NULL OR platform_role = ANY (ARRAY['superadmin','admin','marketing','support','ai_isa_system']::text[]));
