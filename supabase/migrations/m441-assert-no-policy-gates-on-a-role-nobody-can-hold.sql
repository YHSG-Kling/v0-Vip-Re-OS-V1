-- m441 — asserts m440.
--
-- Separate file because a `raise` rolls back its own transaction: asserting
-- inside m440 would undo the drops, the repairs and the two helper definitions it
-- is checking. Same split as m393/…/m432/m434/m436/m439.
--
-- Every claim pins a CONSTRUCT and derives its inputs from the database at
-- runtime — the storable vocabulary from `users_user_type_check`, the money
-- family from the COLUMNS a table carries, the vendor id class from the FOREIGN
-- KEY. None hardcodes the vocabulary it polices, because the whole defect m440
-- removed is a hardcoded vocabulary that drifted away from the one the database
-- will accept. A guard that carried its own copy of the role list would drift the
-- same way, on the same day, and go green while doing it.
--
-- ── CAN CLAIM 1 BE A HARD FAILURE NOW? YES — AND HERE IS EXACTLY WHAT IT COVERS
--
-- m439 claim 4 raised this class as a NOTICE census and asked the follow-up wave
-- to decide. The answer is yes for one precise construct and no for another, and
-- the two are different defects wearing the same spelling:
--
--   CLASS A — the policy is WHOLLY DEAD. Every user_type value it names is absent
--       from users_user_type_check, so the predicate is false for every user who
--       will ever exist and the policy grants nothing to anybody. Measured before
--       m440: exactly SEVEN, and they are exactly the seven m440 fixes. After
--       m440: ZERO, schema-wide. CLAIM 1 is a HARD FAILURE.
--
--   CLASS B — an INERT ELEMENT inside a live roster. `user_type = ANY (ARRAY[
--       'admin', 'broker', 'broker_admin', 'superadmin'])` still grants to admin,
--       broker and superadmin; 'broker_admin' simply matches nobody. Measured
--       after m440: 48 policies carry 55 such literals — chiefly 'broker_admin' (which
--       lib/security LEGACY_ROLE_MAP folds onto 'broker'), 'super_admin' (onto
--       'superadmin'), and the three m440 repaired sitting BESIDE their live
--       spelling on `contacts`. These are NOT dead capabilities: each policy still
--       grants to real roles, and the extra literal only widens a positive roster
--       to nobody — which is the safe direction, and is deliberately how
--       is_team_lead_role() and is_compliance_officer_role() are written. CLAIM 3
--       counts them as a WARNING with the number named, because removing one is a
--       per-table judgement about a live policy, not a mechanical fix, and half of
--       those tables belong to other work.
--
-- So the class is not "closed". It is closed for the construct that actually
-- denies a capability, and open — measured, counted and named — for the construct
-- that does not. Claim 3 prints the remaining count so nobody can read a green
-- run as "no dead role spellings remain".

-- ─────────────────────────────────────────────────────────────────────────────
-- THE EXTRACTOR, and why it is not a one-line regex
-- ─────────────────────────────────────────────────────────────────────────────
--
-- m439 claim 4's census used `user_type[^;]{0,60}?'([a-z_]+)'::text` with the 'g'
-- flag. That finds the FIRST literal after each `user_type` token and then
-- resumes scanning AFTER it — so for `user_type = ANY (ARRAY['a','b','c'])` it
-- sees 'a' and never 'b' or 'c', because the next match would need another
-- literal `user_type` occurrence to anchor on. Measured on this schema: that
-- pattern resolves 136 (policy, literal) pairs where the splitter below resolves
-- 360, and it saw 7 unstorable literals where there were 62. It under-counts in
-- the direction that matters: a policy is only WHOLLY dead if
-- EVERY literal in its roster is dead, and a regex that cannot see the rest of the
-- roster cannot tell class A from class B at all.
--
-- So each predicate is split at every `user_type` occurrence and each resulting
-- segment is matched against the three forms Postgres actually deparses a role
-- test into — `= ANY (ARRAY[…])`, `= ANY ('{…}'::text[])`, and a bare
-- `= 'lit'::text`. The `[^']{0,200}` prefix on the two set forms stops a segment
-- from reaching past its own comparison into a neighbouring clause's literal.
-- (200, not more: Postgres rejects a bound above 255.)
--
-- Verified total on this database before shipping: every `user_type` occurrence in
-- every policy in `public` resolves to a literal set — zero segments unmatched. A
-- segment that stops resolving is therefore a real change in how policies are
-- written, and claim 3 reports it as a warning rather than passing silently,
-- because an extractor that quietly sees nothing is a guard that quietly passes.

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 1 — NO POLICY GATES ON A ROLE NOBODY CAN HOLD  (HARD)
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare
  admitted  text[];
  r         record;
  seg       text;
  lits      text[];
  lit       text;
  n_live    int;
  n_dead    int;
  n_bad     int  := 0;
  offenders text := '';
