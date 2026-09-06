-- supabase/migrations/m604-m530-step-2b-never-landed-the-money-gate-still-refuses-a-broker-admin.sql
-- ═════════════════════════════════════════════════════════════════════════════
-- ✅ APPLIED LIVE 2026-09-04 to hrvaqgvukzxfskkcrwbt by the integrator.
--    (CLAUDE.md §3: lanes write migrations, the integrator applies them.)
-- ═════════════════════════════════════════════════════════════════════════════
--
-- ─── THIS IS NOT A NEW RULING. IT IS m530, FINISHED. ─────────────────────────
--
-- Wave 27 recorded an app/DB disagreement on `broker_admin` and left it for the
-- owner, on the reasoning that widening a MONEY predicate is a ruling and not an
-- integrator's tidy-up. Measuring it properly showed that reasoning was wrong
-- about the FACTS: there is no ruling to make, because the ruling was made on
-- 2026-08-22 and m530 wrote it. Step 2b of that migration simply never took
-- effect on the database.
--
-- MEASURED LIVE, 2026-09-04 — occurrences of the literal 'broker_admin' in each
-- of the SEVEN predicates m530 lists (five it rewrites, two it says already name
-- the value):
--
--     can_read_brokerage_books      2   ✓
--     is_brokerage_admin            2   ✓
--     is_lead_visible_role          2   ✓
--     can_write_service_area        1   ✓
--     is_tenant_staff               1   ✓
--     is_tenant_staff_seat          1   ✓
--     is_brokerage_finance_admin    0   ✗   ← the only one
--
-- Six of seven carry it. One carries none. m530's step 2b is written out in full
-- in that file, with `broker_admin` in BOTH branches, and the live body has
-- neither.
--
-- ─── m530 PREDICTED THIS EXACT DEFECT, IN THESE WORDS ────────────────────────
--
-- From its own step-2 header, verbatim:
--
--     "The direction matters and it is not symmetric. `is_brokerage_finance_admin()`
--      is the dangerous one: the APP's roster
--      (lib/auth/resolve-user-role.ts BROKERAGE_FINANCE_ADMIN_USER_TYPES) ALREADY
--      contains broker_admin, so the moment the value is storable the app would
--      admit where RLS refuses — and supabase-js RESOLVES a refused write
--      (CLAUDE.md §3), so the surface would report SUCCESS over a write that
--      touched zero rows. That is the precise defect
--      lib/auth/resolve-user-role.ts documents at its isBrokerageFinanceAdmin
--      header. Applying step 1 WITHOUT step 2 creates it."
--
-- Step 1 (the CHECK) landed. Step 2b did not. So the defect m530 wrote that
-- paragraph to prevent has been live since m530 was applied, and it is worse
-- than the paragraph says: the app's finance gates are not all RLS-bound. Where
-- one runs on the SERVICE client the app predicate is the ONLY gate, so a
-- broker_admin's write to the brokerage's books is REAL there and refused
-- everywhere else — the same seat getting two different answers depending on
-- which client the surface happened to use.
--
-- ─── WHY WIDENING THE DATABASE IS THE FIX, NOT NARROWING THE APP ─────────────
--
-- Three independent facts, none of them an inference from the other two:
--
--   · THE OWNER'S RULING NAMES THE SEAT. 2026-08-22, verbatim: "a brokerage
--     should be changed to 50 seats … where A BROKER ADMIN IS A USER TYPE with
--     differnt permission roles". CLAUDE.md §4's tenant roster has carried
--     `broker_admin` since.
--   · THE APP DERIVES RATHER THAN LISTS. BROKERAGE_FINANCE_ADMIN_USER_TYPES is
--     TENANT_ADMIN_USER_TYPES minus NAMED subtractions — `team_lead` (m472) and
--     `compliance_officer` (2026-09-04). `broker_admin` is not named as a
--     subtraction anywhere, so its presence in the finance tier is the roster
--     working as designed, not an oversight.
--   · THE DATABASE ALREADY GIVES THIS SEAT THE BOOKS-READ. m433's
--     can_read_brokerage_books() names broker_admin in both branches. A seat
--     that may READ the brokerage's books and is refused every WRITE to them is
--     not a coherent line; it is half of m530.
--
-- team_lead and compliance_officer STAY OUT. Those two subtractions are standing
-- rulings (m472; 2026-09-04 + m467's "reads them and does not administer") and
-- this migration does not touch them — asserted at the foot.
--
-- ─── SAFETY, MEASURED THE WAY m472 AND m602 MEASURED IT ──────────────────────
--
-- A widening under a NOT would INVERT into a revocation, so the negation count
-- is measured with an ANCHORED probe rather than a loose ilike. (m602's lane
-- learned this the hard way: `ilike '%not%is_brokerage_admin%'` reported six
-- negations that were all `brokerage_id IS NOT NULL` sitting earlier in the same
-- policy.)
--
--   select
--     count(*) filter (where qual       ~* 'not\s*\(?\s*is_brokerage_finance_admin') as neg_qual,
--     count(*) filter (where with_check ~* 'not\s*\(?\s*is_brokerage_finance_admin') as neg_check,
--     count(*) as referencing, count(distinct tablename) as tables
--   from pg_policies
--   where qual ilike '%is_brokerage_finance_admin%' or with_check ilike '%is_brokerage_finance_admin%';
--
--   → neg_qual 0, neg_check 0, referencing 137, tables 50.
--
-- POSITIVE CONTROL, because a broken regex and a clean set both report zero: the
-- same anchored pattern widened to any `is_*` predicate finds 2 genuinely
-- negated policies elsewhere, so the finder can see a real negation.
--
-- 137 policies over 50 tables all compose this predicate POSITIVELY. Every one
-- of them widens.
--
-- IDEMPOTENT. Safe to re-run. The body below is m530's step 2b verbatim.

begin;

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
    )
    or public.is_tenant_principal_team_lead(),
    false
  );
