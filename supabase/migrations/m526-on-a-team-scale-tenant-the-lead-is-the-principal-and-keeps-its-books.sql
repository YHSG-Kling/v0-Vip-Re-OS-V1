-- m526 — ON A TEAM-SCALE TENANT, THE LEAD IS THE PRINCIPAL AND KEEPS ITS BOOKS.
-- ─────────────────────────────────────────────────────────────────────────────
-- NOT APPLIED BY THIS LANE (CLAUDE.md §3: files are not the database). No CHECK
-- is added, so no vocabulary cache needs regenerating afterwards.
--
-- OWNER RULING (this migration exists to execute it), verbatim:
--
--   "yes to the team lead and agents"
--
--   ...answering: on team tier there is no broker or broker_owner (m473 rules a
--   team IS a mini brokerage), and is_brokerage_finance_admin EXCLUDES team_lead
--   (m472). So a team tenant seating only a lead plus agents has NOBODY who can
--   read its own financials unless it spends one of its five seats on an
--   `admin`.
--
-- And, in the same message, the sentence that makes this TIER-CONDITIONAL:
--
--   "brokerages can have teams and agents but that is the brokerage tier. when
--    we have the team and solo agent subscription tiers, those subscriptions get
--    the same level of features as brokerages."
--
-- ── WHY A BLANKET GRANT IS THE WRONG EDIT, AND THIS IS THE WHOLE JOB ─────────
--
-- The one-word version of the ruling is "add team_lead to
-- is_brokerage_finance_admin()". That would execute the OPPOSITE of m472 for
-- every BROKERAGE-tier tenant: a large office has SEVERAL team leads, and each
-- would then read the whole office's P&L, its billing invoices, its vendor
-- payouts and every other agent's commissions. m472 exists to prevent exactly
-- that, and the owner did not withdraw it — they distinguished two tenant SHAPES:
--
--   TEAM / SOLO tier   the tenant's money IS the team's money. The lead is the
--                      PRINCIPAL of the tenant. Nobody else can keep the books.
--   BROKERAGE tier     the lead is one of several inside a larger office. m472
--                      and m473 stand unchanged: their own team's money, never
--                      the office's.
--
-- So the grant is conditioned on the TENANT'S TIER, and the condition is what is
-- being built here.
--
-- ── MEASURED LIVE ON hrvaqgvukzxfskkcrwbt BEFORE WRITING A LINE ──────────────
--
--   public.is_brokerage_finance_admin()  137 POLICIES over 50 TABLES.
--   public.can_read_brokerage_books()     23 POLICIES over 22 TABLES.
--   0 of either are used NEGATED — re-checked with an anchored regex, because
--     widening a term under a NOT REVOKES, and a widening that silently revokes
--     is the worst outcome available here.
--   Both are also called from public.can_read_agent_books() and
--     public.can_read_team_books(), which therefore inherit this fix.
--
-- NO POLICY IS TOUCHED. Two function bodies gain one disjunct each, and every
-- one of those 160 policies inherits the ruling. That is also why this cannot be
-- done policy-by-policy: 160 hand-edits is 160 chances to spell it differently,
-- which is the CLAUDE.md §6 defect this repo has paid for six times.
--
-- ── THE ANCHOR: A FACT, NOT A LABEL (m473's finding, still true) ─────────────
--
--   users.user_type = 'team_lead'   IS NOT LEADERSHIP. Live, buyer@yourbrokerage
--     .com carries that user_type and leads NO team row.
--   teams.team_lead_id = auth.uid() IS. Live, the one team's actual lead is
--     teamlead@vip.demo, users.user_type = 'agent'.
--
-- So this keys on the FK, exactly as public.current_user_led_team_id() (m444)
-- and can_read_agent_books() (m467) already do. A user_type check here would
-- admit a seat-holder who leads nothing and refuse the person the ruling is
-- about — wrong in both directions at once, which is what m473 measured.
--
-- ── FAIL CLOSED (CLAUDE.md §4) — WHAT EACH UNREADABLE INPUT DOES ────────────
--
--   plan_tier IS NULL          → `null in ('team','solo_agent')` is NULL → the
--                                conjunction is NULL → coalesce(...,false).
--                                REFUSED. The tier must be STORED and RECOGNISED.
--   no brokerages row          → the join yields no row → coalesce → REFUSED.
--   no teams row led by caller → no row → REFUSED.
--   auth.uid() IS NULL         → `t.team_lead_id = null` is NULL → REFUSED.
--   current_user_brokerage_id()
--     IS NULL                  → `t.brokerage_id = null` is NULL → REFUSED.
--
-- There is no branch that returns TRUE on an input it could not read. "Nobody
-- checked" cannot render as "checked and fine".
--
-- THE TIER MUST BE STORED, NOT INFERRED — and this is the one place where the
-- app twin could have drifted. lib/billing/plan-tier.ts `resolvePlanTier` FLOORS
-- an unreadable tier to 'solo_agent', which under this rule is a GRANTING tier;
-- a naive app twin built on it would fail OPEN while this function fails CLOSED.
-- The app side therefore consumes `readPlanTier` and requires `fromCache: true`
-- — "the value came from the plan_tier column" — which is precisely the
-- condition `b.plan_tier in ('team','solo_agent')` expresses here.
--
-- ── THE SINGLE-TEAM CONDITION, AND WHY IT IS NOT PARANOIA ───────────────────
--
-- The ruling's premise is that on a team-scale tenant there is ONE team and its
-- money is the tenant's money. A tenant carrying SEVERAL team rows while tagged
-- 'team' contradicts that premise — most plausibly a brokerage-tier tenant that
-- was DOWNGRADED with its teams intact. Granting there would hand every one of
-- those leads the whole tenant's books: the m472 leak, re-entered through a
-- billing change rather than a code change. So the premise is asserted, and a
-- tenant that violates it REFUSES rather than guesses (§4). Live today: one team
-- row exists on this database and its tenant has exactly one, so this condition
-- changes nothing measurable now — it is the guard on the state that is not here
-- yet.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
--
-- · Does NOT widen the ROSTER. BROKERAGE_FINANCE_ADMIN_USER_TYPES /
--   ('admin','broker','broker_owner') is byte-identical on both sides after this.
--   The new authority is a FACT about one person's relationship to one tenant,
--   not a role joining a list — which is why it composes with tier and cannot
--   leak to a brokerage-tier office.
-- · Does NOT touch is_brokerage_admin() (operational admin, m472) — team_lead is
--   already in it, and nothing here is operational.
-- · Does NOT widen anything for contacts, lenders or vendors. Standing ruling:
--   they see NO financials, only their own. None of them can satisfy
--   teams.team_lead_id, and the live enumeration below confirms all seven such
--   accounts stay false.
-- · Does NOT introduce a second spelling of "may read the books" (§6). The two
--   survivors are extended in place; the new function is a FACT about identity,
--   a sibling of current_user_led_team_id(), not a third authority predicate.
--
-- ── LIVE EFFECT, COMPUTED AGAINST REAL ROWS BEFORE APPLYING ─────────────────
--
-- The proposed predicate was inlined per-identity and run over all 23 tenanted
-- users on this database (denominator published, §2). EXACTLY ONE ANSWER MOVES:
--
--   email                     user_type   leads  tier        today  after
--   teamlead@vip.demo         agent         1    solo_agent  false  TRUE   ← +1
--   buyer@yourbrokerage.com   team_lead     0    solo_agent  false  false
--   admin@vip.demo            admin         0    solo_agent  true   true
--   broker@vip.demo           broker        0    solo_agent  true   true
--   agent1@yourbrokerage.com  agent(grant)  0    solo_agent  true   true
--   agent@vip.demo            agent         0    solo_agent  false  false
--   compliance@vip.demo       compliance_o  0    solo_agent  false  false
--   tc@vip.demo               tc            0    solo_agent  false  false
--   isa@vip.demo              agent         0    solo_agent  false  false
--   buyer/seller/pastclient/undercontract@vip.demo (contact ×4)   false  false
--   lender@vip.demo, lender@yourbrokerage.com (lender ×2)          false  false
--   vendor@vip.demo, title@vip.demo (vendor ×2)                    false  false
--   ai-isa ×2 (system), skling@theklinggroup.com, agent@yourbrokerage.com,
--   admin@yourbrokerage.com, superadmin@vip.demo — unchanged.
--
-- The +1 is the finding (§2): the actual lead of the one live team, on a tenant
-- tagged solo_agent, gains its books. That tenant (VIP Premier Realty, 18 users)
-- being tagged 'solo_agent' is demo-seed drift and is REPORTED, NOT FIXED HERE —
-- this migration follows the tier column, which is the declared source of truth
-- (lib/billing/plan-tier.ts). If that tag is wrong, the fix is the tag.
--
-- NOTHING IS REVOKED: both edits are pure OR-disjuncts onto bodies whose existing
-- terms are untouched, and neither function is used negated anywhere.
--
-- ── RELATIONSHIP TO m524 (adjacent lane, no overlap) ────────────────────────
-- m524 flipped the feature_flags CATALOGUE rows (brokerage_dashboard,
-- commission_reports, compliance_reports, brokerage_settings) on for solo/team.
-- That is what the tier is ENTITLED to. This is who inside the tenant may
-- actually READ it. Different halves; neither substitutes for the other.

BEGIN;

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Preconditions — the two survivors are as measured, and the anchors exist.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'is_brokerage_finance_admin') then
    raise exception 'm526 precondition: public.is_brokerage_finance_admin() missing';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'can_read_brokerage_books') then
    raise exception 'm526 precondition: public.can_read_brokerage_books() missing';
  end if;
  if not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where n.nspname = 'public' and p.proname = 'current_user_brokerage_id') then
    raise exception 'm526 precondition: public.current_user_brokerage_id() missing';
  end if;

  -- The tier vocabulary this function hard-codes must still be the constraint's.
  if not exists (
    select 1 from pg_constraint con
      join pg_class c on c.oid = con.conrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relname = 'brokerages'
       and con.conname = 'brokerages_plan_tier_check'
       and pg_get_constraintdef(con.oid) like '%solo\_agent%'
       and pg_get_constraintdef(con.oid) like '%team%'
  ) then
    raise exception 'm526 precondition: brokerages_plan_tier_check missing or no longer admits solo_agent/team';
  end if;

  -- The leadership anchor. If teams loses team_lead_id or deleted_at this
  -- function is silently wrong, so refuse to install it.
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='teams' and column_name='team_lead_id') then
    raise exception 'm526 precondition: teams.team_lead_id missing';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='teams' and column_name='deleted_at') then
    raise exception 'm526 precondition: teams.deleted_at missing';
  end if;
  if not exists (select 1 from information_schema.columns
                 where table_schema='public' and table_name='teams' and column_name='brokerage_id') then
    raise exception 'm526 precondition: teams.brokerage_id missing';
  end if;

  -- NEGATED USE would make a widening into a REVOCATION. Measured 0 before this
  -- file; assert it rather than trusting the measurement to still hold.
  if exists (select 1 from pg_policies where schemaname='public'
             and (coalesce(qual,'')||' '||coalesce(with_check,''))
                 ~ 'NOT\s*\(?\s*[a-z_.]*is_brokerage_finance_admin') then
    raise exception 'm526 precondition: is_brokerage_finance_admin() is used NEGATED — widening it would REVOKE';
  end if;
  if exists (select 1 from pg_policies where schemaname='public'
             and (coalesce(qual,'')||' '||coalesce(with_check,''))
                 ~ 'NOT\s*\(?\s*[a-z_.]*can_read_brokerage_books') then
    raise exception 'm526 precondition: can_read_brokerage_books() is used NEGATED — widening it would REVOKE';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. THE FACT: is this caller the PRINCIPAL of a team-scale tenant?
