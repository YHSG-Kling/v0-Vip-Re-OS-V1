-- =====================================================
-- MIGRATION m276: Retire the dead `user_role` JWT claim
-- =====================================================
-- Context:
--   The TRID / compliance policies from scripts/190 gated access on
--   `auth.jwt() ->> 'user_role' IN ('admin','broker',...)`. Nothing in
--   the codebase ever mints a `user_role` claim (no custom access-token
--   hook exists), so that expression always evaluated to NULL and the
--   role branches were dead. The dashboard-configured HTTP auth hook that
--   was *supposed* to mint the claim could not be reached on the free tier
--   and hard-failed every login ("Failed to reach hook after maximum
--   retries").
--
-- Fix:
--   Drop the dashboard auth hook (done in the Supabase Dashboard:
--   Authentication -> Hooks -> disable the Customize Access Token (JWT)
--   Claims hook), and rewrite these policies onto the canonical,
--   table-driven SECURITY DEFINER helpers from migration 033. These
--   resolve role + tenant from public.users via auth.uid() with zero JWT
--   claims required, so they work on the free plan and stay current when a
--   role changes.
--
--   Standard claims are retained where correct:
--     - auth.uid() replaces (auth.jwt() ->> 'sub')::uuid  (identical value)
--     - service_role bypass is inherent to Supabase RLS and untouched.
--
-- Each table is guarded with to_regclass so a missing table is skipped
-- rather than fatal. `audit_logs` does NOT exist in the live database (the
-- audit table there is `audit_log`, singular, with its own policies), so
-- it is intentionally omitted here.
-- =====================================================

DO $$
BEGIN
  IF to_regclass('public.compliance_checklists') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Compliance checklists viewable by transaction access" ON compliance_checklists;
    CREATE POLICY "Compliance checklists viewable by transaction access" ON compliance_checklists FOR SELECT USING (
      EXISTS (
        SELECT 1 FROM transactions
        WHERE transactions.id = compliance_checklists.transaction_id
        AND transactions.agent_id = auth.uid()
      )
      OR public.is_brokerage_admin()
      OR public.is_platform_admin()
    );
  END IF;

  IF to_regclass('public.agent_certifications') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Agent certifications viewable by owner or admin" ON agent_certifications;
    CREATE POLICY "Agent certifications viewable by owner or admin" ON agent_certifications FOR SELECT USING (
      agent_id = auth.uid()
      OR public.is_brokerage_admin()
      OR public.is_platform_admin()
    );
  END IF;

  IF to_regclass('public.fair_housing_logs') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Fair housing logs viewable by compliance" ON fair_housing_logs;
    CREATE POLICY "Fair housing logs viewable by compliance" ON fair_housing_logs FOR SELECT USING (
      public.is_brokerage_admin()
      OR public.is_compliance_officer_role()
      OR public.is_platform_admin()
    );
  END IF;

  IF to_regclass('public.trid_timeline') IS NOT NULL THEN
    DROP POLICY IF EXISTS "TRID timeline viewable by transaction access" ON trid_timeline;
    CREATE POLICY "TRID timeline viewable by transaction access" ON trid_timeline FOR SELECT USING (
      EXISTS (
        SELECT 1 FROM transactions
        WHERE transactions.id = trid_timeline.transaction_id
        AND transactions.agent_id = auth.uid()
      )
      OR public.is_brokerage_admin()
      OR public.is_platform_admin()
    );
  END IF;

  IF to_regclass('public.compliance_alerts') IS NOT NULL THEN
    DROP POLICY IF EXISTS "Compliance alerts viewable by transaction access" ON compliance_alerts;
    CREATE POLICY "Compliance alerts viewable by transaction access" ON compliance_alerts FOR SELECT USING (
      EXISTS (
        SELECT 1 FROM transactions
        WHERE transactions.id = compliance_alerts.transaction_id
        AND transactions.agent_id = auth.uid()
      )
      OR public.is_brokerage_admin()
      OR public.is_platform_admin()
    );
  END IF;
END $$;
