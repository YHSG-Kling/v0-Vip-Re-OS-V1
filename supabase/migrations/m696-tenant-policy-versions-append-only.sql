-- ── APPLIED LIVE 2026-10-04 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — table, RLS, indexes, function as m696a (apply_migration); trigger via execute_sql with lock_timeout ──
--
-- m696 — THE VERSIONED TENANT OPERATING CONSTITUTION: one immutable version row per change of a
-- tenant operating-policy key (wave 101, lane 101A; docs/architecture/OS-BLUEPRINT-GAP-MAP.md rows
-- 21 and 22; OS-CONSTITUTION LAW 5).
--
-- The LIVE value of every policy stays in the store that already holds it, and every reader is
-- unchanged (LAW 1): brokerage_settings.settings keys, the brokerage_settings policy columns,
-- managed_agents.config (authority_level / autonomy_tier) and ai_isa_settings. This table is the
-- HISTORY beside them. Its ONE writer is lib/kernel/tenant-policy.ts::appendTenantPolicyVersion,
-- called by the survivor writers only (lib/settings/brokerage-settings-merge.ts mergeBrokerageSettings,
-- lib/settings/brokerage-settings-columns.ts, app/actions/admin/manager-evals.ts
-- setManagerAuthorityLevel / setManagerAutonomy, lib/ai-isa/resolve-isa-settings.ts writeIsaSettings).
-- Readers: lib/kernel/tenant-policy.ts policyHistory / getTenantOperatingConstitution (the
-- read-only panel on app/dashboard/admin/manager-trust). A revert writes a NEW version.
--
-- · UNIQUE (brokerage_id, policy_key, version): the appender reads max(version) and inserts n+1;
--   a concurrent appender loses on 23505 and re-reads.
-- · value / previous are NULLABLE: NULL means "the default / no stored value" (a cleared key).
-- · actor_type is the agent_action_ledger vocabulary (m687) — one spelling per idea (§6).
-- · Writes are service-role only (no INSERT/UPDATE/DELETE policy): a session client cannot forge
--   or rewrite history. Reads are tenant-scoped (has_brokerage_access) or platform staff.
-- · APPEND-ONLY (the m689 pattern): a direct UPDATE or DELETE is refused. A referential action
--   arriving from a deleted parent (brokerage ON DELETE CASCADE, users ON DELETE SET NULL) runs
--   nested in the RI trigger (pg_trigger_depth() > 1) and is let through, so deleting a tenant or
--   a user keeps working.
--
-- Until applied the appender's insert resolves 42P01 / PGRST205: the policy write still lands in
-- its survivor (reads unchanged) and the lost version is reported back to the caller.
--
-- Apply in TWO parts (wave 98 rule): PART A (table + RLS), then PART B (indexes + trigger).
-- AFTER APPLYING: regenerate the vocabulary cache (actor_type CHECK, policy_key format CHECK),
-- the schema snapshot, LIVE_TABLES and the FK map (two new FKs).

-- ══════════════════════════════ PART A — table, CHECKs, RLS ══════════════════════════════

CREATE TABLE IF NOT EXISTS public.tenant_policy_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  brokerage_id uuid NOT NULL REFERENCES public.brokerages(id) ON DELETE CASCADE,
  policy_key   text NOT NULL,
  version      integer NOT NULL,
  value        jsonb,
  previous     jsonb,
  changed_by   uuid REFERENCES public.users(id) ON DELETE SET NULL,
  actor_type   text NOT NULL DEFAULT 'user',
  reason       text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tenant_policy_versions_brokerage_key_version_key UNIQUE (brokerage_id, policy_key, version),
  CONSTRAINT tenant_policy_versions_version_check CHECK (version >= 1),
  CONSTRAINT tenant_policy_versions_actor_type_check
    CHECK (actor_type IN ('manager', 'user', 'agent', 'system')),
  CONSTRAINT tenant_policy_versions_policy_key_format_check
    CHECK (policy_key ~ '^[a-z][a-z0-9_]*(:[a-z0-9_-]+)*$')
);

ALTER TABLE public.tenant_policy_versions ENABLE ROW LEVEL SECURITY;

REVOKE INSERT, UPDATE, DELETE ON public.tenant_policy_versions FROM anon, authenticated;

DROP POLICY IF EXISTS tenant_policy_versions_select ON public.tenant_policy_versions;
CREATE POLICY tenant_policy_versions_select ON public.tenant_policy_versions
  FOR SELECT TO authenticated
  USING (is_platform_admin() OR has_brokerage_access(brokerage_id));

COMMENT ON TABLE public.tenant_policy_versions IS
  'Append-only version history of tenant operating-policy keys (live values stay in their stores). Writer lib/kernel/tenant-policy.ts appendTenantPolicyVersion; readers policyHistory / getTenantOperatingConstitution. m696.';

-- ══════════════════════════════ PART B — indexes, append-only trigger ══════════════════════════════

CREATE INDEX IF NOT EXISTS idx_tpv_brokerage_created
  ON public.tenant_policy_versions (brokerage_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tpv_changed_by
  ON public.tenant_policy_versions (changed_by) WHERE changed_by IS NOT NULL;

CREATE OR REPLACE FUNCTION public.tenant_policy_versions_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  -- Referential actions (cascade from a deleted brokerage, set-null from a deleted user) arrive
  -- nested in the RI trigger.
  IF pg_trigger_depth() > 1 THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  RAISE EXCEPTION 'tenant_policy_versions % is append-only: % refused — a change (or a revert) is a NEW version row', OLD.id, TG_OP
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS tenant_policy_versions_append_only ON public.tenant_policy_versions;
CREATE TRIGGER tenant_policy_versions_append_only
  BEFORE UPDATE OR DELETE ON public.tenant_policy_versions
  FOR EACH ROW EXECUTE FUNCTION public.tenant_policy_versions_append_only();
