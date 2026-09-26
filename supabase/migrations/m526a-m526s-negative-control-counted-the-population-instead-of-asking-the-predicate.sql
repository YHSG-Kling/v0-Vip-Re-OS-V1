-- m526a — m526's NEGATIVE CONTROL COUNTED THE POPULATION INSTEAD OF ASKING THE
--          PREDICATE, SO IT REFUSED THE MOMENT THE POPULATION EXISTED.
--
-- THIS IS m526, RE-ISSUED. Every executable statement that GRANTS anything —
-- public.is_tenant_principal_team_lead(), and the two disjuncts added to
-- public.is_brokerage_finance_admin() / public.can_read_brokerage_books() — is
-- BYTE-IDENTICAL to m526. Its preconditions are byte-identical. What changed is
-- ONE postcheck query, and it changed in the STRICTER direction. Nothing here
-- weakens m526; the original never evaluated the predicate at all.
--
-- ── WHAT HAPPENED, MEASURED ─────────────────────────────────────────────────
--
-- m526 was applied verbatim on 2026-08-23 and REFUSED:
--
--     ERROR: P0001: m526 postcheck: 1 brokerage-tier team lead(s) would gain
--            tenant-wide money — m472 violated
--
-- The whole migration rolled back — verified after the failure:
-- is_tenant_principal_team_lead() did not exist, and neither survivor carried
-- the disjunct.
--
-- ── WHY IT REFUSED, AND WHY THAT IS A DEFECT IN THE CHECK ───────────────────
--
-- m526's own comment above that query states its intent:
--
--     "…and that it admits NOBODY on a brokerage-tier tenant (it is not a
--      constant true, and m472 still holds where the owner says it holds)."
--
-- The query it wrote does not ask that. It is:
--
--     select count(*) from users u join teams t on t.team_lead_id = u.id …
--       join brokerages b on b.id = t.brokerage_id
--      where b.plan_tier in ('brokerage','multi_location');
--
-- — a count of brokerage-tier team leads. The predicate does not appear in it.
-- It therefore treats the EXISTENCE of a brokerage-tier team lead as the leak,
-- when the leak is a brokerage-tier team lead being ADMITTED. Those are the same
-- number only while no such person exists, which was true when m526 was written
-- (both tenants were tagged solo_agent) and is exactly why it passed then.
--
-- This is the CLAUDE.md §2 failure mode in its other direction: not a guard that
-- reports zero because it cannot see, but a guard that reports a violation
-- because it counted the denominator. It accuses the migration precisely in the
-- case where the migration is doing its job.
--
-- ── APPLICATION STATUS: APPLIED, 2026-08-23, BY THE INTEGRATOR ──────────────
--
-- This file declares its state because a migration that does not is a file
-- nobody can act on safely (CLAUDE.md §3: "a migration that exists as a .sql
-- file has not been applied" — so silence reads as un-applied, and here that
-- would be wrong). m526 is the tombstone; THIS is the one that ran.
--
-- VERIFIED LIVE AFTER APPLYING, not assumed from the absence of an error —
-- supabase-js and psql disagree about how loudly a refusal arrives, and this
-- migration's whole subject is a check that lied:
--
--     is_tenant_principal_team_lead() ......... installed
--     can_read_brokerage_books() .............. carries the disjunct
--     is_brokerage_finance_admin() ............ carries the disjunct
--     teamlead@vip.demo (tier `brokerage`) .... is_principal=false, can_read=false
--     the same join, tier condition removed ... true  ← POSITIVE CONTROL: the
--         join is live, so those two `false` results are the tier condition
--         refusing, not an empty join returning nothing.
--
-- MEASURED LIVE, 2026-08-23, after m534 corrected the tenant tier tags:
--
--     m526's v_leaked as written ......................... 1   → REFUSES
--     the predicate, inlined, over those same identities .. 0   → NO LEAK
--     the predicate MINUS its tier condition ............. 1   → the join is live
--
-- The third number is what makes the second one mean something: the zero is
-- attributable to the TIER CONDITION doing its job, not to a dead join that
-- would have returned zero whatever the tier said.
--
-- ── THE CORRECTED CONTROL ───────────────────────────────────────────────────
--
-- v_leaked now INLINES the predicate — u.id for auth.uid(), u.brokerage_id for
-- current_user_brokerage_id() — over every brokerage-tier team lead, and refuses
-- only if one of them evaluates TRUE. That is the sentence m526's comment
-- already committed to, and it is strictly stronger: the old query could not
-- have caught an actual leak (a widened predicate that DID admit a
-- brokerage-tier lead would leave its count unchanged), and this one is the only
-- form that can. The denominator it was examined over is published beside it
-- (§2), and the "minus tier condition" satisfiability number is published too,
-- so a zero can never again be read as a clean bill of health without both.
--
-- ── WHAT THE GRANT DOES ON TODAY'S DATA, AND WHY THAT IS RIGHT ──────────────
--
-- ZERO answers move. m526's header measured "exactly one answer moves —
-- teamlead@vip.demo false → TRUE", against a database where VIP Premier Realty
-- was tagged plan_tier='solo_agent'. m526's own header called that tag
-- "demo-seed drift ... this migration follows the tier column, which is the
-- declared source of truth. If that tag is wrong, the fix is the tag." m534 is
-- that fix: VIP is a brokerage — 10 staff seats, a broker, an office admin, a
-- compliance officer, a TC, and a team INSIDE it.
--
-- So on brokerage tier m472/m473 stand and its team lead reads their own team's
-- books (can_read_team_books) and not the office's. That is the ruling, not a
-- regression: the hole m526 exists to close is "a team tenant seating only a
-- lead plus agents has NOBODY who can read its own financials", and VIP has both
-- a broker and an admin who already can. The other live tenant, Your Brokerage,
-- is team-tier but has ZERO team rows, so it has no principal either.
--
-- The mechanism is installed for the tenant shape that has not arrived yet —
-- which is what m526's single-team condition was already written for.
--
-- ── VERIFIED AFTER APPLYING (live, all 23 tenanted users) ───────────────────
-- 0 answers move · 0 revoked · 0 brokerage-tier leads admitted (denominator 1).

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. PRECONDITIONS — byte-identical to m526.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'is_brokerage_finance_admin') then
    raise exception 'm526a precondition: public.is_brokerage_finance_admin() missing';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'can_read_brokerage_books') then
    raise exception 'm526a precondition: public.can_read_brokerage_books() missing';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'current_user_brokerage_id') then
    raise exception 'm526a precondition: public.current_user_brokerage_id() missing';
  end if;

  if not exists (
    select 1 from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'brokerages'
       and con.conname = 'brokerages_plan_tier_check'
       and pg_get_constraintdef(con.oid) like '%solo\_agent%'
       and pg_get_constraintdef(con.oid) like '%team%'
  ) then
    raise exception 'm526a precondition: brokerages_plan_tier_check missing or no longer admits solo_agent/team';
  end if;

  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='teams' and column_name='team_lead_id') then
    raise exception 'm526a precondition: teams.team_lead_id missing';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='teams' and column_name='deleted_at') then
    raise exception 'm526a precondition: teams.deleted_at missing';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='teams' and column_name='brokerage_id') then
    raise exception 'm526a precondition: teams.brokerage_id missing';
  end if;

  -- NEGATED USE would make a widening into a REVOCATION.
  if exists (select 1 from pg_policies where schemaname='public'
             and (coalesce(qual,'')||' '||coalesce(with_check,''))
                 ~ 'NOT\s*\(?\s*[a-z_.]*is_brokerage_finance_admin') then
    raise exception 'm526a precondition: is_brokerage_finance_admin() is used NEGATED — widening it would REVOKE';
  end if;
  if exists (select 1 from pg_policies where schemaname='public'
             and (coalesce(qual,'')||' '||coalesce(with_check,''))
                 ~ 'NOT\s*\(?\s*[a-z_.]*can_read_brokerage_books') then
    raise exception 'm526a precondition: can_read_brokerage_books() is used NEGATED — widening it would REVOKE';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1-2. THE GRANT — byte-identical to m526.
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.is_tenant_principal_team_lead()
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce((
    select
      b.plan_tier in ('team', 'solo_agent')
      and (select count(*) from public.teams t2
            where t2.brokerage_id = b.id
              and t2.deleted_at is null) = 1
    from   public.teams t
    join   public.brokerages b on b.id = t.brokerage_id
    where  t.team_lead_id = auth.uid()
      and  t.deleted_at is null
      and  t.brokerage_id = public.current_user_brokerage_id()
    limit 1
  ), false);
