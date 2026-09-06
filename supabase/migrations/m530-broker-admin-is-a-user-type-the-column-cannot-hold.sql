-- m530 — `broker_admin` IS A USER TYPE, AND THE COLUMN CANNOT HOLD IT.
--
-- ─── THE RULING ──────────────────────────────────────────────────────────────
--
-- OWNER, verbatim (2026-08-22), describing the brokerage tier:
--
--   "a brokerage should be changed to 50 seats with a brokerage tier subscription
--    where A BROKER ADMIN IS A USER TYPE with differnt permission roles, then team
--    lead usertype with differnt permission roles then an agent usertype with
--    different permission roles. so that is 3 seats out of 50"
--
-- CLAUDE.md §4 has said the same thing all along: "Tenant roster: broker,
-- broker_admin, broker_owner, team_lead, admin."
--
-- ─── WHAT IS ACTUALLY LIVE (MEASURED 2026-08-22) ─────────────────────────────
--
--   users_user_type_check admits FOURTEEN values:
--     admin, agent, broker, broker_owner, compliance_officer, contact, isa,
--     lender, superadmin, support, system, tc, team_lead, vendor
--
--   `broker_admin` is NOT among them, and the constraint is VALIDATED, so no row
--   was grandfathered in either. Live distribution of user_type, all 23 rows:
--     agent 6 · contact 4 · admin 3 · vendor 2 · system 2 · lender 2 ·
--     broker 1 · tc 1 · compliance_officer 1 · team_lead 1
--
-- ─── THE HISTORY THIS REVERSES, DELIBERATELY ─────────────────────────────────
--
-- This value has been REMOVED from predicates twice, and both removals were
-- correct at the time for exactly one reason — the column could not hold it:
--
--   m308: "IT NAMED 'broker_admin'. users.user_type has never admitted that
--          value" → dropped from is_lead_visible_role().
--   m518: "'broker_admin' STAYS OUT of both branches. It is not a storable
--          user_type" → kept out.
--   m441: measured 48 policies carrying 55 literals that "simply match nobody",
--          chiefly this one.
--
-- Note what NONE of them said: that a broker_admin should not have these rights.
-- Every one of them removed a name that MATCHED NOTHING. The owner has now ruled
-- that it should match something, so the premise of those removals is gone. This
-- migration supplies the missing half (CLAUDE.md §1: when no duplicate exists and
-- the capability is wanted, BUILD the missing half) rather than deleting the
-- app-side roster that has been carrying the intent.
--
-- ─── STEP 1 · MAKE IT STORABLE ───────────────────────────────────────────────

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_user_type_check;

ALTER TABLE public.users ADD CONSTRAINT users_user_type_check CHECK (
  user_type = ANY (ARRAY[
    'admin'::text,
    'agent'::text,
    'broker'::text,
    'broker_admin'::text,   -- m530: the fifteenth value, on the owner's ruling
    'broker_owner'::text,
    'compliance_officer'::text,
    'contact'::text,
    'isa'::text,
    'lender'::text,
    'superadmin'::text,
    'support'::text,
    'system'::text,
    'tc'::text,
    'team_lead'::text,
    'vendor'::text
  ])
);

COMMENT ON CONSTRAINT users_user_type_check ON public.users IS
  'The USER TYPE axis — what a person IS. One per user, and it consumes exactly one subscription seat when it is a staff type. Fifteen values as of m530, which added ''broker_admin'' on the owner''s ruling that it is a user type (CLAUDE.md §4 tenant roster: broker, broker_admin, broker_owner, team_lead, admin). This is NOT the permission axis: grants layered on top of a user type live in public.user_role_assignments.role, and a grant never consumes a seat of its own. A tier restricts HOW MANY seats, never WHICH user types may fill them.';

-- ─── STEP 2 · THE FIVE PREDICATES THAT WOULD NOW UNDER-ADMIT ─────────────────
--
-- MEASURED: eight SECURITY DEFINER functions test a role roster against
-- users.user_type and/or user_role_assignments.role. Two ALREADY name
-- broker_admin and become correct for free the moment the value is storable:
--
--   can_read_brokerage_books()   ✓ already lists it (m433)
--   is_tenant_staff()            ✓ already lists it
--
-- FIVE omit it, every one of them BECAUSE it was unstorable, and each would now
-- refuse a real broker_admin. They are re-stated below with the value added and
-- NOTHING else changed.
--
-- The direction matters and it is not symmetric. `is_brokerage_finance_admin()`
-- is the dangerous one: the APP's roster
-- (lib/auth/resolve-user-role.ts BROKERAGE_FINANCE_ADMIN_USER_TYPES) ALREADY
-- contains broker_admin, so the moment the value is storable the app would admit
-- where RLS refuses — and supabase-js RESOLVES a refused write (CLAUDE.md §3),
-- so the surface would report SUCCESS over a write that touched zero rows. That
-- is the precise defect lib/auth/resolve-user-role.ts documents at its
-- isBrokerageFinanceAdmin header. Applying step 1 WITHOUT step 2 creates it.

