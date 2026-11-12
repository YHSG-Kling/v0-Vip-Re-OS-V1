-- m434 — asserts m433.
--
-- Separate file because a `raise` rolls back its own transaction: asserting
-- inside m433 would undo the helper definitions and the policy rewrites it is
-- checking. Same split as m393/m395/m397/m399/m403/m405/m407/m409/m412/m414/
-- m416/m418/m420/m422/m424/m426/m428/m430.
--
-- Every claim below pins a CONSTRUCT — the SHAPE of a predicate, the existence
-- and character of a named helper, the presence of a flag. None pins a list of
-- table names, a policy name, or a select-list, because guards that pin
-- spellings go red on strictly better code, which has happened four times in
-- this workstream. In particular CLAIM 3 discovers the tables it polices from
-- the COLUMNS they carry, so the next money table someone adds is policed the
-- day it exists, without anyone remembering to add it here.

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 1 — THE FIVE TIER HELPERS EXIST AND ARE THE RIGHT KIND OF FUNCTION
-- ─────────────────────────────────────────────────────────────────────────────
--
-- STABLE so the planner may cache the answer per statement instead of
-- re-querying `users` once per row; SECURITY DEFINER so the helper can read
-- `users` without tripping users' own RLS and without a policy recursing into
-- itself. Both properties are load-bearing — a VOLATILE helper turns a
-- thousand-row read into a thousand extra queries, and an INVOKER helper
-- silently returns FALSE for anyone who cannot read their own users row, which
-- would fail OPEN or CLOSED depending on the table and be very hard to see.

do $$
declare
  want text[] := array[
    'can_read_brokerage_books',
    'is_tenant_staff',
    'can_read_agent_books',
    'can_read_team_books',
    'is_current_user_vendor'
  ];
  fn   text;
  vol  char;
  sdef boolean;
begin
  foreach fn in array want loop
    select p.provolatile, p.prosecdef into vol, sdef
    from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where  n.nspname = 'public' and p.proname = fn
    limit  1;

    if vol is null then
      raise exception
        'm434: public.%() is missing. The owner ruled "contacts, lenders and vendors do not see commission or any financials but only their own". That ruling is implemented as ONE named helper per visibility tier so the next money table inherits a definition instead of copying a predicate; deleting a helper does not simplify anything, it just scatters the rule back into two dozen inlined user_type lists.', fn;
    end if;

    if vol <> 's' then
      raise exception
        'm434: public.%() is not STABLE (provolatile=%). It reads users once per row otherwise, on every financial table in the schema.', fn, vol;
    end if;

    if not sdef then
      raise exception
        'm434: public.%() is not SECURITY DEFINER. It must read public.users without tripping users own RLS, and without a policy that calls it recursing into a policy that calls it.', fn;
    end if;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 2 — THE ROSTERS ARE POSITIVE, NOT NEGATIVE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- This is the whole lesson of the defect. The old brokerage-wide branch was
-- `(NOT is_agent_role()) AND has_brokerage_access(brokerage_id)`. `is_agent_role()`
-- is exactly `user_type = 'agent'`, so "not an agent" is TRUE for a contact, a
-- lender and a vendor — that single clause is how a client read the brokerage's
-- commission book, and it would have silently admitted every role invented after
-- it. A helper whose body NEGATES a role test has reintroduced the defect no
-- matter what it is called, so the body is checked, not the name.

do $$
declare
  fn   text;
  body text;
