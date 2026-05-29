-- m104-platform-credentials-owner-unique-key.sql
-- Re-key platform_credentials onto the unified OWNER identity. The table enforced
-- (brokerage_id, agent_user_id, platform) NULLS NOT DISTINCT, which blocks two non-agent owners
-- (e.g. a vendor connecting their own email AND the brokerage's email) from coexisting in one
-- brokerage. Replace it with a partial unique index on (owner_type, owner_id, platform) so every
-- owner scope (agent/team/brokerage/vendor/contact/platform) is independently unique. All
-- platform_credentials writers do owner-keyed update-or-insert (no onConflict). Idempotent.

ALTER TABLE public.platform_credentials DROP CONSTRAINT IF EXISTS platform_credentials_owner_natkey;

CREATE UNIQUE INDEX IF NOT EXISTS platform_credentials_owner_uniq
  ON public.platform_credentials (owner_type, owner_id, platform)
  WHERE owner_type IS NOT NULL;
