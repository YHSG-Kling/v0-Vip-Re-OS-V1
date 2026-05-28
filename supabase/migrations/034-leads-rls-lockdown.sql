-- =====================================================
-- MIGRATION 034: Lock down RLS on `leads`
-- =====================================================
-- Two policies currently live on `leads`:
--   leads_admin_all   — admin/broker/superadmin within their brokerage
--   leads_agent_own   — agents see their own assigned leads (WRONG)
--
-- Product intent (user-confirmed): agents should NEVER see rows from
-- `leads` directly. Lead lineage reaches the agent via the `contacts`
-- row (after lead → contact conversion) through the
-- `contact_lead_history` view added in migration 039.
--
-- This migration:
--   1. Drops both legacy policies.
--   2. Installs scoped SELECT/INSERT/UPDATE/DELETE policies that
--      use the auth.* helpers from migration 033.
-- =====================================================

DROP POLICY IF EXISTS leads_admin_all ON public.leads;
DROP POLICY IF EXISTS leads_agent_own ON public.leads;

-- SELECT: platform admin (cross-tenant) OR (lead-visible role within brokerage)
CREATE POLICY leads_select ON public.leads
  FOR SELECT
  USING (
    public.is_platform_admin()
    OR (public.is_lead_visible_role() AND public.has_brokerage_access(brokerage_id))
  );

-- INSERT: platform admin, OR AI-ISA system writing within its brokerage,
-- OR a manual entry by a lead-visible role within its brokerage.
CREATE POLICY leads_insert ON public.leads
  FOR INSERT
  WITH CHECK (
    public.is_platform_admin()
    OR (public.is_ai_isa_system()    AND brokerage_id = public.current_user_brokerage_id())
    OR (public.is_lead_visible_role() AND brokerage_id = public.current_user_brokerage_id())
  );

-- UPDATE: same actors. Brokerage cannot be changed by tenant.
CREATE POLICY leads_update ON public.leads
  FOR UPDATE
  USING (
    public.is_platform_admin()
    OR (public.is_ai_isa_system()    AND brokerage_id = public.current_user_brokerage_id())
    OR (public.is_lead_visible_role() AND public.has_brokerage_access(brokerage_id))
  )
  WITH CHECK (
    public.is_platform_admin()
    OR (public.is_ai_isa_system()    AND brokerage_id = public.current_user_brokerage_id())
    OR (public.is_lead_visible_role() AND brokerage_id = public.current_user_brokerage_id())
  );

-- DELETE: only platform admins or brokerage admins (not generic
-- lead-visible roles like compliance_officer).
CREATE POLICY leads_delete ON public.leads
  FOR DELETE
  USING (
    public.is_platform_admin()
    OR (public.is_brokerage_admin() AND public.has_brokerage_access(brokerage_id))
  );

-- Make sure RLS is on (idempotent).
ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;
