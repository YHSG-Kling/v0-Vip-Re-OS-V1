-- m447 — asserts m446. Separate file: a `raise` rolls back its own transaction.
--
-- Hard claims are scoped to `transactions`, and the two schema-wide censuses are
-- WARNINGS with their numbers named. Measured before writing, which is why:
--
--   · 10 UPDATE policies schema-wide carry a USING and NO WITH CHECK, across 9
--     tables. SIX of those have no tenant term in the USING at all — so on six
--     more tables a row can still be MOVED into another brokerage, exactly as a
--     deal could before m446. Small enough to name; too consequential to sweep
--     without tracing each table's screens.
--   · 195 INSERT policies reach a tenant with no role or ownership test, on 195
--     tables. That is the true size of the class #180 tracks as "72" — the
--     tracked number is wrong and this prints the real one.
--
-- A schema-wide hard claim on either would go red the day it applied, on someone
-- else's table, which is how a guard gets commented out.

-- ── CLAIM 1 — THE BROKERAGE CAN SEE ITS OWN DEALS (HARD) ────────────────────
-- Assert the CAPABILITY, not just the absence of a defect: claims 2-4 all pass
-- happily if someone deletes this policy, and the brokerage would be blind again.
do $$
declare pred text;
begin
  select coalesce(qual,'') into pred from pg_policies
   where schemaname='public' and tablename='transactions'
     and policyname='transactions_brokerage_staff_read';

  if pred is null or pred = '' then
    raise exception 'm447: transactions_brokerage_staff_read is gone. Before m446 a broker, an office admin, a tc and a compliance officer each read ZERO of their own brokerage''s deals, while rls-governance/004 declared all four capabilities in a file that has never run. Deleting this returns the deal pipeline to empty for the people who run the brokerage.';
  end if;
  if pred !~ '(has_brokerage_access|current_user_brokerage_id)' then
    raise exception 'm447: transactions_brokerage_staff_read lost its tenant anchor — that would hand the roster EVERY brokerage''s deals. Predicate: %', pred;
  end if;
  if pred !~ '(can_read_brokerage_books|is_tc_role|is_brokerage_admin)' then
    raise exception 'm447: transactions_brokerage_staff_read lost its positive role roster. A tenant test alone admits contacts, lenders and vendors, who all carry a brokerage_id. Predicate: %', pred;
  end if;
  if pred ~ 'is_tenant_staff' then
    raise exception 'm447: transactions_brokerage_staff_read uses is_tenant_staff(), which INCLUDES ''agent''. That hands every agent the entire brokerage''s deal book; agents keep their own narrower policy instead.';
  end if;
end $$;

-- ── CLAIM 2 — EVERY WRITE ON A DEAL CARRIES A ROLE **AND** A TENANT (HARD) ──
-- Proved live before m446: seller@vip.demo (a CONTACT) inserted a transaction,
-- because users_insert_transactions was a bare tenant test TO PUBLIC with no role
-- test at all.
do $$
declare r record; n int := 0; offenders text := '';
begin
  for r in
    select policyname, cmd, coalesce(with_check, qual, '') as pred
    from pg_policies
    where schemaname='public' and tablename='transactions'
      and cmd in ('INSERT','UPDATE','DELETE','ALL') and 'service_role' <> all(roles)
  loop
    if r.pred !~ '(user_type|is_agent_role|is_tc_role|can_read_brokerage_books|is_brokerage_admin|is_platform|current_user_agent_id|auth\.uid)' then
      n := n + 1;
      offenders := offenders || format('  %s [%s] has NO role/ownership test: %s', r.policyname, r.cmd, r.pred) || chr(10);
    end if;
    if r.pred !~ '(has_brokerage_access|current_user_brokerage_id|brokerage_id)' then
      n := n + 1;
      offenders := offenders || format('  %s [%s] has NO tenant anchor: %s', r.policyname, r.cmd, r.pred) || chr(10);
    end if;
  end loop;

  if n > 0 then
    raise exception
      'm447: % write defect(s) on transactions. users.brokerage_id is stamped on a contact, a lender and a vendor exactly as on a broker''s, so a bare tenant test lets the client portal OPEN A DEAL — measured live before m446. And a write with no tenant anchor lets a deal be moved out of the brokerage that owns it.%',
      n, chr(10) || offenders;
  end if;