begin
  foreach fn in array array['can_read_brokerage_books', 'is_tenant_staff'] loop
    select pg_get_functiondef(p.oid) into body
    from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where  n.nspname = 'public' and p.proname = fn limit 1;

    if body ~* '(not\s+(public\.)?is_agent_role|user_type\s*(<>|!=)|not\s*\(\s*user_type)' then
      raise exception
        'm434: public.%() defines its roster by EXCLUSION. A negative role test is exactly the defect m433 removed: "not an agent" is TRUE for a contact, a lender and a vendor, and it admits every role invented later by default. State who MAY see the money, never who may not.', fn;
    end if;

    if body !~* 'user_type\s+in\s*\(' then
      raise exception
        'm434: public.%() no longer names an explicit positive list of user_type values. That list IS the ruling.', fn;
    end if;
  end loop;

  -- The three portal roles the owner named must appear in NEITHER roster.
  foreach fn in array array['can_read_brokerage_books', 'is_tenant_staff'] loop
    select pg_get_functiondef(p.oid) into body
    from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where  n.nspname = 'public' and p.proname = fn limit 1;

    if body ~* '''(contact|lender|vendor)''' then
      raise exception
        'm434: public.%() names contact, lender or vendor. Owner ruling, verbatim: "contacts, lenders and vendors do not see commission or any financials but only their own." Their own records reach them through is_current_user_vendor(vendor_id) and the portal surfaces, never through a tenant-wide roster.', fn;
    end if;
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 3 — THE CONSTRUCT: NO MONEY TABLE REACHES THE TENANT WITHOUT A ROLE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The assertion the whole wave exists for, and the one that has to still work in
-- a year. It does not know any table names. It discovers the money tables from
-- the COLUMNS they carry — a family of SETTLED AMOUNT names (a gross commission,
-- an agent net, a cap, a payout, a P&L line), deliberately NOT rates or
-- percentages, because a `commission_rate` on a live offer or listing agreement
-- is a term of a deal an ordinary agent works from all day, not the brokerage's
-- book.
--
-- For every such table it then requires: no policy that can READ (SELECT, or
-- ALL) may reach the tenant — through current_user_brokerage_id(),
-- has_brokerage_access() or user_brokerage_ids() — unless the SAME predicate
-- also carries a test of WHO the caller is. Any of the tier helpers counts; so
-- does the older vocabulary (is_platform_admin, is_brokerage_admin,
-- current_user_type, a literal user_type comparison, auth.uid(),
-- current_user_agent_id) — because this guard must pass on strictly better code
-- that arrives at the same rule by a different route, not only on m433's exact
-- spelling.
--
-- service_role policies are exempt: service_role is not a tenant.

do $$
declare
  offenders text := '';
  n         int  := 0;
  r         record;
begin
  for r in
    with money as (
      select distinct c.table_name
      from   information_schema.columns c
      join   pg_class     pc on pc.relname = c.table_name
      join   pg_namespace pn on pn.oid = pc.relnamespace and pn.nspname = 'public'
      where  c.table_schema = 'public'
        and  pc.relkind = 'r'
        and  c.data_type in ('numeric', 'double precision', 'real', 'integer', 'bigint', 'money')
        and  c.column_name in (
               -- a settled amount of money that belongs to the brokerage,
               -- an agent, a team, a vendor or the platform's bill to a tenant
               'gross_commission', 'agent_commission', 'brokerage_commission',
               'net_to_agent', 'net_to_brokerage', 'agent_net', 'brokerage_net',
               'team_net', 'total_fees', 'cap_amount', 'cap_paid_to_date',
               'agent_splits_paid', 'gross_commission_income', 'net_profit',
               'total_income', 'total_expenses', 'agent_amount', 'brokerage_amount',
               'gross_amount', 'net_amount', 'platform_fee', 'amount_cents',
               'gross_total', 'net_total', 'agent_payout', 'gci_gross',
               'brokerage_gross', 'commission_cents', 'lifetime_brokerage_net',
               'brokerage_net_from_agent', 'gross_commission_generated',
               'income_goal', 'default_budget', 'total_amount'
             )
    )
    select p.tablename, p.policyname, p.cmd
    from   pg_policies p
    where  p.schemaname = 'public'
      and  p.cmd in ('SELECT', 'ALL')
      and  p.tablename in (select table_name from money)
      and  'service_role' <> all (p.roles)
      and  coalesce(p.qual, '') ~ '(current_user_brokerage_id|has_brokerage_access|user_brokerage_ids)'
      and  coalesce(p.qual, '') !~ '(can_read_tenant_financials|can_read_brokerage_books|can_read_agent_books|can_read_team_books|is_tenant_staff|is_current_user_vendor|is_brokerage_admin|is_platform_admin|is_platform_staff|is_agent_role|is_team_lead_role|current_user_type|user_type|auth\.uid|current_user_agent_id)'
    order by p.tablename, p.policyname
  loop
    n := n + 1;
    offenders := offenders || format('%s  [%s %s]%s', r.tablename, r.cmd, r.policyname, chr(10));
  end loop;

  if n > 0 then
    raise exception
      'm434: % policy/policies let ANY user of a brokerage read that brokerage''s money, with no test of who they are. `users.brokerage_id` is stamped on a contact, a lender and a vendor account exactly as it is on a broker''s, so a predicate that only asks "same tenant?" hands the client portal the commission book. Owner ruling: "contacts, lenders and vendors do not see commission or any financials but only their own." Add a positive role branch — can_read_brokerage_books(), can_read_agent_books(agent_id), can_read_team_books(team_id), is_tenant_staff() or is_current_user_vendor(vendor_id).%s%s',
      n, chr(10), offenders;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 4 — NO MONEY TABLE PUBLISHES ITS UNSTAMPED ROWS TO EVERY TENANT
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `(brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())` reads
-- like a null-safety courtesy and is the opposite: NULL satisfies it for EVERY
-- tenant, so an unstamped row is PUBLISHED, not hidden — and the same shape on
-- UPDATE and DELETE means a competing brokerage could rewrite or drop it. Twelve
-- money tables carried it before m433. has_brokerage_access(x) is FALSE for a
-- NULL x, which is the correct direction: an unstamped row is nobody's until
-- someone stamps it.
--
-- Scoped to the same discovered money family as CLAIM 3, deliberately: elsewhere
-- in this schema a NULL brokerage_id legitimately means "platform catalogue"
-- (m406, m421 — shared courses, shared tax categories, default plan tiers), and
-- this guard must not go red on those.