begin
  select array_agg(btrim(replace(x, '::text', ''), ''''))
    into admitted
  from   pg_constraint,
         lateral unnest(regexp_split_to_array(
                   (regexp_match(pg_get_constraintdef(oid), 'ARRAY\[(.*)\]'))[1], ',\s*')) as x
  where  conrelid = 'public.users'::regclass and conname = 'users_user_type_check';

  if admitted is null or array_length(admitted, 1) is null then
    raise exception
      'm441: could not read the admitted user_type set from users_user_type_check. That constraint IS the vocabulary this claim is written against — deriving it at runtime rather than hardcoding it is the entire point, so a guard that cannot read it must fail rather than fall back to a copy that will drift.';
  end if;

  for r in
    select c.relname as tbl, p.polname,
           regexp_replace(
             coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
             coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), '\s+', ' ', 'g') as pred
    from   pg_policy p
    join   pg_class     c  on c.oid = p.polrelid
    join   pg_namespace ns on ns.oid = c.relnamespace
    where  ns.nspname = 'public'
      and  coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~ 'user_type'
    order  by c.relname, p.polname
  loop
    lits := '{}';

    -- coalesced to an empty array on purpose: FOREACH over a NULL array raises,
    -- and a guard that dies on an unexpected shape is a guard nobody runs.
    foreach seg in array coalesce((select array_agg(s order by o)
                            from unnest(regexp_split_to_array(r.pred, 'user_type'))
                                 with ordinality t(s, o)
                           where o > 1), '{}'::text[])
    loop
      lits := lits || coalesce(
        -- = ANY (ARRAY['a'::text, 'b'::text])
        (select regexp_split_to_array((regexp_match(seg, '^[^'']{0,200}= ANY \(ARRAY\[([^\]]*)\]'))[1], ',\s*')),
        -- = ANY ('{a,b}'::text[])
        (select regexp_split_to_array((regexp_match(seg, '^[^'']{0,200}= ANY \(''[{]([^}]*)[}]'''))[1], ',\s*')),
        -- = 'a'::text
        (select array[(regexp_match(seg, '^.{0,200}?= ''([a-z_]+)''::text'))[1]]),
        '{}'::text[]);
    end loop;

    lits := array(select distinct btrim(replace(x, '::text', ''), '''')
                    from unnest(lits) x where btrim(coalesce(x, '')) <> '');
    if array_length(lits, 1) is null then continue; end if;

    n_live := 0; n_dead := 0;
    foreach lit in array lits loop
      if lit = any (admitted) then n_live := n_live + 1; else n_dead := n_dead + 1; end if;
    end loop;

    if n_live = 0 and n_dead > 0 then
      n_bad := n_bad + 1;
      offenders := offenders || format('  %s.%s  →  every role it names is unstorable: %s',
                                       r.tbl, r.polname, array_to_string(lits, ', ')) || chr(10);
    end if;
  end loop;

  if n_bad > 0 then
    raise exception
      'm441: % polic(ies) gate on a user_type vocabulary that users_user_type_check cannot store. Every value they name is unstorable, so the predicate is FALSE for every user who will ever exist and the policy grants nothing to anybody — while reading, in a review, as the protection or the capability it is named after. That is worse than an absent policy: an absent policy is visibly absent. Decide each one: if the role was RENAMED (lib/security/types.ts LEGACY_ROLE_MAP is the repository''s mapping — transaction_coordinator→tc, compliance_manager→compliance_officer, team_leader→team_lead), repair it through the named helper and give it a tenant anchor. If the role was REMOVED from the vocabulary (title_agent, by m307 — a title company is a vendors.category = ''title''), drop the policy and record why.%',
      n_bad, chr(10) || offenders;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 2 — NO POLICY DEFINES ITS ROSTER BY EXCLUSION  (HARD)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The other way a role test stops meaning what it says. `user_type <> 'agent'` is
-- TRUE for a contact, a lender, a vendor and every role invented after it — it is
-- the `NOT is_agent_role()` branch m433 removed, spelled inline. m434 claim 2 and
-- m439 claim 3 forbid it inside the tier HELPERS; nothing forbade it in a policy.
--
-- Measured before shipping: zero occurrences schema-wide. This claim is therefore
-- free today, and its whole value is that it stays free — a negative test is the
-- one shape that gets WIDER every time someone adds a role, silently, without
-- anybody editing the policy.
do $$
declare
  r         record;
  n         int  := 0;
  offenders text := '';
begin
  for r in
    select c.relname as tbl, p.polname
    from   pg_policy p
    join   pg_class     c  on c.oid = p.polrelid
    join   pg_namespace ns on ns.oid = c.relnamespace
    where  ns.nspname = 'public'
      and  regexp_replace(
             coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
             coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), '\s+', ' ', 'g')
           ~* 'user_type[^;]{0,120}(<>|!=|<> ALL|NOT IN)'
    order  by c.relname, p.polname
  loop
    n := n + 1;
    offenders := offenders || format('  %s.%s', r.tbl, r.polname) || chr(10);
  end loop;

  if n > 0 then
    raise exception
      'm441: % polic(ies) test user_type by EXCLUSION. "Not an agent" is TRUE for a contact, a lender and a vendor — that exact clause is how a client portal read the brokerage''s commission book (m433) — and it admits every role invented later, by default, with nobody editing anything. State who MAY act, never who may not.%',
      n, chr(10) || offenders;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 3 — THE INERT-ELEMENT CENSUS  (WARNING, WITH THE COUNT NAMED)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Class B from the header. A dead literal beside a live one in a positive roster
-- denies nothing and grants nothing extra — it widens the roster to nobody. It is
-- reported, never raised, and the count is printed so a green run cannot be read
-- as "no dead role spellings remain in this schema". Measured immediately after
-- m440 applied: 48 policies, 55 literals, in exactly five spellings —
-- broker_admin, super_admin, compliance_manager, team_leader and
-- transaction_coordinator.
--
-- It is deliberately NOT promoted to a failure. Two reasons, both load-bearing:
--   · Removing one changes a LIVE policy's roster, which is a per-table judgement
--     about who should be able to do what — the same judgement m440 made four
--     times, each with a screen trace behind it. A sweep would be a mechanical
--     edit of predicates nobody has read.
--   · Several of these spellings are the app's own legacy vocabulary
--     (LEGACY_ROLE_MAP), and the day an invite path starts writing 'broker_admin'
--     again — the CHECK would reject it today, but that is a constraint, not a
--     law — the literal becomes live. Deleting it now is not obviously right.
do $$
declare
  admitted  text[];
  r         record;
  seg       text;
  lits      text[];
  lit       text;
  n_live    int;
  n_dead    int;
  n_pol     int  := 0;
  n_lit     int  := 0;
  n_blind   int  := 0;
  census    text := '';
begin
  select array_agg(btrim(replace(x, '::text', ''), ''''))
    into admitted
  from   pg_constraint,
         lateral unnest(regexp_split_to_array(
                   (regexp_match(pg_get_constraintdef(oid), 'ARRAY\[(.*)\]'))[1], ',\s*')) as x
  where  conrelid = 'public.users'::regclass and conname = 'users_user_type_check';

  for r in
    select c.relname as tbl, p.polname,
           regexp_replace(
             coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
             coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), '\s+', ' ', 'g') as pred
    from   pg_policy p
    join   pg_class     c  on c.oid = p.polrelid
    join   pg_namespace ns on ns.oid = c.relnamespace
    where  ns.nspname = 'public'
      and  coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~ 'user_type'
    order  by c.relname, p.polname
  loop
    lits := '{}';
    -- coalesced to an empty array on purpose: FOREACH over a NULL array raises,
    -- and a guard that dies on an unexpected shape is a guard nobody runs.
    foreach seg in array coalesce((select array_agg(s order by o)
                            from unnest(regexp_split_to_array(r.pred, 'user_type'))
                                 with ordinality t(s, o)
                           where o > 1), '{}'::text[])
    loop
      lits := lits || coalesce(
        (select regexp_split_to_array((regexp_match(seg, '^[^'']{0,200}= ANY \(ARRAY\[([^\]]*)\]'))[1], ',\s*')),
        (select regexp_split_to_array((regexp_match(seg, '^[^'']{0,200}= ANY \(''[{]([^}]*)[}]'''))[1], ',\s*')),
        (select array[(regexp_match(seg, '^.{0,200}?= ''([a-z_]+)''::text'))[1]]),
        '{}'::text[]);
    end loop;

    lits := array(select distinct btrim(replace(x, '::text', ''), '''')
                    from unnest(lits) x where btrim(coalesce(x, '')) <> '');

    if array_length(lits, 1) is null then
      n_blind := n_blind + 1;
      continue;
    end if;

    n_live := 0; n_dead := 0;
    foreach lit in array lits loop
      if lit = any (admitted) then n_live := n_live + 1; else n_dead := n_dead + 1; end if;
    end loop;

    if n_dead > 0 and n_live > 0 then
      n_pol := n_pol + 1;
      n_lit := n_lit + n_dead;
      census := census || format('  %s.%s  →  %s', r.tbl, r.polname,
                  array_to_string(array(select x from unnest(lits) x
                                         where not (x = any (admitted))), ', ')) || chr(10);
    end if;
  end loop;

  if n_blind > 0 then
    raise warning
      'm441: % polic(ies) mention user_type in a shape this extractor could not resolve to a literal set. Zero did when it was written, so a policy is now written in a form the claim above cannot read — and a claim that silently sees nothing passes silently. Extend the extractor before trusting claim 1 again.', n_blind;
  end if;

  if n_pol > 0 then
    raise warning
      'm441: % polic(ies) name % user_type literal(s) that users_user_type_check cannot store, BESIDE at least one that it can. These are inert elements in a live roster, not dead capabilities — each policy still grants to real roles, and a positive roster widened to nobody is the safe direction. Recorded, not failed: removing one is a per-table judgement about a live policy. The class of WHOLLY dead policies (claim 1) is closed; this one is not, and this number is what remains.%',
      n_pol, n_lit, chr(10) || census;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 4 — THE REPAIRS LANDED, AND THE TEAM IS RESOLVED ONE WAY  (HARD)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- m416's lesson, and m439 claim 2 repeated it: assert that the REWRITE landed,
-- not only that the old spelling left. Claim 1 passes just as happily if someone
-- deletes all four policies outright — the capability would be gone and the
-- construct still clean. A tc's brokerage inventory and a team lead's own board
-- are the capabilities these policies exist to grant.
--
-- Three properties per policy, all construct-level:
--   · it resolves the ROLE through a named helper, not an inlined literal — so
--     the next spelling change is inherited rather than copied. This is the fix
--     for the defect's actual cause: scripts/111 inlined the bodies of helper
--     functions that were never installed.
--   · it carries a TENANT anchor. A role test says WHO may act; it never says
--     WHICH ROWS (m439 claim 1).
--   · the TEAM ones resolve the team through public.current_user_team_id() and
--     never read `users.team_id` directly. m431 made resolve_team_id() the ONE
--     rule precisely because a team can be recorded in four places and the public
--     roster and the team P&L already disagreed on live data; a policy that reads
--     one of the four inline is a fifth answer.
do $$
declare
  targets text[][] := array[
    ['listings',     'compliance_read_brokerage_listings',   'is_compliance_officer_role', ''],
    ['listings',     'tc_read_brokerage_listings',           'is_tc_role',                 ''],
    ['listings',     'team_leader_read_team_listings',       'is_team_lead_role',          'team'],
    ['transactions', 'team_leader_read_team_transactions',   'is_team_lead_role',          'team']
  ];
  i    int;
  pred text;
begin
  for i in 1 .. array_length(targets, 1) loop
    select regexp_replace(coalesce(pg_get_expr(p.polqual, p.polrelid), ''), '\s+', ' ', 'g')
      into pred
      from pg_policy p
      join pg_class     c  on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relname = targets[i][1] and p.polname = targets[i][2];

    if pred is null then
      raise exception
        'm441: %.% is gone. m440 REPAIRED it rather than dropping it because the role it names is real and live, and the repository declares the capability: supabase/rls-governance/005-listings-policies.sql states the compliance and tc reads in words, lib/security/permission-matrix.ts grants tc listings:view_all at brokerage scope, and app/dashboard/team/page.tsx is built for the team tier. Deleting it removes a working screen, not a defect.',
        targets[i][1], targets[i][2];
    end if;

    if pred !~ targets[i][3] then
      raise exception
        'm441: %.% no longer resolves its role through public.%(). It is back to naming a user_type value directly, which is precisely how this policy came to gate on a spelling users_user_type_check cannot store: scripts/111-fix-agent-id-rls-policies.sql inlined the body of an auth.* helper that was never installed. The helper is the definition the next table inherits. Predicate now: %',
        targets[i][1], targets[i][2], targets[i][3], pred;
    end if;

    if pred !~ '(has_brokerage_access|current_user_brokerage_id|user_brokerage_ids)' then
      raise exception
        'm441: %.% lost its tenant anchor. A role test says WHO may act; it never says WHICH ROWS. Without a tenant term this grants that role every brokerage on the platform — the class m438 removed from the settlement record. Predicate now: %',
        targets[i][1], targets[i][2], pred;
    end if;

    if targets[i][4] = 'team' then
      if pred !~ 'current_user_team_id' then
        raise exception
          'm441: %.% no longer resolves the caller''s team through public.current_user_team_id(). m431 made public.resolve_team_id() THE ONE RULE because a team membership is recorded in FOUR places on this schema (teams.team_lead_id, users.team_id, team_members, agents.team_id) and the public roster and the team P&L already disagree on live data. A policy with its own resolution is a fifth answer, and it decides who sees a team''s board.',
          targets[i][1], targets[i][2];
      end if;
      if pred ~ '\.team_id\s*=' and pred !~ 'agent_team_id' then
        raise exception
          'm441: %.% reads a team column directly instead of going through public.agent_team_id(). users.team_id is NULL for all 23 live users; it is one of the four sources resolve_team_id() ranks, not the answer. Predicate now: %',
          targets[i][1], targets[i][2], pred;
      end if;
      if pred ~ 'brokerage_id\s*=\s*\(\s*SELECT' then
        raise exception
          'm441: %.% has an unconditional brokerage disjunct again. Owner ruling: "teams should only see their own board." The predicate this repaired read `user_type = ''team_leader'' AND (brokerage_id = <caller''s brokerage> OR <team match>)` — the team clause was decoration beside a whole-brokerage grant. Predicate now: %',
          targets[i][1], targets[i][2], pred;
      end if;
    end if;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 5 — THE MONEY FAMILY, WIDENED BY THE METERED PRODUCTS  (HARD)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The brief asked whether the settled-money column family m434 claim 3 and m439
-- claim 1 key on should be widened. It should, and here is the measurement behind
-- the answer and behind its limit.
--
-- WHY IT MUST WIDEN. vendor_subscriptions fell through BOTH guards while carrying
-- four bare-tenant policies on SELECT, INSERT, UPDATE and DELETE. It was not an
-- oversight in either guard — both are honest about their scope, and m439's header
-- names this table as a known exclusion. The gap is structural: the family is a
-- list of AMOUNT names, and a metered product's unit of account is a CREDIT. The
-- next credits/quota table lands in exactly the same gap.
--
-- SO IT IS WIDENED BY THE CREDIT-LEDGER NAMES, and by nothing else. Measured on
-- this database, the widening admits exactly two tables — vendor_subscriptions
-- (credits_used_this_period) and vendor_transactions (credits_used) — both of
-- which m440 and m433 have already put on a tier. No table outside this
-- assignment enters, so the widening is enforceable today rather than aspirational.
--
-- AND IT IS DELIBERATELY NOT WIDENED TO BILLING IDENTITY. The sharpest thing in a
-- vendor_subscriptions row is arguably not a number at all: `stripe_customer_id`
-- and `stripe_subscription_id` are text, and no amount-name family will ever catch
-- them. Adding them was measured and rejected — it would pull in `agents`
-- (stripe_customer_id) and `vendor_marketplace_profiles` (stripe_customer_id,
-- stripe_subscription_id, api_key_encrypted), two tables outside this assignment,
-- and vendor_marketplace_profiles carries a live `FOR ALL` policy whose entire
-- predicate is `user_type = ANY (ARRAY['admin', 'broker'])` with NO tenant term —
-- the m438 class, still open, on a table that has no brokerage_id to anchor to and
-- therefore needs a ruling, not a sweep. Widening the family to text billing ids
-- would make this guard red on somebody else's table on the day it is applied,
-- which is how a guard gets disabled. Both are reported, not fixed.
--
-- The construct itself is m434 claim 3's, unchanged: on a table in the family, no
-- policy that can READ may reach the tenant unless the SAME predicate also tests
-- WHO the caller is. Any role vocabulary counts — the tier helpers, the older
-- is_*_role family, a literal user_type comparison, auth.uid(), an ownership
-- column — because this must pass on strictly better code that reaches the same
-- rule by another route (brief §4(g)).
do $$
declare
  r         record;
  n         int  := 0;
  offenders text := '';
begin
  for r in
    with metered as (
      select distinct co.table_name
      from   information_schema.columns co
      join   pg_class     pc on pc.relname = co.table_name
      join   pg_namespace pn on pn.oid = pc.relnamespace and pn.nspname = 'public'
      where  co.table_schema = 'public'
        and  pc.relkind = 'r'
        and  co.data_type in ('numeric', 'double precision', 'real', 'integer', 'bigint', 'money')
        and  co.column_name in (
               -- the unit of account of a METERED product. Not an amount, which is
               -- why the amount family could not see this table.
               'credits_used_this_period', 'credits_used', 'credits_remaining',
               'credits_granted', 'credits_included', 'credits_purchased',
               'credits_allocated', 'credits_consumed', 'credit_balance',
               'quota_used', 'quota_limit'
             )
    )
    select p.tablename, p.policyname, p.cmd
    from   pg_policies p
    where  p.schemaname = 'public'
      and  p.cmd in ('SELECT', 'ALL')
      and  p.tablename in (select table_name from metered)
      and  'service_role' <> all (p.roles)
      and  coalesce(p.qual, '') ~ '(current_user_brokerage_id|has_brokerage_access|user_brokerage_ids)'
      and  coalesce(p.qual, '') !~ '(can_read_tenant_financials|can_read_brokerage_books|can_read_agent_books|can_read_team_books|is_tenant_staff|is_current_user_vendor|is_current_user_marketplace_vendor|is_brokerage_admin|is_platform_admin|is_platform_staff|is_agent_role|is_team_lead_role|is_tc_role|is_compliance_officer_role|current_user_type|user_type|auth\.uid|current_user_agent_id)'
    order by p.tablename, p.policyname
  loop
    n := n + 1;
    offenders := offenders || format('  %s  [%s %s]', r.tablename, r.cmd, r.policyname) || chr(10);
  end loop;

  if n > 0 then
    raise exception
      'm441: % polic(ies) on a METERED-CREDIT table let any user of a brokerage reach that brokerage''s row with no test of who they are. users.brokerage_id is stamped on a contact, a lender and a vendor exactly as on a broker''s, so `brokerage_id = current_user_brokerage_id()` alone hands the client portal the subscription book — which marketplace vendors the brokerage pays, its Stripe customer and subscription ids, and its credit burn. The settled-AMOUNT family m434/m439 key on cannot see these tables: a metered product''s unit of account is a credit, not an amount. Add a positive role branch — can_read_brokerage_books(), is_current_user_marketplace_vendor(vendor_id), or another named tier helper.%',
      n, chr(10) || offenders;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 6 — A VENDOR-OWN-ROW BRANCH MATCHES THE ID CLASS IT TESTS  (HARD)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- There are TWO vendor identities on this schema — `vendors` (the brokerage's
-- directory) and `vendor_marketplace_profiles` (the platform marketplace seller) —
-- and a column called `vendor_id` may hold either. Which one it holds is not a
-- matter of opinion: the FOREIGN KEY says so, and this claim reads it rather than
-- carrying a list of table names.
--
--   is_current_user_vendor(x)              resolves user_role_assignments.vendor_id
--                                          → a `vendors` id.
--   is_current_user_marketplace_vendor(x)  resolves vendor_marketplace_profiles
--                                          .user_id → a profile id.
--
-- Pair them the wrong way and the disjunct compares two disjoint uuid spaces: it
-- is false for every row that will ever exist. That is the same dead-capability
-- defect claim 1 polices, reached through an id class instead of a spelling — and
-- it is exactly what m433 shipped on vendor_transactions, where the helper says a
-- vendor can see their own marketplace revenue and the column it tests could never
-- have matched. Invisible today only because 0 of 7 user_role_assignments rows
-- carry a vendor_id, which is precisely the condition under which a wrong branch
-- and a right branch look identical.
do $$
declare
  r         record;
  n         int  := 0;
  offenders text := '';
begin
  for r in
    select c.relname as tbl, p.polname,
           coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') as pred,
           (select tgt.relname
              from pg_constraint con
              join pg_class tgt on tgt.oid = con.confrelid
             where con.conrelid = c.oid and con.contype = 'f'
               and (select a.attname from pg_attribute a
                     where a.attrelid = c.oid and a.attnum = con.conkey[1]) = 'vendor_id'
             limit 1) as fk_target
    from   pg_policy p
    join   pg_class     c  on c.oid = p.polrelid
    join   pg_namespace ns on ns.oid = c.relnamespace
    where  ns.nspname = 'public'
      and  coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
           coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~ 'is_current_user_(marketplace_)?vendor\s*\(\s*vendor_id'
    order  by c.relname, p.polname
  loop
    if r.fk_target is null then
      -- No FK on vendor_id: the id class is undeclared, so neither helper can be
      -- shown correct. Reported, not failed — an unconstrained column is a schema
      -- gap, not a policy defect.
      raise warning
        'm441: %.% tests a vendor helper against %.vendor_id, which has no foreign key. Nothing declares which vendor id class that column holds, so neither helper can be shown to match it. Add the FK.',
        r.tbl, r.polname, r.tbl;
      continue;
    end if;

    if r.fk_target = 'vendors'
       and r.pred ~ 'is_current_user_marketplace_vendor\s*\(\s*vendor_id' then
      n := n + 1;
      offenders := offenders || format('  %s.%s  →  vendor_id FKs `vendors`, tested with is_current_user_marketplace_vendor()', r.tbl, r.polname) || chr(10);
    end if;

    if r.fk_target = 'vendor_marketplace_profiles'
       and r.pred ~ '[^_]is_current_user_vendor\s*\(\s*vendor_id' then
      n := n + 1;
      offenders := offenders || format('  %s.%s  →  vendor_id FKs `vendor_marketplace_profiles`, tested with is_current_user_vendor()', r.tbl, r.polname) || chr(10);
    end if;
  end loop;

  if n > 0 then
    raise exception
      'm441: % vendor-own-row branch(es) test a vendor id against the wrong identity. `vendors` (the brokerage''s directory, reached through user_role_assignments.vendor_id) and `vendor_marketplace_profiles` (the platform seller, reached through its own user_id) are disjoint uuid spaces. A mismatched branch is FALSE for every row that will ever exist, so "a vendor sees their own payout" — the "but only their own" half of the owner''s ruling — silently grants nothing while reading as though it works. Use the helper that matches the column''s foreign key.%',
      n, chr(10) || offenders;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 7 — THE TWO NEW HELPERS ARE THE RIGHT KIND OF FUNCTION  (HARD)
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Same three properties m434 claim 1 and m439 claim 3 require, for the same
-- reasons: VOLATILE turns one read of `users` into one query per row of every
-- listing; INVOKER returns FALSE for anyone who cannot read their own users row,
-- failing open or closed depending on the table and invisibly either way; and a
-- roster defined by EXCLUSION admits every role invented after it.
--
-- is_current_user_marketplace_vendor() is additionally required to resolve from
-- the SESSION (auth.uid()) and through the marketplace profile table — brief
-- §4(d): never derive identity from a caller-supplied id.
do $$
declare
  fn   text;
  vol  char;
  sdef boolean;
  body text;
begin
  foreach fn in array array['is_tc_role', 'is_current_user_marketplace_vendor'] loop
    select p.provolatile, p.prosecdef, pg_get_functiondef(p.oid)
      into vol, sdef, body
    from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where  n.nspname = 'public' and p.proname = fn limit 1;

    if vol is null then
      raise exception
        'm441: public.%() is missing. m440''s repaired policies depend on it — deleting a helper does not simplify anything, it scatters the rule back into inlined user_type lists, which is the defect m440 removed.', fn;
    end if;
    if vol <> 's' then
      raise exception 'm441: public.%() is not STABLE (provolatile=%). It would re-read its source table once per row.', fn, vol;
    end if;
    if not sdef then
      raise exception 'm441: public.%() is not SECURITY DEFINER. It must read its source table without tripping that table''s own RLS, and without a policy that calls it recursing into a policy that calls it.', fn;
    end if;
  end loop;

  select pg_get_functiondef(p.oid) into body
  from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where  n.nspname = 'public' and p.proname = 'is_tc_role' limit 1;

  if body ~* '(user_type\s*(<>|!=)|not\s+.{0,30}is_agent_role)' then
    raise exception 'm441: public.is_tc_role() defines its roster by EXCLUSION. State who MAY act, never who may not.';
  end if;
  if body !~* 'user_type\s+in\s*\(' then
    raise exception 'm441: public.is_tc_role() no longer names an explicit positive list of user_type values. That list IS the rule.';
  end if;
  if body ~* '''(contact|lender|vendor)''' then
    raise exception
      'm441: public.is_tc_role() names contact, lender or vendor. Owner ruling: "contacts, lenders and vendors do not see commission or any financials but only their own." A coordinator roster is not where a portal role gets in.';
  end if;

  select pg_get_functiondef(p.oid) into body
  from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where  n.nspname = 'public' and p.proname = 'is_current_user_marketplace_vendor' limit 1;

  if body !~ 'vendor_marketplace_profiles' then
    raise exception
      'm441: public.is_current_user_marketplace_vendor() no longer resolves through vendor_marketplace_profiles. That table''s own "Vendors can view their own profile" policy is the linkage this reuses; a second linkage means two answers to "is this my marketplace row".';
  end if;
  if body !~ 'auth\.uid\(\)' then
    raise exception
      'm441: public.is_current_user_marketplace_vendor() does not resolve the caller from the session (auth.uid()). Never derive identity from a caller-supplied id — resolve from the session, then authorise the id against it.';
  end if;
  if body ~ 'user_role_assignments' then
    raise exception
      'm441: public.is_current_user_marketplace_vendor() reads user_role_assignments. That column holds a `vendors` id and is what is_current_user_vendor() is for; resolving a marketplace profile through it recreates the id-class mismatch claim 6 exists to catch.';
  end if;
end $$;

do $$
begin
  raise notice 'm441: all hard claims hold — no policy in public gates on a user_type vocabulary the CHECK cannot store, no policy defines its roster by exclusion, the four repaired policies resolve their role through a named helper and carry a tenant anchor with the team resolved once, the metered-credit tables reach no tenant without a role, and each vendor-own-row branch matches the id class its foreign key declares. The inert-element census remains, as a warning, with its count named.';
end $$;
