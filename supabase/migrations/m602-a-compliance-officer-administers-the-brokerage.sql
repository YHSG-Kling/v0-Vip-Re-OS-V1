-- supabase/migrations/m602-a-compliance-officer-administers-the-brokerage.sql
-- ═══════════════════════════════════════════════════════════════════════════
-- WRITTEN BY LANE ROSTER (wave 27). **APPLIED LIVE 2026-09-04** by the
-- integrator to hrvaqgvukzxfskkcrwbt, after the safety measurement below was
-- re-run with an anchored probe (the lane's loose one reported six negations
-- that were all `IS NOT NULL`). The verification DO-block at the foot ran
-- against the applied definition and raised nothing: compliance_officer appears
-- in BOTH branches of is_brokerage_admin(), the positive control sees
-- broker_owner twice, and the finance, books and lead-desk predicates are
-- unchanged. CLAUDE.md §3: lanes write migrations, only the integrator applies
-- them — this one is now applied, and the app and the database agree.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- OWNER RULING, 2026-09-04, verbatim:
--
--   "there is a compliance officer for tenant staff which was not included."
--
-- The app half landed in the same wave: `compliance_officer` joins
-- TENANT_ADMIN_USER_TYPES (lib/auth/resolve-user-role.ts). This file is the SQL
-- half, and it exists for one reason only — the app roster and
-- public.is_brokerage_admin() must not disagree.
--
-- ── WHY THE APP HALF ALONE IS A DEFECT, NOT A HALF-FIX ─────────────────────
--
-- After the app change and before this migration, the app roster admits a role
-- that is_brokerage_admin() refuses. That gap runs in BOTH bad directions at
-- once, and neither is visible without reading for it:
--
--   · RLS-BOUND CALLERS. supabase-js RESOLVES a refused statement (§3). A
--     compliance officer admitted by the app then hits an operational policy
--     that composes is_brokerage_admin(): a SELECT comes back as ZERO ROWS with
--     `error` null, which renders as "your brokerage has nothing here" rather
--     than as a refusal.
--   · SERVICE-CLIENT CALLERS. Several operational gates run on the service
--     client, which BYPASSES RLS entirely. There the app predicate is the only
--     gate, so the widening is fully effective — and the two halves of the same
--     ruling then behave differently depending on which client the surface
--     happened to use. That inconsistency is the thing this closes.
--
-- ── SCOPE: ONE FUNCTION. THE OTHER THREE ARE DELIBERATELY NOT TOUCHED ──────
--
--   public.is_brokerage_admin()          WIDENED here, both branches.
--
--   public.is_brokerage_finance_admin()  NOT TOUCHED. m472 keeps the 49 finance
--       tables narrow, and m467's can_read_brokerage_books() ALREADY admits
--       compliance_officer with the sentence "a compliance officer reads them
--       and does not administer". Reading the books stays granted; keeping them
--       stays refused. The app mirrors this exactly —
--       BROKERAGE_FINANCE_ADMIN_USER_TYPES subtracts the role by name
--       (ROLES_HELD_OUT_OF_BROKERAGE_MONEY).
--
--   public.is_lead_visible_role()        NOT TOUCHED. CLAUDE.md §5: leads belong
--       to the brokerage and reach an agent only once qualified. Regulatory
--       governance is not a stage of the lead desk, and lib/auth/lead-visibility.ts
--       has named compliance_officer as deliberately absent since it was written.
--       The app mirrors this too (NOT_LEAD_DESK_USER_TYPES).
--
--   public.is_tenant_staff_seat()        ALREADY LISTS compliance_officer
--       (m530 step 2e). Nothing to do; noted so a reader does not go looking.
--
-- ── WHY WIDENING IS SAFE HERE, MEASURED THE WAY m472 MEASURED IT ──────────
--
-- The lane could not query the live database, so it asked the integrator to
-- re-measure m472's "0 policies negate this predicate" before applying. That was
-- the right instruction and the wrong probe, and both halves are recorded here
-- because the guard-that-cannot-see problem (§2) applies to a one-off SQL probe
-- exactly as it does to a script.
--
-- THE LANE'S PROBE WAS `ilike '%not%is_brokerage_admin%'`. Run live on
-- 2026-09-04 it reported 3 negated quals and 3 negated with_checks — which
-- would have meant STOP. All six were FALSE POSITIVES: `not` matched
-- `brokerage_id IS NOT NULL`, which sits before the predicate in five policies
-- on `scripts`, `prohibited_phrases` and `support_tickets`. A loose ilike over
-- SQL text cannot tell a negation from an adjacent NOT NULL.
--
-- MEASURED, 2026-09-04, hrvaqgvukzxfskkcrwbt, with the anchored form:
--
--   select
--     count(*) filter (where qual       ~* 'not\s*\(?\s*is_brokerage_admin') as neg_qual,
--     count(*) filter (where with_check ~* 'not\s*\(?\s*is_brokerage_admin') as neg_check,
--     count(*) as referencing, count(distinct tablename) as tables
--   from pg_policies
--   where qual ilike '%is_brokerage_admin%' or with_check ilike '%is_brokerage_admin%';
--
--   → neg_qual 0, neg_check 0, referencing 84, tables 61.
--
-- POSITIVE CONTROL, because a broken regex and a clean tree both report zero:
-- the same anchored pattern widened to any `is_*` predicate finds 2 genuinely
-- negated policies elsewhere in the set, so the finder can see a real negation
-- and its zero here is evidence rather than silence.
--
-- The denominator moved too, and that is the finding, not a discrepancy to hide:
-- m472's header recorded 226 policies over 113 tables. It is 84 over 61 today,
-- because m472 itself moved the money tables to is_brokerage_finance_admin().
-- Fewer policies compose this predicate than when that number was written, which
-- makes the widening narrower than m472's note implies, not wider.
--
-- A widening under a NOT would INVERT into a revocation. There are none, so this
-- widens. If a future re-run of the anchored probe is not 0, STOP.
--
-- ── BOTH BRANCHES, ALWAYS ─────────────────────────────────────────────────
--
-- m466 made a role GRANT an administering fact, and m308/m518/m530 each had to
-- come back and fix a predicate that carried its roster in only one branch. A
-- one-sided roster admits one spelling of the same seat and refuses the other.
-- The role list below is identical in the user_type branch and the grant branch,
-- which is also what the app does (isAdminOrBroker and isTenantAdminGrantRole
-- read the SAME Set).
--
-- IDEMPOTENT. Safe to re-run. Definition copied from m530 step 2a with one value
-- added to each branch, so the diff against the live body is exactly two strings.