-- 2a · the operational tenant-admin gate (m466/m472 lineage)
CREATE OR REPLACE FUNCTION public.is_brokerage_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(
    (select u.user_type in ('admin', 'broker', 'broker_admin', 'broker_owner', 'team_lead')
     from public.users u
     where u.id = auth.uid()
     limit 1)
    or exists (
      select 1
      from public.user_role_assignments ura
      where ura.user_id      = auth.uid()
        and ura.role         in ('admin', 'broker', 'broker_admin', 'broker_owner', 'team_lead')
        and ura.brokerage_id is not null
        and ura.brokerage_id = public.current_user_brokerage_id()
    ),
    false
  );
$function$;

-- 2b · brokerage-wide money (m472). team_lead STAYS OUT — that subtraction is a
--      separate standing ruling and this migration does not touch it.
CREATE OR REPLACE FUNCTION public.is_brokerage_finance_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(
    (select u.user_type in ('admin', 'broker', 'broker_admin', 'broker_owner')
     from public.users u
     where u.id = auth.uid()
     limit 1)
    or exists (
      select 1
      from public.user_role_assignments ura
      where ura.user_id      = auth.uid()
        and ura.role         in ('admin', 'broker', 'broker_admin', 'broker_owner')
        and ura.brokerage_id is not null
        and ura.brokerage_id = public.current_user_brokerage_id()
    ),
    false
  );
$function$;

-- 2c · the lead desk (m308 → m518).
--
--      m518's `team_lead` GRANT IS PRESERVED BYTE-FOR-BYTE IN BOTH BRANCHES.
--      The owner's new ruling permits a team-tier tenant to SEAT a broker; it
--      does not remove the team lead from this predicate, and this predicate has
--      no tier clause and no "…and no broker exists" clause, so seating a broker
--      only ADDS someone who passes. Both rulings hold. See the header of
--      lib/kernel/tier-role-matrix.ts for the full reasoning.
--
--      THIS PREDICATE CANNOT EXPRESS TEAM SCOPE, and m530 does not change that.
--      It takes no row, so admitting team_lead admits them BROKERAGE-WIDE. The
--      narrowing "teams see only their own board" is enforced in the APPLICATION
--      layer by lib/auth/lead-visibility.ts (LeadRowScope + applyLeadRowScope),
--      which pins reads to the team's agents via teams.team_lead_id. A query that
--      reaches `leads` without that resolver is scoped only to the brokerage.
--      Carried forward here verbatim from m518 so the warning travels with the
--      CURRENT definition rather than being two migrations behind it.
CREATE OR REPLACE FUNCTION public.is_lead_visible_role()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
AS $function$
  SELECT
    -- PRIMARY type. 'broker_admin' RESTORED by m530 — the column can hold it now,
    -- which is the one and only reason m308 removed it. 'team_lead' stays (m518).
    COALESCE(
      (SELECT user_type IN ('broker', 'broker_admin', 'broker_owner', 'admin', 'team_lead', 'superadmin')
       FROM public.users WHERE id = auth.uid() LIMIT 1),
      FALSE
    )
    -- ASSIGNED roles (the RBAC table). Same roster in both branches — a
    -- one-sided roster is the defect m308 and m518 each existed to remove.
    OR EXISTS (
      SELECT 1 FROM public.user_role_assignments ura
      WHERE ura.user_id = auth.uid()
        AND ura.role IN ('broker', 'broker_admin', 'broker_owner', 'admin', 'team_lead')
    )
    OR public.is_ai_isa_system()
    OR public.is_platform_admin();
$function$;

COMMENT ON FUNCTION public.is_lead_visible_role() IS
  'May the current user see rows in `leads`? The owner''s process: platform and brokerage roles see LEADS; the AI-ISA system actor qualifies them; once a lead shows positive intent it becomes a CONTACT assigned to an agent, and agents see contacts only — never leads. Reads BOTH role sources (users.user_type AND user_role_assignments), because a user may hold a role by assignment without it being their primary type. m308 dropped ''broker_admin'' because the column could not hold it; m530 RESTORED it to both branches after adding it to users_user_type_check on the owner''s ruling that a broker admin is a user type. m518 added ''team_lead'' to BOTH branches on the owner''s ruling that a team-tier subscription has no broker, so the team lead sees leads — and m530 PRESERVES that: the owner''s later ruling lets a team tenant SEAT a broker, which only adds another person who passes this predicate, since this predicate is per-user and has no tier clause. SCOPE WARNING: this predicate takes no row and therefore admits team_lead BROKERAGE-WIDE; "teams see only their own board" is enforced in the APPLICATION layer by lib/auth/lead-visibility.ts (LeadRowScope + applyLeadRowScope), which pins reads to the team''s agents via teams.team_lead_id. A query that reaches `leads` without that resolver is scoped only to the brokerage.';