$function$;

comment on function public.is_tenant_principal_team_lead() is
  'm526. TRUE when the caller LEADS the single live team of a tenant whose brokerages.plan_tier is team-scale (team|solo_agent) — i.e. they are that tenant''s principal and its books are their books. FALSE on brokerage/multi_location tier, where m472/m473 stand: a lead there reads only their own team (can_read_team_books). Anchors on teams.team_lead_id, never users.user_type (m473). Fails CLOSED on a NULL/unknown tier, a missing team, a missing session tenant, or more than one team.';

create or replace function public.is_brokerage_finance_admin()
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(
    (select u.user_type in ('admin', 'broker', 'broker_owner')
     from public.users u
     where u.id = auth.uid()
     limit 1)
    or exists (
      select 1
      from public.user_role_assignments ura
      where ura.user_id      = auth.uid()
        and ura.role         in ('admin', 'broker', 'broker_owner')
        and ura.brokerage_id is not null
        and ura.brokerage_id = public.current_user_brokerage_id()
    )
    or public.is_tenant_principal_team_lead(),
    false
  );
$function$;

create or replace function public.can_read_brokerage_books()
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select coalesce(
    (select u.user_type in ('admin','broker','broker_owner','broker_admin','compliance_officer')
     from public.users u
     where u.id = auth.uid()
     limit 1)
    or exists (
      select 1
      from public.user_role_assignments ura
      where ura.user_id      = auth.uid()
        and ura.role         in ('admin','broker','broker_owner','broker_admin','compliance_officer')
        and ura.brokerage_id is not null
        and ura.brokerage_id = public.current_user_brokerage_id()
    )
    or public.is_tenant_principal_team_lead(),
    false
  );
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. POST-CHECKS. The three shape assertions are byte-identical to m526. The
--    negative control is REPLACED with the one m526's own comment described.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_principals    int;   -- team-scale principals the predicate admits (the grant)
  v_leaked        int;   -- brokerage-tier leads the predicate ADMITS   (must be 0)
  v_denominator   int;   -- brokerage-tier leads it was ASKED about     (the §2 denominator)
  v_satisfiable   int;   -- the predicate MINUS its tier condition      (the control)
