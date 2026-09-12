-- m432 — asserts m431.
--
-- Separate file because a `raise` rolls back its own transaction: asserting
-- inside m431 would undo the functions and the policy rewrites it was checking.
-- Same split as m393/m395/…/m420/m422/m424/m426/m428/m430.
--
-- Every claim pins a CONSTRUCT — a named helper whose whole purpose is to be the
-- single place a rule lives, a class of policy predicate, a role list. None pins
-- a select-list, a column order, or a list of table names, because guards that
-- pin spellings go red on strictly better code, which has happened four times in
-- this workstream.

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 1 — THE TEAM RULE EXISTS, IS ONE RULE, AND IS SHAPED LIKE A GATE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Three sub-claims, because "which team is this person on" has three failure
-- modes:
--
--   (a) no helper at all        → every call site invents its own answer, which
--                                 is the state m431 found: app/team/[slug] reads
--                                 agents.team_id, lib/finance/team-pl-writer
--                                 reads team_members, app/actions/financials.ts
--                                 reads users.team_id, and the live team is
--                                 anchored by a fourth column, teams.team_lead_id.
--   (b) the two entry points    → two copies of a four-source precedence is two
--       re-implement it            rules, and they will drift. current_user_team_id()
--                                 (the reader's side) and agent_team_id() (the
--                                 row's side) must both delegate to
--                                 resolve_team_id(), so the reader's team and the
--                                 row's team can never be decided differently.
--   (c) wrong volatility/       → a gate that is not SECURITY DEFINER cannot read
--       security                  users/agents/teams past their own RLS and will
--                                 recurse into the policy that calls it; one that
--                                 is not STABLE is re-evaluated per row; one with
--                                 an unpinned search_path can have public.users
--                                 shadowed out from under it.

do $$
declare
  r        record;
  missing  text[] := '{}';
  n        int;
begin
  for r in
    select unnest(array['resolve_team_id','current_user_team_id','agent_team_id']) as nm
  loop
    select count(*) into n
    from   pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where  ns.nspname = 'public' and p.proname = r.nm;
    if n = 0 then missing := missing || r.nm; end if;
  end loop;

  if array_length(missing, 1) is not null then
    raise exception
      'm432: the team rule is missing (%). Owner ruling: "teams should only see their own board." A team membership can be recorded in FOUR places on this schema — teams.team_lead_id, users.team_id, team_members and agents.team_id — and all four exist, so without ONE function holding the precedence each policy and each screen picks a different one. That is the same defect m423 answered for a person''s OFFICE with lib/kernel/resolve-user-office.ts.',
      array_to_string(missing, ', ');
  end if;

  for r in
    select p.proname, p.prosecdef, p.provolatile, p.proconfig, p.prosrc
    from   pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
    where  ns.nspname = 'public'
      and  p.proname in ('resolve_team_id','current_user_team_id','agent_team_id')
  loop
    if not r.prosecdef or r.provolatile <> 's' or r.proconfig is null
       or not exists (select 1 from unnest(r.proconfig) x where x like 'search_path=%') then
      raise exception
        'm432: public.%() is not SECURITY DEFINER + STABLE + pinned search_path. SECURITY DEFINER so it reads users/agents/teams/team_members without tripping their own RLS and without recursing into a policy that calls it; STABLE so the planner may cache it per statement instead of re-querying per row; a pinned search_path so a caller cannot shadow public.users. This is the shape current_user_agent_id() and can_read_tenant_financials() already have.',
        r.proname;
    end if;

    if r.proname in ('current_user_team_id','agent_team_id')
       and r.prosrc not like '%resolve_team_id%' then
      raise exception
        'm432: public.%() no longer delegates to resolve_team_id(). The reader''s team and the row''s team MUST be decided by the same precedence — a second copy of a four-source rule is a second rule, and the first time the two disagree a team lead either loses their own board or gains someone else''s.',
        r.proname;
    end if;
  end loop;

  raise notice 'm432 claim 1 OK: one team rule, two entry points, all three SECURITY DEFINER + STABLE + pinned.';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 2 — NO POLICY ANYWHERE IN public GRANTS ON A NEGATED ROLE PROBE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- THIS IS THE DEFECT CLASS, and it is the reason this file exists.
--
-- The clause was `(NOT is_agent_role()) AND has_brokerage_access(brokerage_id)`.
-- `is_agent_role()` is exactly `user_type = 'agent'`, so "not an agent" was TRUE
-- for a contact, a lender and a vendor — all eight of which carry a brokerage_id
-- on this database — and that one clause was how a client read their brokerage's
-- entire commission book. It was also TRUE for tc, compliance_officer, isa and
-- the system AI-ISA accounts, none of which the owner named.
--
-- The clause was CORRECT when 'agent' and 'broker' were the only two user types.
-- It widened silently every time a role was added, and nothing went red, because
-- a negative test grants to every role invented after it is written. That is the
-- whole defect: not a wrong role list, but a rule that has no role list at all.
--
-- Stated across ALL of public and not for these two tables, deliberately. A
-- two-name list cannot see the NEXT table to reach for the same shortcut, and
-- reaching for it is easy — "everyone except the agents" reads like a reasonable
-- sentence right up until someone adds a role. Measured before this was written:
-- `NOT is_*_role()` appeared in exactly two policies schema-wide, both of them
-- the ones m431 rewrites, so this claim starts clean and any future hit is new.

do $$
declare offenders text[];
begin
  select coalesce(array_agg(
           c.relname || '.' || p.polname || ' [' ||
           case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT'
                         when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end || ']'
           order by c.relname, p.polname), '{}')
  into   offenders
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public'
    and  ( coalesce(pg_get_expr(p.polqual, p.polrelid), '')      ~* 'not[[:space:]]*\(?[[:space:]]*(public\.)?is_[a-z_]*_role\(\)'
        or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~* 'not[[:space:]]*\(?[[:space:]]*(public\.)?is_[a-z_]*_role\(\)' );

  if array_length(offenders, 1) is not null then
    raise exception
      'm432: % polic(ies) grant rows on a NEGATED role probe: %. Never gate access on "NOT <some role>". A negative test admits every role invented after it is written, which is exactly how a contact, a lender and a vendor came to read their brokerage''s whole commission book through `(NOT is_agent_role()) AND has_brokerage_access(brokerage_id)`. Write the POSITIVE list of roles that should see the rows, and put it behind a named helper so the next table inherits the definition instead of copying it.',
      array_length(offenders, 1), array_to_string(offenders, ', ');
  end if;

  raise notice 'm432 claim 2 OK: no policy in public grants on a negated role probe.';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 3 — BOTH COMMISSION LEDGERS READ THROUGH THE SAME FOUR-TIER MODEL, AND
--           EVERY GATE IN THE EXPRESSION IS AN AUDITED ONE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The positive replacement for claim 2's negative. Two halves:
--
--   (a) Each of the four tiers the owner named is PRESENT, pinned by the name of
--       the helper that holds its roster — platform (can_read_tenant_financials),
--       brokerage (is_brokerage_admin), team (is_team_lead_role +
--       current_user_team_id), agent (is_agent_role + current_user_agent_id).
--       Names are pinned for the reason m420 pins has_brokerage_access and m428
--       pins can_read_tenant_financials: the POINT of a helper is that the rule
--       lives in one place, and a hand-inlined `user_type in (...)` would satisfy
--       any shape test and then silently fail to inherit a correction.
--
--   (b) NOTHING ELSE gates these two expressions. Every function called in either
--       SELECT must be one of the audited nine. This is the half that makes (a)
--       more than decoration: without it, a fifth disjunct naming some brand-new
--       `is_back_office_role()` would pass every claim above while re-opening the
--       ledger to an unaudited roster. It is a construct test, not a spelling
--       test — the expression may be rewritten, reordered or simplified freely,
--       as long as the things deciding access are things that have been looked at.
--
-- Both tables are asserted with the same list because the split ledger carries
-- agent_amount and brokerage_amount for the SAME commission (m419): it would be
-- incoherent for one to answer "may I see this agent's money" differently.

do $$
declare
  tbl        text;
  sel        text;
  required   text[] := array['can_read_tenant_financials','is_brokerage_admin',
                             'is_team_lead_role','current_user_team_id',
                             'is_agent_role','current_user_agent_id'];
  audited    text[] := array['can_read_tenant_financials','is_platform_admin',
                             'is_brokerage_admin','is_team_lead_role','is_agent_role',
                             'has_brokerage_access','current_user_agent_id',
                             'current_user_team_id','agent_team_id','resolve_team_id'];
  need       text;
  called     text[];
  stranger   text[];
begin
  foreach tbl in array array['agent_commissions','commission_splits'] loop
    select pg_get_expr(p.polqual, p.polrelid) into sel
    from   pg_policy p
    join   pg_class     c on c.oid = p.polrelid
    join   pg_namespace n on n.oid = c.relnamespace
    where  n.nspname = 'public' and c.relname = tbl and p.polcmd = 'r';

    if sel is null then
      raise exception 'm432: % has no SELECT policy at all.', tbl;
    end if;

    foreach need in array required loop
      if sel not like '%' || need || '%' then
        raise exception
          'm432: the % SELECT policy does not reference %(). The owner''s rulings define exactly four tiers of financial visibility — platform (can_read_tenant_financials), brokerage (is_brokerage_admin), TEAM (is_team_lead_role narrowed by current_user_team_id, which is ruling "teams should only see their own board"), and agent (is_agent_role narrowed by current_user_agent_id, which is ruling "agents should only see their own commission splits"). Each tier is pinned by the helper that holds its roster, so a later correction to that roster is inherited rather than copied. Current SELECT: %',
          tbl, need, sel;
      end if;
    end loop;

    select coalesce(array_agg(distinct m[1]), '{}') into called
    from   regexp_matches(sel, '([a-z_][a-z0-9_]*)[[:space:]]*\(', 'g') m;

    select coalesce(array_agg(x order by x), '{}') into stranger
    from   unnest(called) x where x <> all(audited);

    if array_length(stranger, 1) is not null then
      raise exception
        'm432: the % SELECT policy is gated by unaudited function(s): %. Every gate on a commission ledger must be one that has been read and reasoned about — the audited set is %. A new gate is not forbidden, but it must be added to this list deliberately, because the defect this file exists to prevent is precisely a clause that grants on a roster nobody looked at. Current SELECT: %',
        tbl, array_to_string(stranger, ', '), array_to_string(audited, ', '), sel;
    end if;
  end loop;

  raise notice 'm432 claim 3 OK: both ledgers carry all four tiers and are gated only by audited helpers.';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 4 — THE PORTAL ROLES ARE IN NONE OF THE ROSTERS THAT OPEN A LEDGER
-- ─────────────────────────────────────────────────────────────────────────────
--
--   "contacts, lenders and vendors do not see commission or any financials but
--    only their own."
--
-- Claim 3 fixed WHICH helpers decide. This one asserts what those helpers SAY,
-- because the ruling survives claim 3 perfectly well right up until someone adds
-- 'vendor' to is_brokerage_admin() to fix an unrelated vendor screen — and then
-- every vendor account reads the brokerage's payroll and no guard notices.
--
-- Asserted against the roster helpers rather than against a fixture, so it holds
-- for a tenant with no vendor accounts today. Asserted over the gates the
-- commission SELECTs actually use rather than a fixed pair of names, so a tier
-- swapped for a better helper is still checked.
--
-- is_agent_role() is checked too even though it is 'agent'-only: it is narrowed
-- by `agent_id = current_user_agent_id()` in both policies, but a portal role
-- inside it would still be a portal role holding an agent identity.

do $$
declare
  gate     text;
  src      text;
  portal   text;
  gates    text[] := array['can_read_tenant_financials','is_platform_admin',
                           'is_brokerage_admin','is_team_lead_role','is_agent_role'];
begin
  foreach gate in array gates loop
    select p.prosrc into src
    from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where  n.nspname = 'public' and p.proname = gate and p.pronargs = 0;

    if src is null then
      raise exception
        'm432: public.%() is missing — a tier gate the commission ledgers depend on has been dropped.', gate;
    end if;

    foreach portal in array array['contact','lender','vendor'] loop
      if src ~ ('''' || portal || '''') then
        raise exception
          'm432: public.%() admits the portal role %. Owner ruling: "contacts, lenders and vendors do not see commission or any financials but only their own." This helper gates a commission ledger read, so putting a portal role inside it hands every one of those accounts the brokerage''s payroll — which is exactly what `(NOT is_agent_role()) AND has_brokerage_access(brokerage_id)` did before m431. A portal account''s own records are reached through its own policies (contacts.contact_user_id, the vendor and lender surfaces), never through a tier gate.',
          gate, portal;
      end if;
    end loop;
  end loop;

  raise notice 'm432 claim 4 OK: contact, lender and vendor appear in none of the commission tier gates.';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 5 — READING A TEAM'S BOARD IS NOT WRITING IT, AND m419/m427'S WRITE
--           RULE SURVIVED
-- ─────────────────────────────────────────────────────────────────────────────
--
-- m431 added a READ tier. Postgres evaluates the SELECT policy to LOCATE rows
-- for an UPDATE or DELETE carrying a WHERE that reads the table's columns, so a
-- widened SELECT sits underneath every write on these tables — which makes "the
-- team lead got a pen too" a live risk rather than a theoretical one.
--
-- The write rule set by m419/m420 and re-applied by m427 is
-- `is_platform_admin() or (is_brokerage_admin() and has_brokerage_access(...))`.
-- Restated here as two properties rather than as an exact string, so the
-- expression may be improved:
--
--   · every write clause names is_brokerage_admin() — the roster that may move
--     commission money, and the same one app/actions/financials.ts:503
--     updateCommissionStatus already enforces in code;
--   · no write clause names current_user_team_id() or is_agent_role() — the two
--     tiers that got READ. An agent who can rewrite their own gross_commission,
--     or a team lead who can rewrite a member's, is the worst possible residue
--     of a read-side change.
--
-- can_read_tenant_financials() on a write clause is m428 claim 5's business and
-- is not re-checked here.

do $$
declare offenders text[];
begin
  select coalesce(array_agg(
           c.relname || '.' || p.polname || ' — ' || why order by c.relname, p.polname), '{}')
  into   offenders
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  cross  join lateral (
           select coalesce(pg_get_expr(p.polqual, p.polrelid), '')
               || ' ' || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as expr
         ) e
  cross  join lateral (
           select case
                    when e.expr not like '%is_brokerage_admin()%'
                      then 'does not name is_brokerage_admin()'
                    when e.expr like '%current_user_team_id()%'
                      then 'admits a TEAM LEAD to a write — the team ruling granted a board to READ, not a pen'
                    when e.expr like '%is_agent_role()%'
                      then 'admits an AGENT to a write — an agent who can rewrite their own gross_commission'
                  end as why
         ) w
  where  n.nspname = 'public'
    and  c.relname in ('agent_commissions','commission_splits')
    and  p.polcmd in ('a','w','d','*')
    and  w.why is not null;

  if array_length(offenders, 1) is not null then
    raise exception
      'm432: % commission write polic(ies) regressed: %. Writes on both ledgers stay is_platform_admin() OR (is_brokerage_admin() AND has_brokerage_access(brokerage_id)), set by m419/m420 and re-applied by m427. m431 added a READ tier for team leads and left every write clause untouched; this is what keeps that true.',
      array_length(offenders, 1), array_to_string(offenders, ', ');
  end if;

  raise notice 'm432 claim 5 OK: every commission write is still brokerage-admin only; neither new reader gained a pen.';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 6 — NEITHER LEDGER HAS A POLICY GRANTED TO PUBLIC
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Measured live before m431: all four `commission_splits` policies had
-- polroles = {0}, i.e. PUBLIC, while all four `agent_commissions` policies were
-- TO authenticated. Two ledgers holding the same numbers disagreed about who the
-- policy even applies to.
--
-- It was harmless at the time, and writing down WHY is the point, because
-- "harmless today" is what keeps this class alive: every helper in the
-- expression bottoms out in `select … from users where id = auth.uid()` wrapped
-- in COALESCE(…, FALSE), and auth.uid() is NULL for the anon role, so each
-- returned FALSE and anon matched no disjunct. The safety was a property of five
-- function bodies rather than of the grant. TO PUBLIC also means the policy is
-- evaluated for any role added to this database later.
--
-- Stated for both tables so they cannot drift apart again, and as "no policy",
-- not "these four", because the defect is a FIFTH policy added later — the same
-- reason m420 and m428 state their invariants that way.

do $$
declare offenders text[];
begin
  select coalesce(array_agg(
           c.relname || '.' || p.polname || ' [' ||
           case p.polcmd when 'r' then 'SELECT' when 'a' then 'INSERT'
                         when 'w' then 'UPDATE' when 'd' then 'DELETE' else 'ALL' end || ']'
           order by c.relname, p.polname), '{}')
  into   offenders
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public'
    and  c.relname in ('agent_commissions','commission_splits')
    and  (p.polroles = '{0}'::oid[] or 0 = any(p.polroles));

  if array_length(offenders, 1) is not null then
    raise exception
      'm432: % commission polic(ies) are granted TO PUBLIC: %. Commission is tenant-only and every reader of it is a signed-in person. TO PUBLIC makes the policy apply to anon as well, which leaves the table safe only for as long as every helper in the expression keeps returning FALSE for a NULL auth.uid() — a property of five function bodies rather than of the grant. Grant TO authenticated so the anon role never reaches the expression at all.',
      array_length(offenders, 1), array_to_string(offenders, ', ');
  end if;

  raise notice 'm432 claim 6 OK: every policy on both commission ledgers is granted to a named role, not PUBLIC.';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 7 — m420 AND m428'S TENANT/PERSON ANCHORS SURVIVED m431
-- ─────────────────────────────────────────────────────────────────────────────
--
-- m431 rewrote the SELECT policy on both tables, which makes it exactly the file
-- most likely to have broken the invariants those two migrations assert. They
-- are re-made here rather than assumed:
--
--   commission_splits (m420, re-made by m428 claim 3) — EVERY non-empty USING and
--     WITH CHECK expression names `has_brokerage_access(brokerage_id)`
--     specifically. Commission is TENANT ONLY, and that helper is the single
--     place a multi-location relationship would ever be taught, so an inlined
--     equality would not inherit it.
--
--   agent_commissions (m428 claim 6) — every clause carries a durable anchor:
--     `has_brokerage_access(brokerage_id)` (the tenant) or
--     `current_user_agent_id()` (the person). A clause naming neither grants
--     commission rows on some basis other than who you are or where you work.
--
-- The team disjunct m431 adds satisfies both: it names has_brokerage_access
-- (which is why the tenant anchor is written there explicitly rather than being
-- left implicit in the team equality), and it lives inside the same expression.

do $$
declare offenders text[];
begin
  select coalesce(array_agg(
           c.relname || '.' || p.polname ||
           case when coalesce(pg_get_expr(p.polqual, p.polrelid), '') <> ''
                     and pg_get_expr(p.polqual, p.polrelid) not like '%has_brokerage_access(brokerage_id)%'
                     and not (c.relname = 'agent_commissions'
                              and pg_get_expr(p.polqual, p.polrelid) like '%current_user_agent_id()%')
                then ' USING' else '' end ||
           case when coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') <> ''
                     and pg_get_expr(p.polwithcheck, p.polrelid) not like '%has_brokerage_access(brokerage_id)%'
                     and not (c.relname = 'agent_commissions'
                              and pg_get_expr(p.polwithcheck, p.polrelid) like '%current_user_agent_id()%')
                then ' WITH-CHECK' else '' end
           order by c.relname, p.polname), '{}')
  into   offenders
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public'
    and  c.relname in ('agent_commissions','commission_splits')
    and  ( (coalesce(pg_get_expr(p.polqual, p.polrelid), '') <> ''
            and pg_get_expr(p.polqual, p.polrelid) not like '%has_brokerage_access(brokerage_id)%'
            and not (c.relname = 'agent_commissions'
                     and pg_get_expr(p.polqual, p.polrelid) like '%current_user_agent_id()%'))
        or (coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') <> ''
            and pg_get_expr(p.polwithcheck, p.polrelid) not like '%has_brokerage_access(brokerage_id)%'
            and not (c.relname = 'agent_commissions'
                     and pg_get_expr(p.polwithcheck, p.polrelid) like '%current_user_agent_id()%')) );

  if array_length(offenders, 1) is not null then
    raise exception
      'm432: m420/m428''s anchor invariant is broken — % clause(s) name neither the tenant nor the person: %. Commission is TENANT ONLY. Use has_brokerage_access(brokerage_id) specifically (not an inlined equality — it is the one place a multi-location relationship gets taught) or, on agent_commissions, current_user_agent_id().',
      array_length(offenders, 1), array_to_string(offenders, ', ');
  end if;

  raise notice 'm432 claim 7 OK: m420 and m428''s anchors survived the m431 rewrite.';
end $$;

do $$
begin
  raise notice 'm432: all seven claims hold — the team tier is real and is ONE rule, the "not an agent" branch cannot come back anywhere in public, the portal roles are in no tier gate, the writes did not move, and neither ledger answers to PUBLIC.';
end $$;