$function$;

COMMENT ON FUNCTION public.is_brokerage_finance_admin() IS
  'BROKERAGE-WIDE MONEY — may this seat KEEP the brokerage''s books, not merely read them? Reads BOTH role sources: users.user_type AND a user_role_assignments grant PINNED to the caller''s own brokerage (m466 — a grant is an administering fact), plus the m526 tenant-principal team lead, who IS the brokerage on a solo/team tier. Deliberately NARROWER than public.is_brokerage_admin(): team_lead is held out by m472 ("Admin surfaces, but NOT brokerage-wide money") and compliance_officer by the 2026-09-04 ruling plus m467''s own sentence ("a compliance officer reads them and does not administer"). broker_admin was added by m530 step 2b, which never landed on the database until m604 re-applied it — six of m530''s seven predicates carried the value and this one carried none, so the app admitted a seat RLS refused for the whole interval. The app''s mirror is BROKERAGE_FINANCE_ADMIN_USER_TYPES in lib/auth/resolve-user-role.ts and the two must not drift.';

-- ─── VERIFY, RATHER THAN HOPE (CLAUDE.md §7) ───────────────────────────────
--
-- Asserts the RULE and derives the number. A hardcoded role count would be the
-- waypoint §2 forbids — it goes stale the next time the roster moves.
DO $$
DECLARE
  v_fin   text := pg_get_functiondef('public.is_brokerage_finance_admin()'::regprocedure);
  v_admin text := pg_get_functiondef('public.is_brokerage_admin()'::regprocedure);
  v_books text := pg_get_functiondef('public.can_read_brokerage_books()'::regprocedure);
  v_leads text := pg_get_functiondef('public.is_lead_visible_role()'::regprocedure);
  fn_occ  int;
BEGIN
  -- BOTH branches carry it. One occurrence means a one-sided roster, which is
  -- the exact defect m308/m518/m530 each had to come back for.
  fn_occ := (length(v_fin) - length(replace(v_fin, '''broker_admin''', ''))) / length('''broker_admin''');
  IF fn_occ <> 2 THEN
    RAISE EXCEPTION 'is_brokerage_finance_admin() must name broker_admin in BOTH branches, found % occurrence(s)', fn_occ;
  END IF;

  -- POSITIVE CONTROL for that counter: it can already see a role that IS there
  -- twice, so a zero from it would be a real absence and not a broken probe.
  IF (length(v_fin) - length(replace(v_fin, '''broker_owner''', ''))) / length('''broker_owner''') <> 2 THEN
    RAISE EXCEPTION 'POSITIVE CONTROL FAILED — the two-branch counter cannot see broker_owner, so its verdict on broker_admin is not evidence';
  END IF;

  -- THE TWO STANDING SUBTRACTIONS STILL HOLD. Widening for one role must not
  -- have widened for the two the rulings hold out.
  IF position('''team_lead''' in v_fin) > 0 THEN
    RAISE EXCEPTION 'is_brokerage_finance_admin() now names team_lead — m472 holds it out of brokerage-wide money';
  END IF;
  IF position('''compliance_officer''' in v_fin) > 0 THEN
    RAISE EXCEPTION 'is_brokerage_finance_admin() now names compliance_officer — m467/2026-09-04 draw the opposite line (reads the books, does not keep them)';
  END IF;

  -- AND THE SEAT KEEPS WHAT IT ALREADY HAD, in the predicates this does not touch.
  IF position('''broker_admin''' in v_admin) = 0
     OR position('''broker_admin''' in v_books) = 0
     OR position('''broker_admin''' in v_leads) = 0 THEN
    RAISE EXCEPTION 'broker_admin vanished from an untouched predicate — this migration only widens the finance gate';
  END IF;

  -- THE MONEY TIER IS STILL STRICTLY NARROWER THAN THE OPERATIONAL ONE. The
  -- whole point of two predicates is that they are not the same predicate.
  IF position('''team_lead''' in v_admin) = 0 THEN
    RAISE EXCEPTION 'is_brokerage_admin() no longer names team_lead — the two tiers have collapsed into one';
  END IF;

  RAISE NOTICE 'is_brokerage_finance_admin() admits broker_admin in both branches; team_lead and compliance_officer still held out; the untouched predicates are unchanged';
END $$;

commit;
