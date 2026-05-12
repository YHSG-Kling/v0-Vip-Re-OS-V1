-- ============================================================================
-- Sprint 1 — Tenant Safety Hardening Pass
-- ============================================================================
--
-- Backstory: live-schema audit found 196 tables in public schema that have a
-- `brokerage_id` column but zero RLS policies (RLS itself is enabled, which
-- means auth users get fully locked out — and service_role calls bypass
-- RLS entirely). This is the actual production-ship blocker: every one of
-- 373 createServiceClient() call sites in actions has to filter by
-- brokerage_id by hand. One missed filter = cross-tenant leak.
--
-- This migration installs the safety floor:
--   1. Adds 4 RLS policies (SELECT / INSERT / UPDATE / DELETE) to every
--      unprotected tenanted table, all gated by:
--        brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()
--      The IS NULL leg preserves access to global / platform rows that
--      legitimately don't belong to one brokerage.
--   2. Service-role continues to bypass RLS — every existing action that
--      uses createServiceClient() keeps working. The policies add a second
--      line of defense for any auth.uid()-based query.
--   3. Three cross-tenant tables (lender_portal_users, title_company_users,
--      outside_agents) get bespoke policies that allow self-access via
--      user_id in addition to brokerage_id matching — a lender assigned
--      to multiple brokerages can still read their own row.
--
-- The migration is idempotent (CREATE POLICY IF NOT EXISTS is not standard
-- Postgres, so we DROP-IF-EXISTS then CREATE for each policy) and uses a
-- PL/pgSQL DO block so the list of target tables is driven by
-- information_schema — re-running this migration after new tenanted tables
-- are added will pick them up automatically.
-- ============================================================================

DO $tenant_safety$
DECLARE
  t           text;
  pol_name    text;
  bespoke     text[] := ARRAY[
    'lender_portal_users',
    'title_company_users',
    'outside_agents'
  ];
  tenant_tables CURSOR FOR
    SELECT c.table_name
    FROM information_schema.columns c
    WHERE c.table_schema = 'public'
      AND c.column_name  = 'brokerage_id'
      AND c.table_name NOT IN (
        SELECT tablename FROM pg_policies
        WHERE schemaname = 'public'
          AND (qual ILIKE '%brokerage_id%' OR with_check ILIKE '%brokerage_id%')
      )
      AND c.table_name NOT IN (
        -- already-policed via different pattern OR truly global (no auth tenant)
        'users', 'brokerages'
      );
BEGIN
  FOR t IN tenant_tables LOOP
    -- Bespoke tables get hand-policies below; skip the generic ones for them.
    IF t = ANY(bespoke) THEN
      CONTINUE;
    END IF;

    -- SELECT policy
    pol_name := format('%I_tenant_select', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol_name, t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT USING (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id())',
      pol_name, t
    );

    -- INSERT policy
    pol_name := format('%I_tenant_insert', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol_name, t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR INSERT WITH CHECK (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id())',
      pol_name, t
    );

    -- UPDATE policy
    pol_name := format('%I_tenant_update', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol_name, t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR UPDATE USING (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()) WITH CHECK (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id())',
      pol_name, t
    );

    -- DELETE policy
    pol_name := format('%I_tenant_delete', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', pol_name, t);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR DELETE USING (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id())',
      pol_name, t
    );
  END LOOP;
END
$tenant_safety$;

-- ─── Bespoke policies for cross-tenant tables ─────────────────────────────
-- These tables represent external users (lenders, title officers, cooperating
-- agents) who can be assigned to one or more brokerages but maintain their
-- own user identity. Their row is readable by:
--   (a) themselves (user_id = auth.uid()), or
--   (b) anyone in their assigned brokerage.

DO $bespoke$
BEGIN
  -- lender_portal_users
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='lender_portal_users') THEN
    DROP POLICY IF EXISTS lender_portal_users_self_or_brokerage_select ON public.lender_portal_users;
    CREATE POLICY lender_portal_users_self_or_brokerage_select
      ON public.lender_portal_users
      FOR SELECT
      USING (
        user_id = auth.uid()
        OR brokerage_id = current_user_brokerage_id()
      );

    DROP POLICY IF EXISTS lender_portal_users_self_update ON public.lender_portal_users;
    CREATE POLICY lender_portal_users_self_update
      ON public.lender_portal_users
      FOR UPDATE
      USING (user_id = auth.uid() OR brokerage_id = current_user_brokerage_id())
      WITH CHECK (user_id = auth.uid() OR brokerage_id = current_user_brokerage_id());
  END IF;

  -- title_company_users
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='title_company_users') THEN
    DROP POLICY IF EXISTS title_company_users_self_or_brokerage_select ON public.title_company_users;
    CREATE POLICY title_company_users_self_or_brokerage_select
      ON public.title_company_users
      FOR SELECT
      USING (
        user_id = auth.uid()
        OR brokerage_id = current_user_brokerage_id()
      );

    DROP POLICY IF EXISTS title_company_users_self_update ON public.title_company_users;
    CREATE POLICY title_company_users_self_update
      ON public.title_company_users
      FOR UPDATE
      USING (user_id = auth.uid() OR brokerage_id = current_user_brokerage_id())
      WITH CHECK (user_id = auth.uid() OR brokerage_id = current_user_brokerage_id());
  END IF;

  -- outside_agents — cooperating agents on the other side of a deal.
  -- Read by anyone in the engaging brokerage. No self-update (these rows
  -- are managed by the engaging agent, not the external person).
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='outside_agents') THEN
    DROP POLICY IF EXISTS outside_agents_tenant_select ON public.outside_agents;
    CREATE POLICY outside_agents_tenant_select
      ON public.outside_agents
      FOR SELECT
      USING (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id());

    DROP POLICY IF EXISTS outside_agents_tenant_insert ON public.outside_agents;
    CREATE POLICY outside_agents_tenant_insert
      ON public.outside_agents
      FOR INSERT
      WITH CHECK (brokerage_id = current_user_brokerage_id());

    DROP POLICY IF EXISTS outside_agents_tenant_update ON public.outside_agents;
    CREATE POLICY outside_agents_tenant_update
      ON public.outside_agents
      FOR UPDATE
      USING (brokerage_id = current_user_brokerage_id())
      WITH CHECK (brokerage_id = current_user_brokerage_id());
  END IF;
END
$bespoke$;
