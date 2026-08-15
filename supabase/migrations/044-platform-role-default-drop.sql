-- =====================================================
-- MIGRATION 044: Drop stale platform_role default
-- =====================================================
-- users.platform_role still defaults to 'user' (predates the
-- platform/brokerage actor split). Migration 036 added a CHECK
-- restricting platform_role to ('superadmin','ai_isa_system',NULL),
-- which makes the default illegal and breaks any trigger-based insert
-- (like handle_new_auth_user) that doesn't explicitly null the column.
--
-- The user_type column already encodes the tenant role; platform_role
-- should default to NULL — only platform-tier actors carry it.
-- =====================================================

ALTER TABLE public.users ALTER COLUMN platform_role DROP DEFAULT;