begin;

CREATE OR REPLACE FUNCTION public.is_brokerage_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select coalesce(
    (select u.user_type in ('admin', 'broker', 'broker_admin', 'broker_owner', 'team_lead', 'compliance_officer')
     from public.users u
     where u.id = auth.uid()
     limit 1)
    or exists (
      select 1
      from public.user_role_assignments ura
      where ura.user_id      = auth.uid()
        and ura.role         in ('admin', 'broker', 'broker_admin', 'broker_owner', 'team_lead', 'compliance_officer')
        and ura.brokerage_id is not null
        and ura.brokerage_id = public.current_user_brokerage_id()
    ),
    false
  );
$function$;

COMMENT ON FUNCTION public.is_brokerage_admin() IS
  'Does the current user ADMINISTER their own brokerage (operational surfaces — support, onboarding, assignment rules, roster, marketing, settings)? Reads BOTH role sources: users.user_type AND a user_role_assignments grant PINNED to the caller''s own brokerage (m466 — a grant is an administering fact). NOT the money question: public.is_brokerage_finance_admin() (m472) governs the 49 finance tables and holds out team_lead and compliance_officer, while public.can_read_brokerage_books() (m467) admits a compliance officer to READ them. m472 added team_lead; m530 restored broker_admin once the column could hold it; this migration added compliance_officer on the owner''s 2026-09-04 ruling that the compliance officer is tenant staff. The app''s mirror is TENANT_ADMIN_USER_TYPES in lib/auth/resolve-user-role.ts and the two must not drift.';

-- ─── VERIFY, RATHER THAN HOPE (CLAUDE.md §7) ───────────────────────────────
--
-- Asserts the RULE, not a count: the roster is the same in both branches, and
-- the two roles the standing rulings hold out of the NARROWER predicates are
-- still held out of them. A hardcoded role count here would be the waypoint
-- CLAUDE.md §2 forbids — it would go stale the next time the roster moves.
DO $$
DECLARE
  v_admin   text := pg_get_functiondef('public.is_brokerage_admin()'::regprocedure);
  v_finance text := pg_get_functiondef('public.is_brokerage_finance_admin()'::regprocedure);
  v_leads   text := pg_get_functiondef('public.is_lead_visible_role()'::regprocedure);
  v_books   text := pg_get_functiondef('public.can_read_brokerage_books()'::regprocedure);
BEGIN
  -- BOTH branches of the admin gate carry the new role. One occurrence means a
  -- one-sided roster, which is the exact defect m308/m518/m530 each came back for.
  IF (length(v_admin) - length(replace(v_admin, '''compliance_officer''', '')))
     / length('''compliance_officer''') <> 2 THEN
    RAISE EXCEPTION 'is_brokerage_admin() must name compliance_officer in BOTH branches, found % occurrence(s)',
      (length(v_admin) - length(replace(v_admin, '''compliance_officer''', ''))) / length('''compliance_officer''');
  END IF;

  -- POSITIVE CONTROL for the counter above: it can see a role that IS there
  -- twice already, so a zero from it would be a real absence and not a broken probe.
  IF (length(v_admin) - length(replace(v_admin, '''broker_owner''', '')))
     / length('''broker_owner''') <> 2 THEN
    RAISE EXCEPTION 'POSITIVE CONTROL FAILED — the two-branch counter cannot see broker_owner, so its verdict on compliance_officer is not evidence';
  END IF;

  -- THE MONEY LINE HOLDS. Widening the operational gate must not have widened
  -- the books-keeping gate, and a compliance officer must still READ the books.
  IF position('''compliance_officer''' in v_finance) > 0 THEN
    RAISE EXCEPTION 'is_brokerage_finance_admin() now names compliance_officer — m472/m467 draw the opposite line (reads the books, does not keep them)';
  END IF;
  IF position('''compliance_officer''' in v_books) = 0 THEN
    RAISE EXCEPTION 'can_read_brokerage_books() no longer names compliance_officer — m467 granted that read and this migration does not revoke it';
  END IF;

  -- THE LEAD DESK LINE HOLDS (CLAUDE.md §5).
  IF position('''compliance_officer''' in v_leads) > 0 THEN
    RAISE EXCEPTION 'is_lead_visible_role() now names compliance_officer — leads belong to the brokerage sales lane, not the compliance lane';
  END IF;

  RAISE NOTICE 'is_brokerage_admin() admits compliance_officer in both branches; finance, books and lead-desk predicates unchanged';
END $$;

commit;