-- 2d · service-area writes
CREATE OR REPLACE FUNCTION public.can_write_service_area(p_brokerage_id uuid, p_team_id uuid, p_agent_user_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(
    p_brokerage_id is not null
    and p_brokerage_id = public.current_user_brokerage_id()
    and (
      public.is_brokerage_admin()
      or exists (
        select 1
        from   public.user_role_assignments ura
        where  ura.user_id      = auth.uid()
          and  ura.role         in ('admin','broker','broker_admin','broker_owner')
          and  ura.brokerage_id = p_brokerage_id
      )
      or (p_agent_user_id is not null and p_agent_user_id = auth.uid())
      or (
        p_agent_user_id is null
        and p_team_id is not null
        and exists (
          select 1
          from   public.teams t
          where  t.id           = p_team_id
            and  t.brokerage_id = p_brokerage_id
            and  t.deleted_at   is null
            and  t.team_lead_id = auth.uid()
        )
      )
    ),
    false
  )
$function$;

-- 2e · the staff-seat roster.
--
--      UNRESOLVED AND DELIBERATELY NOT WIDENED HERE: this roster also carries
--      'title_agent', 'support' and 'superadmin', none of which are in the
--      application's SEAT_ROLES (lib/kernel/tier-role-matrix.ts), and it is a
--      THIRD spelling of "does this person occupy a seat" alongside SEAT_ROLES
--      and is_tenant_staff(). That is a CLAUDE.md §6 finding in its own right and
--      is reported rather than silently reconciled — changing who counts as a
--      seat changes what tenants are billed, which is not this migration's
--      ruling to make. Only the broker_admin omission is corrected.
CREATE OR REPLACE FUNCTION public.is_tenant_staff_seat()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(
    (select user_type in ('agent','isa','tc','team_lead','broker','broker_admin','broker_owner',
                          'admin','compliance_officer','title_agent','support','superadmin')
     from public.users where id = auth.uid() limit 1),
    false
  );
$function$;

-- ─── STEP 3 · VERIFY, RATHER THAN HOPE (CLAUDE.md §7) ────────────────────────

DO $$
DECLARE
  v_storable   boolean;
  v_missing    text[];
  v_fn         text;
BEGIN
  -- 3a · the value is storable.
  --
  -- Read back what the DATABASE now holds, not what this file typed above — a
  -- constraint that failed to install, or was installed under a different name,
  -- leaves v_storable NULL and this raises. That is the positive control: drop
  -- the ADD CONSTRAINT and this block goes red.
  SELECT pg_get_constraintdef(oid) LIKE '%''broker_admin''%'
    INTO v_storable
    FROM pg_constraint
   WHERE conrelid = 'public.users'::regclass
     AND conname  = 'users_user_type_check';

  IF NOT COALESCE(v_storable, false) THEN
    RAISE EXCEPTION 'm530(3a): users_user_type_check is missing or does not admit ''broker_admin'' — every write of that user type would be refused entirely (PGRST204 shape). Refusing.';
  END IF;

  -- 3b · every one of the five predicates now names it, and the two that
  --      already did still do. Seven functions, checked by reading their bodies.
  v_missing := ARRAY[]::text[];
  FOREACH v_fn IN ARRAY ARRAY[
    'is_brokerage_admin', 'is_brokerage_finance_admin', 'is_lead_visible_role',
    'can_write_service_area', 'is_tenant_staff_seat',
    'can_read_brokerage_books', 'is_tenant_staff'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.proname = v_fn
        AND pg_get_functiondef(p.oid) LIKE '%broker_admin%'
    ) THEN
      v_missing := v_missing || v_fn;
    END IF;
  END LOOP;

  IF array_length(v_missing, 1) IS NOT NULL THEN
    RAISE EXCEPTION 'm530(3b): these predicates still omit broker_admin, so a real broker_admin would be refused by RLS while the app admits them: %', v_missing;
  END IF;

  -- 3c · m518 SURVIVES. This is the assertion the owner asked for by name: the
  --      team lead's lead desk must not be lost to this wave.
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'is_lead_visible_role'
      AND (length(pg_get_functiondef(p.oid))
           - length(replace(pg_get_functiondef(p.oid), 'team_lead', ''))) / length('team_lead') >= 2
  ) THEN
    RAISE EXCEPTION 'm530(3c): is_lead_visible_role() no longer names team_lead in BOTH branches — m518 has been reverted. Refusing.';
  END IF;

  RAISE NOTICE 'm530 OK — broker_admin storable; 7 predicates name it; m518 team_lead grant intact in both branches.';
END $$;

-- ─── AFTER APPLYING ──────────────────────────────────────────────────────────
--
-- REGENERATE THE VOCABULARY CACHE (CLAUDE.md §3):
--
--     npm run schema:regen:vocabularies
--
-- This is NOT optional bookkeeping here — it is load-bearing. The invite menu is
-- intersected with `CHECK_VOCABULARIES.users.user_type`
-- (lib/kernel/tier-role-matrix.ts `seatableUserTypes`), which is how the app
-- avoids offering a user type the column cannot store. Until the cache is
-- regenerated, broker_admin remains storable in the DATABASE but still hidden
-- from every invite surface — a safe state, and a stuck one.
