-- m446 — THE DEAL TABLE: a read that was missing, a write that had no role, and
--        a write that had no tenant.
--
-- Found by MEASURING the outcome of m440 rather than by reading a policy: the
-- rolled-back fixture that proved the team board reported, as a side effect, that
-- a BROKER read 0 of 3 transactions in their own brokerage. That was not the
-- thing under test, and it is the most broken thing on the table.
--
-- Everything below was then proved live, in a transaction ended by a `raise`,
-- BEFORE a line of this was written.
--
-- ═════════════════════════════════════════════════════════════════════════════
-- A. NOBODY WHO RUNS THE BROKERAGE COULD SEE ITS DEALS
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The live SELECT policies on `transactions` were exactly four:
--
--   agent_read_own_transactions         agent, own rows
--   platform_admin_view_transactions    is_platform_admin()
--   team_leader_read_team_transactions  the team lead (m440/m444)
--   transactions_vendor_scoped_read     a vendor, scoped to their deal
--
-- There is no broker clause, no admin clause, no tc clause and no compliance
-- clause. A broker, an office admin, a transaction coordinator and a compliance
-- officer each read ZERO of their own brokerage's deals.
--
-- `supabase/rls-governance/004-transactions-policies.sql` DECLARES all four of
-- them, in words and in CREATE POLICY blocks — "TCs have full access to
-- transactions in their brokerage", "Compliance managers have read-only access".
-- That file has never run against this database: it depends on the `auth.*`
-- helper family, which was never installed (m440 established this). So the
-- capability was declared, believed, and absent.
--
-- IT FAILS CLOSED, so it is a dead screen and not a leak — but `transactions` is
-- read by a session client from dozens of surfaces (app/crm/page.tsx,
-- app/transactions/[transactionId], app/actions/multi-persona.ts,
-- ai-financial-management, briefing-actions, analytics …), so RLS is the real
-- gate and the brokerage's whole deal pipeline was empty for the people who run
-- it.
--
-- THE ROSTER. `is_tenant_staff()` is the obvious helper and is WRONG here: it
-- includes 'agent', which would hand every agent the entire brokerage's deal book
-- — wider than today and against the grain of every ruling in this workstream.
-- The roster that matches 004's declared intent, exactly, is the books roster
-- plus the coordinator:
--
--   can_read_brokerage_books()   admin, broker, broker_owner, broker_admin,
--                                compliance_officer
--   is_tc_role()                 tc (+ the legacy spellings it folds)
--
-- Composed from two existing helpers rather than minted as a third near-duplicate
-- roster, because a new roster helper is exactly the drift that produced four
-- vocabularies for one question. The name says "books" and this is an operational
-- table; the SET is what is being reused, and it is the right set.
--
-- Agents are untouched — they keep `agent_read_own_transactions` and see their
-- own deals only. Contacts, lenders and unassigned vendors gain nothing.

create policy transactions_brokerage_staff_read
  on public.transactions for select to authenticated
  using (
    public.has_brokerage_access(brokerage_id)
    and (public.can_read_brokerage_books() or public.is_tc_role())
  );

-- ═════════════════════════════════════════════════════════════════════════════
-- B. A CONTACT COULD CREATE A DEAL
-- ═════════════════════════════════════════════════════════════════════════════
--
--   users_insert_transactions   INSERT   TO PUBLIC
--     WITH CHECK  brokerage_id = (select brokerage_id from users where id = auth.uid())
--
-- A bare tenant test with NO ROLE TEST — the exact class m438 and m439 removed
-- from the money tables, still live on the deal table. `users.brokerage_id` is
-- stamped on a contact, a lender and a vendor exactly as on a broker's, so every
-- portal account satisfied it.
--
-- PROVED, not inferred: seller@vip.demo, `user_type = 'contact'`, inserted a
-- transaction into VIP Premier — 1 row created — inside a rolled-back fixture.
--
-- Repaired rather than dropped, because the CAPABILITY is real: brokerage staff
-- do open deals, and `agent_insert_own_transactions` only covers an agent putting
-- themselves on one. This gets the same roster as the read, so the people who can
-- see the pipeline are the people who can add to it. Agents are unaffected —
-- their own narrower policy still stands beside this one.

do $$
begin
  alter policy users_insert_transactions on public.transactions
    with check (
      public.has_brokerage_access(brokerage_id)
      and (public.can_read_brokerage_books() or public.is_tc_role())
    );
  alter policy users_insert_transactions on public.transactions to authenticated;
  raise notice 'm446: users_insert_transactions now requires a ROLE as well as a tenant. A contact, a lender and a vendor can no longer open a deal.';
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- C. AN AGENT COULD MOVE A DEAL INTO ANOTHER BROKERAGE
-- ═════════════════════════════════════════════════════════════════════════════
--
--   agent_update_own_transactions   UPDATE   USING (agent, and I am on the deal)
--                                            WITH CHECK  — ABSENT
--
-- When WITH CHECK is absent Postgres reuses USING for it, so the row the UPDATE
-- PRODUCES is checked against "am I an agent on this deal". That predicate
-- contains NO BROKERAGE TERM AT ALL — so an agent could set `brokerage_id` to any
-- brokerage on the platform and the check still passed, because they were still
-- the agent on it.
--
-- PROVED, not inferred: agent@vip.demo moved transaction f0000000-…-0001 into
-- Your Brokerage — 1 row updated — inside a rolled-back fixture.
--
-- This is USING vs WITH CHECK exactly: USING decides which rows you may ACT ON,
-- WITH CHECK decides what a row may BECOME. An unscoped WITH CHECK lets a row be
-- MOVED across tenants, which is worse than reading one — the deal leaves the
-- brokerage's book entirely, taking its commission with it.
--
-- The USING is preserved as-is in meaning and modernised in form: the inlined
-- `(select user_type from users where id = auth.uid()) = 'agent'` becomes
-- is_agent_role() (identical set), and the three repeated `(select agents.id …)`
-- subselects become one current_user_agent_id() call. Same rule, one definition,
-- four subselects fewer per row.

do $$
declare
  own_expr constant text :=
    'public.is_agent_role()
     and (   agent_id        = public.current_user_agent_id()
          or seller_agent_id = public.current_user_agent_id()
          or buyer_agent_id  = public.current_user_agent_id())';
begin
  execute format(
    'alter policy agent_update_own_transactions on public.transactions
       using (%s) with check (public.has_brokerage_access(brokerage_id) and %s)',
    own_expr, own_expr);
  alter policy agent_update_own_transactions on public.transactions to authenticated;

  raise notice 'm446: agent_update_own_transactions now carries an explicit WITH CHECK with a tenant anchor. A deal can no longer be moved out of the brokerage that owns it.';
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- D. OFF `public`
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The remaining policies are granted TO PUBLIC, so they are evaluated for `anon`
-- too. Harmless today only because each bottoms out in a helper that reads
-- `users WHERE id = auth.uid()` and auth.uid() is NULL for anon — i.e. the deal
-- table's safety rests on the internals of those functions rather than on the
-- grant. Same narrowing m431 §C made on commission_splits, for the same reason.
-- Only policies on this table are touched.

do $$
declare pol record; n int := 0;
begin
  for pol in
    select policyname from pg_policies
    where schemaname='public' and tablename='transactions' and roles = '{public}'
  loop
    execute format('alter policy %I on public.transactions to authenticated', pol.policyname);
    n := n + 1;
  end loop;
  raise notice 'm446: % policy/policies on transactions moved off PUBLIC to authenticated.', n;
end $$;