end $$;

-- ── CLAIM 3 — NO UPDATE ON A DEAL WITHOUT AN EXPLICIT WITH CHECK (HARD) ─────
-- The construct, stated exactly: when WITH CHECK is absent Postgres reuses USING
-- for it. USING answers "which rows may I act on"; it does NOT answer "what may
-- this row BECOME". agent_update_own_transactions' USING contained no brokerage
-- term, so an agent could set brokerage_id to any brokerage on the platform and
-- still pass, because they were still the agent on the deal. Measured: 1 row
-- moved into another brokerage. After m446 the same attempt is REFUSED outright.
do $$
declare r record; n int := 0; offenders text := ''; n_wide int; t_wide int;
begin
  for r in
    select policyname from pg_policies
    where schemaname='public' and tablename='transactions'
      and cmd='UPDATE' and with_check is null and 'service_role' <> all(roles)
  loop
    n := n + 1;
    offenders := offenders || format('  %s', r.policyname) || chr(10);
  end loop;

  if n > 0 then
    raise exception
      'm447: % UPDATE polic(ies) on transactions have no explicit WITH CHECK. Postgres then reuses USING, which decides which rows you may ACT ON and never what a row may BECOME — so the deal can be moved into another brokerage, taking its commission with it. State the WITH CHECK, and put the tenant in it.%',
      n, chr(10) || offenders;
  end if;

  select count(*), count(distinct tablename) into n_wide, t_wide
  from pg_policies
  where schemaname='public' and cmd='UPDATE' and with_check is null and 'service_role' <> all(roles)
    and coalesce(qual,'') !~ '(brokerage_id|tenant_id|organization_id|has_brokerage_access|current_user_brokerage_id)';

  if n_wide > 0 then
    raise warning
      'm447: transactions is clean, but % UPDATE polic(ies) across % other table(s) still have NO WITH CHECK and no tenant term in their USING — so on each of those a row can be MOVED into another tenant, the same defect m446 just closed on the deal table. Reported with its number so a green run here is not read as "the class is gone".',
      n_wide, t_wide;
  end if;
end $$;

-- ── CLAIM 4 — NOTHING ON THE DEAL TABLE IS EVALUATED FOR anon (HARD) ────────
do $$
declare n int;
begin
  select count(*) into n from pg_policies
  where schemaname='public' and tablename='transactions' and roles = '{public}';
  if n > 0 then
    raise exception 'm447: % polic(ies) on transactions are granted TO PUBLIC, so they are evaluated for anon. The table''s safety must not rest on auth.uid() happening to be NULL inside a helper.', n;
  end if;
end $$;

-- ── CLAIM 5 — THE INSERT CENSUS, WITH THE REAL NUMBER (WARNING) ─────────────
do $$
declare n int; t int;
begin
  select count(*), count(distinct tablename) into n, t
  from pg_policies
  where schemaname='public' and cmd='INSERT' and 'service_role' <> all(roles)
    and coalesce(with_check,'') ~ '(brokerage_id|current_user_brokerage_id|has_brokerage_access)'
    and coalesce(with_check,'') !~ '(user_type|is_.*_role|can_read_|is_tenant_staff|is_brokerage_admin|is_platform|auth\.uid|current_user_agent_id|user_id)';
  if n > 0 then
    raise warning
      'm447: % INSERT polic(ies) across % table(s) reach a tenant with NO role or ownership test — any authenticated user of a brokerage, including a contact, a lender and a vendor, may create the row. This is the class tracked as #180, whose recorded size of "72" is wrong: the measured number is %. m446 closed it on transactions only.',
      n, t, n;
  end if;
end $$;

do $$
begin
  raise notice 'm447: all hard claims hold — the brokerage can read its own deals through a positive roster with a tenant anchor, every write on a deal carries both a role and a tenant, no UPDATE relies on USING to decide what a row may become, and nothing on the table is evaluated for anon.';
end $$;