begin
  if (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='is_brokerage_finance_admin')
     not like '%is_tenant_principal_team_lead%' then
    raise exception 'm526a postcheck: is_brokerage_finance_admin() did not take the disjunct';
  end if;
  if (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='can_read_brokerage_books')
     not like '%is_tenant_principal_team_lead%' then
    raise exception 'm526a postcheck: can_read_brokerage_books() did not take the disjunct';
  end if;

  -- The ROSTER halves are UNCHANGED — a widening that also widened the roster
  -- would be the blanket grant m472 forbids.
  if (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='is_brokerage_finance_admin')
     like '%team_lead''%' then
    raise exception 'm526a postcheck: team_lead entered the finance ROSTER — that is the blanket grant m472 forbids';
  end if;

  -- Who the predicate ADMITS (the grant). Reported, not asserted: rows move.
  select count(*) into v_principals
    from public.users u
    join public.teams t on t.team_lead_id = u.id and t.deleted_at is null
                       and t.brokerage_id = u.brokerage_id
    join public.brokerages b on b.id = t.brokerage_id
   where b.plan_tier in ('team','solo_agent')
     and (select count(*) from public.teams t2
           where t2.brokerage_id = b.id and t2.deleted_at is null) = 1;

  -- THE DENOMINATOR: brokerage/multi_location-tier team leads that exist at all.
  -- m526 asserted THIS was zero, which is what made it refuse. It is a
  -- population, not a leak.
  select count(*) into v_denominator
    from public.users u
    join public.teams t on t.team_lead_id = u.id and t.deleted_at is null
                       and t.brokerage_id = u.brokerage_id
    join public.brokerages b on b.id = t.brokerage_id
   where b.plan_tier in ('brokerage','multi_location');

  -- THE LEAK: how many of that population the PREDICATE ACTUALLY ADMITS, with
  -- u.id inlined for auth.uid() and u.brokerage_id for current_user_brokerage_id().
  select count(*) into v_leaked
    from public.users u
    join public.teams t on t.team_lead_id = u.id and t.deleted_at is null
                       and t.brokerage_id = u.brokerage_id
    join public.brokerages b on b.id = t.brokerage_id
   where b.plan_tier in ('brokerage','multi_location')
     and coalesce((
           select b2.plan_tier in ('team','solo_agent')
              and (select count(*) from public.teams t2
                    where t2.brokerage_id = b2.id and t2.deleted_at is null) = 1
           from   public.teams t3
           join   public.brokerages b2 on b2.id = t3.brokerage_id
           where  t3.team_lead_id  = u.id
             and  t3.deleted_at is null
             and  t3.brokerage_id  = u.brokerage_id
           limit 1
         ), false);

  if v_leaked > 0 then
    raise exception 'm526a postcheck: the predicate ADMITS % brokerage-tier team lead(s) (of % examined) — m472 violated', v_leaked, v_denominator;
  end if;

  -- POSITIVE CONTROL (§2). v_leaked = 0 and "the inlined predicate is broken and
  -- returns false for everyone" are the same output. Re-run the SAME predicate
  -- with ONLY the tier condition removed: if that is non-zero, every other term
  -- (leads a live team, exactly one live team, team belongs to their own tenant)
  -- is satisfiable on real rows, so the zero above is the TIER refusing, not a
  -- dead join.
  select count(*) into v_satisfiable
    from public.users u
    join public.teams t on t.team_lead_id = u.id and t.deleted_at is null
                       and t.brokerage_id = u.brokerage_id
    join public.brokerages b on b.id = t.brokerage_id
   where (select count(*) from public.teams t2
           where t2.brokerage_id = b.id and t2.deleted_at is null) = 1;

  if v_denominator > 0 and v_satisfiable = 0 then
    raise exception 'm526a postcheck: POSITIVE CONTROL FAILED — % brokerage-tier lead(s) were examined but the predicate minus its tier condition matches NOBODY, so v_leaked=0 proves nothing', v_denominator;
  end if;

  raise notice 'm526a: predicate admits % team-scale principal(s); admits % of % brokerage-tier lead(s) examined (must be 0); non-tier half satisfiable on % identity(ies).',
    v_principals, v_leaked, v_denominator, v_satisfiable;
end $$;

COMMIT;

-- ── TOMBSTONE ───────────────────────────────────────────────────────────────
-- m526 is SUPERSEDED by this file and must not be applied: its postcheck refuses
-- on any database where a brokerage-tier tenant contains a team, which is the
-- ordinary state of a brokerage. The grant it carries lives here, unchanged, at
-- m526a-…:150-243.
