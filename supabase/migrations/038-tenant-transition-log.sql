-- =====================================================
-- MIGRATION 038: Tenant transition audit log
-- =====================================================
-- Cross-brokerage transitions (recruit → active agent, future
-- team-absorption, etc.) need an immutable audit trail. The
-- provisioning code in app/api/recruiting/provision-agent/route.ts
-- doesn't currently write one.
-- =====================================================

CREATE TABLE IF NOT EXISTS public.tenant_transition_log (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id      UUID        NOT NULL,
  action             TEXT        NOT NULL,  -- 'provision_recruit', 'absorb_team', ...
  entity_type        TEXT        NOT NULL,  -- 'recruit', 'agent', 'team'
  entity_id          UUID,
  from_brokerage_id  UUID,
  to_brokerage_id    UUID,
  row_count_moved    INTEGER,
  metadata           JSONB,
  at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_transition_log_actor
  ON public.tenant_transition_log (actor_user_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_transition_log_to_brokerage
  ON public.tenant_transition_log (to_brokerage_id, at DESC);

ALTER TABLE public.tenant_transition_log ENABLE ROW LEVEL SECURITY;

-- Platform admin sees everything. Brokerage admin sees rows where
-- either side of the move involved their brokerage.
CREATE POLICY tenant_transition_log_select ON public.tenant_transition_log
  FOR SELECT
  USING (
    public.is_platform_admin()
    OR (
      public.is_brokerage_admin()
      AND (
        from_brokerage_id = public.current_user_brokerage_id()
        OR to_brokerage_id = public.current_user_brokerage_id()
      )
    )
  );

-- Only platform admin / service-role can write directly. Application
-- writers should use service-role inside a vetted server-only path.
CREATE POLICY tenant_transition_log_insert ON public.tenant_transition_log
  FOR INSERT
  WITH CHECK (public.is_platform_admin());
