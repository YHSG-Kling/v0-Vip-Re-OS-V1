-- =====================================================
-- MIGRATION 043: Cache ISA system actor on brokerages
-- =====================================================
-- Migration 037 created the per-brokerage AI-ISA system user shape
-- (platform_role='ai_isa_system') and the provision_ai_isa_system_row
-- helper, but the application code has no way to look up "which auth
-- user IS the ISA actor for this brokerage" without an extra round-trip
-- to public.users.
--
-- This migration adds a direct pointer + a unique constraint so each
-- brokerage maps to exactly one ISA actor.
-- =====================================================

ALTER TABLE public.brokerages
  ADD COLUMN IF NOT EXISTS ai_isa_system_user_id UUID;

-- One ISA actor per brokerage at most (NULL allowed; UNIQUE NULLs are
-- treated as distinct by Postgres, so this is safe).
ALTER TABLE public.brokerages
  DROP CONSTRAINT IF EXISTS brokerages_ai_isa_system_user_id_unique;
ALTER TABLE public.brokerages
  ADD CONSTRAINT brokerages_ai_isa_system_user_id_unique
  UNIQUE (ai_isa_system_user_id);

-- Foreign key into public.users so cleanup propagates. We do NOT FK
-- into auth.users from public schema because of permission limits on
-- the auth schema; the public.users → auth.users mirror handles that.
ALTER TABLE public.brokerages
  DROP CONSTRAINT IF EXISTS brokerages_ai_isa_system_user_id_fkey;
ALTER TABLE public.brokerages
  ADD CONSTRAINT brokerages_ai_isa_system_user_id_fkey
  FOREIGN KEY (ai_isa_system_user_id) REFERENCES public.users(id) ON DELETE SET NULL;