do $$
declare
  offenders text := '';
  n         int  := 0;
  r         record;
begin
  for r in
    with money as (
      select distinct c.table_name
      from   information_schema.columns c
      join   pg_class     pc on pc.relname = c.table_name
      join   pg_namespace pn on pn.oid = pc.relnamespace and pn.nspname = 'public'
      where  c.table_schema = 'public'
        and  pc.relkind = 'r'
        and  c.data_type in ('numeric', 'double precision', 'real', 'integer', 'bigint', 'money')
        and  c.column_name in (
               'gross_commission', 'agent_commission', 'brokerage_commission',
               'net_to_agent', 'net_to_brokerage', 'agent_net', 'brokerage_net',
               'team_net', 'total_fees', 'cap_amount', 'cap_paid_to_date',
               'agent_splits_paid', 'gross_commission_income', 'net_profit',
               'total_income', 'total_expenses', 'agent_amount', 'brokerage_amount',
               'gross_amount', 'net_amount', 'platform_fee', 'amount_cents',
               'gross_total', 'net_total', 'agent_payout', 'gci_gross',
               'brokerage_gross', 'commission_cents', 'lifetime_brokerage_net',
               'brokerage_net_from_agent', 'gross_commission_generated',
               'income_goal', 'default_budget', 'total_amount'
             )
    )
    select p.tablename, p.policyname, p.cmd
    from   pg_policies p
    where  p.schemaname = 'public'
      and  p.tablename in (select table_name from money)
      and  'service_role' <> all (p.roles)
      and  coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')
             ~* 'brokerage_id\s+is\s+null'
    order by p.tablename, p.policyname
  loop
    n := n + 1;
    offenders := offenders || format('%s  [%s %s]%s', r.tablename, r.cmd, r.policyname, chr(10));
  end loop;

  if n > 0 then
    raise exception
      'm434: % money policy/policies still carry the `brokerage_id IS NULL` escape. A NULL tenant satisfies that disjunct for EVERY brokerage on the platform, so an unstamped row of money is published to all of them — and, on the write clauses, is editable and deletable by all of them. Drop the disjunct and let has_brokerage_access() reject the NULL.%s%s',
      n, chr(10), offenders;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 5 — THE PLATFORM'S FINANCIAL READERS STILL HOLD NO PEN
-- ─────────────────────────────────────────────────────────────────────────────
--
-- m427 established this and m433 depends on it: the owner's ruling says platform
-- staff "can READ tenant financials". can_read_tenant_financials() therefore
-- belongs in SELECT clauses and in nothing else. A support operator gets the
-- ledger, not a pen. This is asserted schema-wide, not per table.

do $$
declare
  offenders text := '';
  n         int  := 0;
  r         record;