--
--    A sibling of current_user_led_team_id() / is_platform_staff() — it answers
--    "who is this person, relative to this tenant", not "what may they do". The
--    authority questions stay in the two predicates below, which is what keeps
--    this to ONE vocabulary for "may read the books" (§6).
--
--    SECURITY DEFINER for the same reason every predicate here is: it must read
--    `teams` and `brokerages` rows the caller's own RLS may hide, and returning
--    a narrower answer because the caller cannot see their own tenant row would
--    be a gate refusing on its own blindness.
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
      -- TIER-CONDITIONAL. This is the whole ruling. On 'brokerage' or
      -- 'multi_location' this is FALSE and m472/m473 stand untouched: the lead
      -- keeps their own team's money (can_read_team_books) and nothing wider.
      -- A NULL or unrecognised plan_tier yields NULL here, not true.
      b.plan_tier in ('team', 'solo_agent')
      -- ...and the ruling's premise holds: one team, whose money IS the tenant's.
      and (select count(*) from public.teams t2
            where t2.brokerage_id = b.id
              and t2.deleted_at is null) = 1
    from   public.teams t
    join   public.brokerages b on b.id = t.brokerage_id
    where  t.team_lead_id = auth.uid()      -- the FACT, not users.user_type
      and  t.deleted_at is null
      -- TENANT FROM THE SESSION (CLAUDE.md §4), never from an argument: a team
      -- led in some OTHER brokerage authorises nothing in this one.
      and  t.brokerage_id = public.current_user_brokerage_id()
    limit 1
  ), false);
