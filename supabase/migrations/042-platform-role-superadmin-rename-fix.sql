-- =====================================================
-- MIGRATION 042: Repair policies referencing the
-- pre-normalization platform_role = 'super_admin'
-- =====================================================
-- Migration 036 normalized platform_role values:
--   'super_admin' -> 'superadmin'
-- and added a CHECK constraint that disallows 'super_admin'.
--
-- Two pre-existing policies still compare platform_role to the
-- old literal, so they now fail-closed for the platform admin:
--   platform_settings."Super admins can modify platform settings"
--   ai_usage_monthly."Users can view their subscription tier usage"
--
-- Replace those checks with public.is_platform_admin(), which is
-- the canonical helper (and tolerates either spelling under the
-- hood).
-- =====================================================

-- platform_settings
DROP POLICY IF EXISTS "Super admins can modify platform settings" ON public.platform_settings;
CREATE POLICY platform_admin_modify_platform_settings
  ON public.platform_settings FOR ALL
  USING (public.is_platform_admin())
  WITH CHECK (public.is_platform_admin());

-- ai_usage_monthly — rewrite the existing complex policy with the
-- platform-admin branch updated. The other branches (subscription
-- tier admin / agent / team / brokerage membership) are unchanged.
DROP POLICY IF EXISTS "Users can view their subscription tier usage" ON public.ai_usage_monthly;
CREATE POLICY ai_usage_monthly_view
  ON public.ai_usage_monthly FOR SELECT
  USING (
    public.is_platform_admin()
    OR brokerage_id IN (
      SELECT ai_subscription_tier.brokerage_id
      FROM public.ai_subscription_tier
      WHERE ai_subscription_tier.admin_user_id = auth.uid()
        AND ai_subscription_tier.is_active = TRUE
    )
    OR team_id IN (
      SELECT ai_subscription_tier.team_id
      FROM public.ai_subscription_tier
      WHERE ai_subscription_tier.admin_user_id = auth.uid()
        AND ai_subscription_tier.is_active = TRUE
    )
    OR agent_id IN (
      SELECT ai_subscription_tier.agent_id
      FROM public.ai_subscription_tier
      WHERE ai_subscription_tier.admin_user_id = auth.uid()
        AND ai_subscription_tier.is_active = TRUE
    )
    OR brokerage_id IN (
      SELECT b.id FROM public.brokerages b
      JOIN public.agents a ON a.brokerage_id = b.id
      WHERE a.user_id = auth.uid()
    )
    OR team_id IN (
      SELECT t.id FROM public.teams t
      JOIN public.agents a ON a.team_id = t.id
      WHERE a.user_id = auth.uid()
    )
    OR agent_id IN (
      SELECT agents.id FROM public.agents
      WHERE agents.user_id = auth.uid()
    )
  );
