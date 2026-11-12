-- m439 — asserts m438.
--
-- Separate file because a `raise` rolls back its own transaction: asserting
-- inside m438 would undo the drops and the merged policies it is checking. Same
-- split as m393/m395/…/m428/m430/m432/m434/m436.
--
-- ── THE CONSTRUCT ────────────────────────────────────────────────────────────
--
-- No permissive policy on a table that carries a SETTLED MONEY AMOUNT may grant
-- through a disjunct that tests only WHO THE CALLER IS, with nothing tying the
-- row to them. "I am a broker" is not an authorisation on a table with one row
-- per brokerage; it is a grant over every brokerage on the platform.
--
-- This is the exact complement of the hole m434 claim 3 leaves open, and that is
-- why the class survived the money sweep. Claim 3 only looks at policies that
-- MENTION a tenant (`current_user_brokerage_id|has_brokerage_access|
-- user_brokerage_ids`) and asks whether they also name a role. A predicate that
-- mentions no tenant AT ALL never enters its candidate set — it is filtered out
-- one line before the test. m433 rewrote closing_disclosure_agreement's tier
-- policy correctly, m434 passed, and four `FOR ALL` policies beside it went on
-- OR-ing the whole platform's settlement records into view.
--
-- ── WHY THIS IS NOT A REGEX OVER POLICY TEXT ─────────────────────────────────
--
-- A flat `pred ~ user_type AND pred !~ brokerage_id` test gets this wrong in
-- both directions, and both errors matter:
--
--   FALSE POSITIVE. transactions.agent_read_own_transactions is
--     user_type = 'agent' AND agent_id = (select id from agents where user_id = auth.uid())
--   — a user_type test AND a row tie. Correct code. A flat regex reds it.
--
--   FALSE NEGATIVE (the one that hid this defect). agent_crud_own_cda was
--     agent_id = current_user_agent_id() OR user_type = ANY('{compliance_officer,broker,admin}')
--   — it MENTIONS agent_id, so any acquittal that keys on "does the text contain
--   a row column" lets the second disjunct through, and the second disjunct is
--   the whole platform.
--
-- The difference is structural: AND-composition narrows, OR-composition widens.
-- So the check below splits each predicate into its TOP-LEVEL DISJUNCTS —
-- parenthesis-depth aware, descending only through OR, never into AND — and
-- tests each disjunct on its own. A disjunct that names a role and ties the row
-- to nothing is a grant over every tenant, whatever it sits next to.
--
-- ── SCOPE, STATED PLAINLY ────────────────────────────────────────────────────
--
-- Measured before writing this: across the whole `public` schema, the money
-- family below, EIGHT policies were offenders — the five on
-- closing_disclosure_agreement, two on commission_structures, one on
-- vendor_transactions. m438 drops all eight, so claim 1 asserts ZERO and the
-- class is genuinely closed for money tables. Nothing is scoped out of claim 1.
--
-- TWO THINGS ARE LEFT OUT, and neither should be read as covered:
--
--   1. vendor_subscriptions carried the same shape ("Brokerages can view their
--      subscriptions", "Admins can manage all subscriptions") and m438 drops
--      both — but the table has NO money column at all (its only numeric column
--      is credits_used_this_period, a credit counter), so it is not in the money
--      family and claim 1 would not catch the shape coming back there.
--   2. The money family is a COLUMN-NAME family, inherited from m434 claim 3 and
--      widened by exactly six settled-amount names it did not carry
--      (amount, base_amount, commission_amount, fee_amount, payout_amount,
--      calculated_amount, amount_due, amount_paid). A money table whose amount
--      column is spelled some other way is not discovered. Deliberately still
--      NOT rates or percentages: a commission_rate on a live offer is a term of
--      a deal an ordinary agent works from all day, not the brokerage's book.

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 1 — NO MONEY POLICY GRANTS ON A TENANT-FREE ROLE TEST
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  r         record;
  q         text[];
  e         text;
  c         text;
  parts     text[];
  i         int;
  d         int;
  last      int;
  enclosing boolean;
  bad       boolean;
  n         int  := 0;
  offenders text := '';
begin
  for r in
    -- the columns alias is `co`, not `c`: `c` is the character variable this
    -- block scans predicates with, and plpgsql resolves identifiers in a query
    -- against its own variables first.
    with money as (
      select distinct co.table_name
      from   information_schema.columns co
      join   pg_class     pc on pc.relname = co.table_name
      join   pg_namespace pn on pn.oid = pc.relnamespace and pn.nspname = 'public'
      where  co.table_schema = 'public'
        and  pc.relkind = 'r'
        and  co.data_type in ('numeric', 'double precision', 'real', 'integer', 'bigint', 'money')
        and  co.column_name in (
               -- m434 claim 3's family, verbatim …
               'gross_commission', 'agent_commission', 'brokerage_commission',
               'net_to_agent', 'net_to_brokerage', 'agent_net', 'brokerage_net',
               'team_net', 'total_fees', 'cap_amount', 'cap_paid_to_date',
               'agent_splits_paid', 'gross_commission_income', 'net_profit',
               'total_income', 'total_expenses', 'agent_amount', 'brokerage_amount',
               'gross_amount', 'net_amount', 'platform_fee', 'amount_cents',
               'gross_total', 'net_total', 'agent_payout', 'gci_gross',
               'brokerage_gross', 'commission_cents', 'lifetime_brokerage_net',
               'brokerage_net_from_agent', 'gross_commission_generated',
               'income_goal', 'default_budget', 'total_amount',
               -- … widened by the settled amounts it did not name. Without
               -- these, commission_structures.base_amount and
               -- vendor_transactions.amount are invisible to this guard, and
               -- three of the eight offenders sat on exactly those two tables.
               'amount', 'base_amount', 'commission_amount', 'fee_amount',
               'payout_amount', 'calculated_amount', 'amount_due', 'amount_paid'
             )
    )
    select p.tablename,
           p.policyname,
           p.cmd,
           coalesce(p.qual, '') || ' OR ' || coalesce(p.with_check, '') as pred
    from   pg_policies p
    where  p.schemaname = 'public'
      and  p.permissive = 'PERMISSIVE'
      and  'service_role' <> all (p.roles)          -- service_role is not a tenant
      and  p.tablename in (select table_name from money)
      and  (coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')) ~* '(user_type|current_user_type)'
    order by p.tablename, p.policyname
  loop
    -- Worklist of expressions still to be split. USING and WITH CHECK are joined
    -- by ' OR ' on purpose: either one alone is a grant, so each is tested.
    q := array[r.pred];
    bad := false;

    while coalesce(array_length(q, 1), 0) > 0 loop
      e := btrim(q[1]);
      q := q[2:];

      -- strip a fully-enclosing paren pair, repeatedly: pg_get_expr wraps the
      -- whole predicate, so the top-level OR sits at depth 1 until this runs.
      loop
        exit when length(e) < 2 or left(e, 1) <> '(';
        d := 0; enclosing := true;
        for i in 1 .. length(e) loop
          c := substr(e, i, 1);
          if c = '(' then d := d + 1; elsif c = ')' then d := d - 1; end if;
          if d = 0 and i < length(e) then enclosing := false; exit; end if;
        end loop;
        exit when not enclosing;
        e := btrim(substr(e, 2, length(e) - 2));
      end loop;

      -- split on ' OR ' at paren-depth 0 only. An OR nested inside an AND stays
      -- inside its conjunct, where the AND's row tie still governs it.
      parts := '{}'; d := 0; last := 1; i := 1;
      while i <= length(e) loop
        c := substr(e, i, 1);
        if c = '(' then d := d + 1;
        elsif c = ')' then d := d - 1;
        elsif d = 0 and upper(substr(e, i, 4)) = ' OR ' then
          parts := parts || substr(e, last, i - last);
          i := i + 3; last := i + 1;
        end if;
        i := i + 1;
      end loop;

      if coalesce(array_length(parts, 1), 0) > 0 then
        q := q || (parts || substr(e, last));
      elsif btrim(e) <> '' then
        -- An atomic disjunct. It is an offender if it decides on WHO the caller
        -- is and ties the row to NOTHING — no tenant, no ownership, no
        -- membership. Any of those acquits, because any of them makes the grant
        -- about this row rather than about every row.
        -- the concatenation MUST stay parenthesised: `!~*` binds tighter than
        -- `||`, so without the parens this reads (e !~* 'first-chunk') || rest,
        -- which is a text value where a boolean belongs.
        if e ~* '(user_type|current_user_type)'
           and e !~* ('(brokerage_id|has_brokerage_access|user_brokerage_ids|current_user_brokerage_id'
                   || '|agent_id|current_user_agent_id|team_id|vendor_id'
                   || '|vendor_has_transaction_access|is_current_user_vendor'
                   || '|user_id|owner_id|created_by)')
        then
          bad := true;
        end if;
      end if;
    end loop;

    if bad then
      n := n + 1;
      offenders := offenders || format('  %s  [%s %s]', r.tablename, r.cmd, r.policyname) || chr(10);
    end if;
  end loop;

  if n > 0 then
    raise exception
      'm439: % policy/policies on money tables grant through a disjunct that tests only user_type, with nothing tying the row to the caller. Permissive policies OR together, so one of these cancels every tenant-scoped policy sitting beside it — a broker at brokerage B reads, rewrites and DELETEs brokerage A''s settlement records, and the tier predicate m433 applied to the same table subtracts nothing. A role test says WHO may act; it never says WHICH ROWS. Pair it with has_brokerage_access(brokerage_id), or with the row''s own owner.%',
      n, chr(10) || offenders;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 2 — THE MERGE LANDED, AND THE TABLE IS PER-COMMAND
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Claim 1 passes just as happily if someone deletes the compliance policies
-- outright — the capability would be gone and the construct still clean. m416
-- learned this the hard way: assert that the REWRITE landed, not only that the
-- old spelling left. The compliance officer approving, sending back, overriding
-- and closing a CDA is the owner's process step; it must survive the fix.
--
-- The FOR ALL check is the m437 lesson made local: on a FOR ALL policy USING
-- alone governs DELETE, so a read-shaped predicate on this table is a licence to
-- delete a settlement record. Per-command policies cannot make that mistake.
do $$
declare
  ins_chk text;
  upd_qual text;
  upd_chk  text;
  n_all    int;
begin
  select pg_get_expr(p.polwithcheck, p.polrelid) into ins_chk
  from   pg_policy p join pg_class c on c.oid = p.polrelid
  join   pg_namespace ns on ns.oid = c.relnamespace
  where  ns.nspname = 'public' and c.relname = 'closing_disclosure_agreement'
    and  p.polname = 'closing_disclosure_agreement_compliance_insert' and p.polcmd = 'a';

  select pg_get_expr(p.polqual, p.polrelid), pg_get_expr(p.polwithcheck, p.polrelid)
    into upd_qual, upd_chk
  from   pg_policy p join pg_class c on c.oid = p.polrelid
  join   pg_namespace ns on ns.oid = c.relnamespace
  where  ns.nspname = 'public' and c.relname = 'closing_disclosure_agreement'
    and  p.polname = 'closing_disclosure_agreement_compliance_update' and p.polcmd = 'w';

  if ins_chk is null or upd_qual is null then
    raise exception
      'm439: the compliance INSERT/UPDATE policies m438 merged forward are missing. Dropping compliance_officer_crud_cda was only safe BECAUSE that one capability was carried across — approveCdaAction, requestCdaChangesAction, manualOverrideCdaAction, closeCdaAction and the preliminary-CD path all write this table as a compliance officer, and the tier policies admit only is_brokerage_admin() and the owning agent. Without these two the compliance review queue is read-only and the CDA never leaves "submitted".';
  end if;

  if upd_chk is null then
    raise exception
      'm439: the compliance UPDATE policy has no WITH CHECK. USING says which rows may be acted on; WITH CHECK says what the row may BECOME. Without it a compliance officer can MOVE a settlement record into another brokerage — the cross-tenant hole again, from the write side.';
  end if;

  if ins_chk !~ 'has_brokerage_access' or upd_qual !~ 'has_brokerage_access' or upd_chk !~ 'has_brokerage_access' then
    raise exception
      'm439: a compliance write clause on closing_disclosure_agreement lost its tenant test. That is the whole defect m438 removed, re-created under a better name.';
  end if;

  if ins_chk !~ 'is_compliance_officer_role' or upd_qual !~ 'is_compliance_officer_role' then
    raise exception
      'm439: the compliance write policies no longer resolve the role through is_compliance_officer_role(). A second way to answer "is this user compliance" is how two answers to one question get created; the helper is the definition the next table inherits.';
  end if;

  select count(*) into n_all
  from   pg_policy p join pg_class c on c.oid = p.polrelid
  join   pg_namespace ns on ns.oid = c.relnamespace
  where  ns.nspname = 'public' and c.relname = 'closing_disclosure_agreement' and p.polcmd = '*';

  if n_all > 0 then
    raise exception
      'm439: closing_disclosure_agreement carries % FOR ALL policy/policies again. On FOR ALL, USING alone governs DELETE — there is no WITH CHECK to stop it — so a predicate written for reading becomes a licence to delete a closed deal''s disbursement instruction. Split it into per-command policies.', n_all;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 3 — THE HELPER THE MERGE RESTS ON IS THE RIGHT KIND OF FUNCTION
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Same three properties m434 claim 1 requires of the tier helpers, for the same
-- reasons: VOLATILE turns one read into one query per row, INVOKER returns FALSE
-- for anyone who cannot read their own users row (failing open or closed
-- depending on the table, invisibly), and a roster defined by EXCLUSION admits
-- every role invented after it — which is precisely how the "not an agent"
-- branch m433 removed came to hand a client portal the commission book.
do $$
declare vol char; sdef boolean; body text;
begin
  select p.provolatile, p.prosecdef, pg_get_functiondef(p.oid)
    into vol, sdef, body
  from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where  n.nspname = 'public' and p.proname = 'is_compliance_officer_role' limit 1;

  if vol is null then
    raise exception 'm439: public.is_compliance_officer_role() is missing — the merged CDA write policies depend on it.';
  end if;
  if vol <> 's' then
    raise exception 'm439: public.is_compliance_officer_role() is not STABLE (provolatile=%). It would read users once per row of every CDA read.', vol;
  end if;
  if not sdef then
    raise exception 'm439: public.is_compliance_officer_role() is not SECURITY DEFINER. It must read public.users without tripping users own RLS.';
  end if;
  if body ~* '(user_type\s*(<>|!=)|not\s+.{0,30}is_agent_role)' then
    raise exception 'm439: public.is_compliance_officer_role() defines its roster by EXCLUSION. State who MAY act, never who may not — a negative test admits every role invented later.';
  end if;
  if body !~* 'user_type\s+in\s*\(' then
    raise exception 'm439: public.is_compliance_officer_role() no longer names an explicit positive list of user_type values.';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 4 — NO POLICY ON THE SETTLEMENT RECORD GATES ON A ROLE NOBODY CAN HOLD
-- ─────────────────────────────────────────────────────────────────────────────
--
-- title_agent_select_cda was not merely unused: it was UNREACHABLE. m307 removed
-- 'title_agent' from users.user_type, and users_user_type_check now admits only
-- admin, agent, broker, broker_owner, compliance_officer, contact, isa, lender,
-- superadmin, support, system, tc, team_lead, vendor. No row can hold
-- 'title_agent', so the predicate was false for every user who will ever exist.
-- A title company is a VENDOR here (vendors.category includes 'title'), which is
-- the route that actually works.
--
-- A policy that matches nobody is not harmless — it is a capability the schema
-- claims to grant and does not, which is exactly how a surface gets declared
-- "covered" in a review and then fails in production.
--
-- ASSERTED ONLY FOR closing_disclosure_agreement, and here is what that leaves
-- out. Schema-wide the same measurement finds SEVEN more, on four other tables:
--   cda_comparison_results.title_agent_select_cda_comparison      'title_agent'
--   closing_disclosure.title_agent_select_closing_disclosure      'title_agent'
--   closing_disclosure.title_agent_create_closing_disclosure      'title_agent'
--   listings.compliance_read_brokerage_listings                   'compliance_manager'
--   listings.team_leader_read_team_listings                       'team_leader'
--   listings.tc_read_brokerage_listings                           'transaction_coordinator'
--   transactions.team_leader_read_team_transactions               'team_leader'
-- Those are real dead capabilities — a team lead is stored as 'team_lead', so
-- the team-board read on listings and transactions grants nothing to anybody —
-- but they are outside this migration's tables and are NOT fixed here. The
-- schema-wide census is raised as a WARNING below so it is recorded rather than
-- pretended closed; turning it into an exception is the follow-up wave's job,
-- after each of those four surfaces has been traced the way this one was.
do $$
declare
  admitted text[];
  lit      text;
  n        int := 0;
  census   text := '';
  r        record;
begin
  select array_agg(btrim(replace(x, '::text', ''), ''''))
    into admitted
  from   pg_constraint,
         lateral unnest(regexp_split_to_array((regexp_match(pg_get_constraintdef(oid), 'ARRAY\[(.*)\]'))[1], ',\s*')) as x
  where  conrelid = 'public.users'::regclass and conname = 'users_user_type_check';

  if admitted is null then
    raise exception 'm439: could not read users_user_type_check — the storable user_type vocabulary is the whole basis of this claim.';
  end if;

  for r in
    select c.relname as tbl, p.polname,
           coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as pred
    from   pg_policy p join pg_class c on c.oid = p.polrelid
    join   pg_namespace ns on ns.oid = c.relnamespace
    where  ns.nspname = 'public'
      and  coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~ 'user_type'
    order by c.relname, p.polname
  loop
    for lit in
      select (regexp_matches(r.pred, 'user_type[^;]{0,60}?''([a-z_]+)''::text', 'g'))[1]
    loop
      if not (lit = any (admitted)) then
        if r.tbl = 'closing_disclosure_agreement' then
          raise exception
            'm439: policy %.% gates on user_type = ''%'', which users_user_type_check cannot store. The predicate is false for every user who will ever exist, so the capability it appears to grant does not exist. If a title company needs this table, it reaches it as a VENDOR (vendors.category includes ''title''), not as a user_type that was removed from the vocabulary by m307.',
            r.tbl, r.polname, lit;
        end if;
        n := n + 1;
        census := census || format('  %s.%s  →  ''%s''', r.tbl, r.polname, lit) || chr(10);
      end if;
    end loop;
  end loop;

  if n > 0 then
    raise warning
      'm439: % polic(ies) elsewhere in public still gate on a user_type value users_user_type_check cannot store. Each is a capability the schema advertises and does not grant. Recorded, not fixed here — out of m438''s tables.%',
      n, chr(10) || census;
  end if;
end $$;

do $$
begin
  raise notice 'm439: all claims hold — no money-table policy grants on a tenant-free role test, the compliance write capability survived the drop, the settlement record is per-command so no USING is a delete grant, and the unreachable title_agent gate is gone from it.';
end $$;