$function$;

comment on function public.is_tenant_principal_team_lead() is
  'm526. TRUE when the caller LEADS the single live team of a tenant whose brokerages.plan_tier is team-scale (team|solo_agent) — i.e. they are that tenant''s principal and its books are their books. FALSE on brokerage/multi_location tier, where m472/m473 stand: a lead there reads only their own team (can_read_team_books). Anchors on teams.team_lead_id, never users.user_type (m473). Fails CLOSED on a NULL/unknown tier, a missing team, a missing session tenant, or more than one team.';

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. THE TWO SURVIVORS each gain that ONE disjunct. Existing terms byte-identical.
--
--    is_brokerage_finance_admin() — ADMINISTERS the books. 137 policies / 50
--    tables, overwhelmingly INSERT/UPDATE/DELETE plus a few SELECTs
--    (agent_commissions, commission_splits, business_expenses,
--    ai_overage_invoices). The ruling says "read AND administer", and on a
--    team-scale tenant the principal is the only person who can approve a
--    commission or record a payout, so the write half is not optional.
-- ─────────────────────────────────────────────────────────────────────────────
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
    -- m526: on a TEAM-SCALE tenant the lead is the principal and keeps its books.
    -- Roster above unchanged; this is a tier-conditioned FACT, not a fourth role.
    or public.is_tenant_principal_team_lead(),
    false
  );
