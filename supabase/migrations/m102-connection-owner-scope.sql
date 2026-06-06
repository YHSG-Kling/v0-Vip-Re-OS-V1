-- m102-connection-owner-scope.sql
-- Unified connection ownership scope. Replaces the ad-hoc agent_user_id-vs-brokerage_id
-- scoping on platform_credentials with one (owner_type, owner_id) pair that supports the
-- full actor hierarchy: platform | brokerage | team | agent | vendor | contact.
-- Backfilled losslessly from the existing columns. Idempotent.
--
-- NOTE: apply via Supabase tooling (the MCP was disconnected when this was authored).

ALTER TABLE public.platform_credentials
  ADD COLUMN IF NOT EXISTS owner_type text,
  ADD COLUMN IF NOT EXISTS owner_id   text;

-- Backfill from the legacy scoping columns (agent row → agent scope, else brokerage).
UPDATE public.platform_credentials
   SET owner_type = CASE WHEN agent_user_id IS NOT NULL THEN 'agent' ELSE 'brokerage' END,
       owner_id   = CASE WHEN agent_user_id IS NOT NULL THEN agent_user_id::text ELSE brokerage_id::text END
 WHERE owner_type IS NULL;

-- Constrain owner_type to the known actor scopes.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_credentials_owner_type_check'
  ) THEN
    ALTER TABLE public.platform_credentials
      ADD CONSTRAINT platform_credentials_owner_type_check
      CHECK (owner_type IS NULL OR owner_type IN ('platform','brokerage','team','agent','vendor','contact'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS platform_credentials_owner_idx
  ON public.platform_credentials (owner_type, owner_id, platform)
  WHERE is_active;

COMMENT ON COLUMN public.platform_credentials.owner_type IS
  'Connection ownership scope: platform|brokerage|team|agent|vendor|contact. Resolved most-specific-first by lib/connections/resolve-scoped.ts. Vendor/contact may own only social + calendar.';
