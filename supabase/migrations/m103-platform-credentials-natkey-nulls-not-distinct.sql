-- m103-platform-credentials-natkey-nulls-not-distinct.sql
-- Fix the platform_credentials natural-key so credential UPSERTs work.
--
-- The connect flows (Settings → Add Credential, OAuth callback, IDX Broker) upsert
-- with ON CONFLICT targets that had NO matching unique index, so every one of those
-- writes failed at runtime with 42P10. The only real unique key was
-- (brokerage_id, agent_user_id, platform) with default NULLS DISTINCT semantics,
-- which also meant brokerage-scoped rows (agent_user_id IS NULL) never deduped.
--
-- Replace it with a NULLS NOT DISTINCT unique constraint on the same columns so:
--   * agent-scoped rows  (agent_user_id set)  upsert idempotently per agent
--   * brokerage-scoped rows (agent_user_id NULL) upsert idempotently per brokerage
-- and ON CONFLICT (brokerage_id, agent_user_id, platform) resolves to a real key.
-- Idempotent.

-- 1. Collapse any pre-existing duplicates (keep the most recently updated row per key)
--    so the tighter NULLS NOT DISTINCT constraint can be created.
DELETE FROM public.platform_credentials a
 USING public.platform_credentials b
 WHERE a.brokerage_id  IS NOT DISTINCT FROM b.brokerage_id
   AND a.agent_user_id IS NOT DISTINCT FROM b.agent_user_id
   AND a.platform = b.platform
   AND (
        COALESCE(a.updated_at, a.created_at, 'epoch'::timestamptz)
          < COALESCE(b.updated_at, b.created_at, 'epoch'::timestamptz)
        OR (
          COALESCE(a.updated_at, a.created_at, 'epoch'::timestamptz)
            = COALESCE(b.updated_at, b.created_at, 'epoch'::timestamptz)
          AND a.ctid < b.ctid
        )
   );

-- 2. Swap the constraint.
ALTER TABLE public.platform_credentials
  DROP CONSTRAINT IF EXISTS platform_credentials_brokerage_id_agent_user_id_platform_key;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'platform_credentials_owner_natkey'
  ) THEN
    ALTER TABLE public.platform_credentials
      ADD CONSTRAINT platform_credentials_owner_natkey
      UNIQUE NULLS NOT DISTINCT (brokerage_id, agent_user_id, platform);
  END IF;
END $$;

COMMENT ON CONSTRAINT platform_credentials_owner_natkey ON public.platform_credentials IS
  'Natural key for credential upserts. NULLS NOT DISTINCT so brokerage-scoped rows '
  '(agent_user_id NULL) dedupe. ON CONFLICT (brokerage_id, agent_user_id, platform).';