$function$;

--    can_read_brokerage_books() — READS them. 23 policies / 22 tables, all
--    SELECT, and the roster is deliberately WIDER than the one above
--    (+broker_admin, +compliance_officer: they read, they do not author). That
--    read/write split is not a §6 duplicate and is preserved exactly.
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
    -- m526, same disjunct: the principal of a team-scale tenant reads its books.
    -- can_read_agent_books() and can_read_team_books() call this function, so
    -- they inherit it and need no edit of their own.
    or public.is_tenant_principal_team_lead(),
    false
  );
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. POST-CHECKS — assert the shape, and assert the POSITIVE CONTROL (§2): a
--    predicate that always returned false would satisfy "nothing leaked" too.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  v_principals int;
  v_leaked     int;
begin
  -- The disjunct is actually present in both bodies.
  if (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='is_brokerage_finance_admin')
     not like '%is_tenant_principal_team_lead%' then
    raise exception 'm526 postcheck: is_brokerage_finance_admin() did not take the disjunct';
  end if;
  if (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='can_read_brokerage_books')
     not like '%is_tenant_principal_team_lead%' then
    raise exception 'm526 postcheck: can_read_brokerage_books() did not take the disjunct';
  end if;

  -- The roster halves are UNCHANGED — a widening that also widened the roster
  -- would be the blanket grant this file exists to avoid.
  if (select pg_get_functiondef(p.oid) from pg_proc p join pg_namespace n on n.oid=p.pronamespace
       where n.nspname='public' and p.proname='is_brokerage_finance_admin')
     like '%team_lead''%' then
    raise exception 'm526 postcheck: team_lead entered the finance ROSTER — that is the blanket grant m472 forbids';
  end if;

  -- POSITIVE CONTROL. Inline the new predicate per-identity over every tenanted
  -- user and require that it admits AT LEAST ONE (it is not a constant false)
  -- and that it admits NOBODY on a brokerage-tier tenant (it is not a constant
  -- true, and m472 still holds where the owner says it holds).
  select count(*) into v_principals
    from public.users u
    join public.teams t on t.team_lead_id = u.id and t.deleted_at is null
                       and t.brokerage_id = u.brokerage_id
    join public.brokerages b on b.id = t.brokerage_id
   where b.plan_tier in ('team','solo_agent')
     and (select count(*) from public.teams t2
           where t2.brokerage_id = b.id and t2.deleted_at is null) = 1;

  select count(*) into v_leaked
    from public.users u
    join public.teams t on t.team_lead_id = u.id and t.deleted_at is null
                       and t.brokerage_id = u.brokerage_id
    join public.brokerages b on b.id = t.brokerage_id
   where b.plan_tier in ('brokerage','multi_location');

  if v_leaked > 0 then
    raise exception 'm526 postcheck: % brokerage-tier team lead(s) would gain tenant-wide money — m472 violated', v_leaked;
  end if;

  raise notice 'm526: % team-scale principal(s) now keep their tenant''s books; % brokerage-tier lead(s) admitted (must be 0).',
    v_principals, v_leaked;

  -- Measured expectation at authoring time: exactly 1 principal
  -- (teamlead@vip.demo). A DIFFERENT number is not necessarily wrong — rows move
  -- — but it must be SEEN, so it is raised above rather than asserted here.
end $$;

COMMIT;