begin
  for r in
    select p.tablename, p.policyname, p.cmd
    from   pg_policies p
    where  p.schemaname = 'public'
      and  p.cmd in ('INSERT', 'UPDATE', 'DELETE')
      and  coalesce(p.qual, '') || ' ' || coalesce(p.with_check, '')
             ~ 'can_read_tenant_financials'
    order by p.tablename, p.policyname
  loop
    n := n + 1;
    offenders := offenders || format('%s  [%s %s]%s', r.tablename, r.cmd, r.policyname, chr(10));
  end loop;

  if n > 0 then
    raise exception
      'm434: can_read_tenant_financials() appears in % write clause(s). It is a READ roster by intent — the owner authorised superadmin/admin/support to READ tenant financials, not to write them. Use is_platform_admin() if a platform write is genuinely wanted.%s%s',
      n, chr(10), offenders;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 6 — THE POLICY-LESS COMMISSION LEDGER IS STILL FAIL-CLOSED
-- ─────────────────────────────────────────────────────────────────────────────
--
-- public.affiliate_commission_events has ZERO RLS policies, on purpose: its only
-- readers are service-role, so the correct posture is "nobody with a session key
-- may read it". That posture is expressed ENTIRELY by the RLS flag — `anon` and
-- `authenticated` both hold table-level SELECT on it (as they do across this
-- schema), so the moment RLS is disabled the table is readable by anyone holding
-- the publishable key. A table with no policies is not a table nobody guards; it
-- is a table whose only guard is one boolean.

do $$
declare
  rls    boolean;
  forced boolean;
  npol   int;
begin
  select c.relrowsecurity, c.relforcerowsecurity into rls, forced
  from   pg_class c join pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public' and c.relname = 'affiliate_commission_events';

  if rls is null then
    raise exception 'm434: public.affiliate_commission_events is missing.';
  end if;

  select count(*) into npol
  from pg_policies where schemaname = 'public' and tablename = 'affiliate_commission_events';

  if not rls then
    raise exception
      'm434: RLS is DISABLED on affiliate_commission_events and it has % policies. anon holds SELECT on this table, so every affiliate''s commission_cents, mrr_cents and brokerage_id is readable by anyone with the publishable key. Re-enable it; do not "fix" this by adding a permissive policy.', npol;
  end if;

  if npol > 0 and not forced then
    -- A policy appearing here is not automatically wrong, but it is a change of
    -- posture from "service-role only" to "somebody may read this with a session
    -- key", and that decision belongs to a human who has read the ruling.
    raise warning
      'm434: affiliate_commission_events now has % policy/policies where it previously had none. Confirm the readers are meant to be session-key readers, and that the predicate names a role.', npol;
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 7 — A VENDOR IS RESOLVED ONE WAY
-- ─────────────────────────────────────────────────────────────────────────────
--
-- "but only their own" is the half of the ruling that is easiest to lose: lock
-- the vendor tables to the brokerage's book roles and a vendor silently stops
-- seeing their own payout. is_current_user_vendor() is what keeps it, and it must
-- resolve through user_role_assignments.vendor_id — the linkage
-- app/vendor/invoices/page.tsx calls "Canonical vendor linkage" and the one
-- public.vendor_has_transaction_access() and the vendor_tax_documents policies
-- already use. A second way to answer "which vendor is this user" is the same
-- disease m427 removed when it stopped deriving an office at read time.

do $$
declare body text;
begin
  select pg_get_functiondef(p.oid) into body
  from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where  n.nspname = 'public' and p.proname = 'is_current_user_vendor' limit 1;

  if body !~ 'user_role_assignments' then
    raise exception
      'm434: is_current_user_vendor() no longer resolves through user_role_assignments.vendor_id. That is the canonical user→vendor linkage in this codebase (app/vendor/invoices/page.tsx says so verbatim; vendor_has_transaction_access() and the vendor_tax_documents policies use it). A second linkage means two answers to "is this my invoice", and the vendor tables would disagree with the vendor portal.';
  end if;

  if body !~ 'auth\.uid\(\)' then
    raise exception
      'm434: is_current_user_vendor() does not resolve the caller from the session (auth.uid()). Never derive identity from a caller-supplied id — resolve from the session, then authorise the id against it.';
  end if;
end $$;

do $$
begin
  raise notice 'm434: all claims hold — the tier helpers exist and are positive rosters, no money table reaches its tenant without a role test, no money policy publishes an unstamped row, the platform financial roster holds no pen, the policy-less affiliate ledger is still fail-closed, and a vendor is resolved one way.';
end $$;
