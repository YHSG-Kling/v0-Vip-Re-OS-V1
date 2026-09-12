-- m437 — close a hole m433 opened, found by verifying its own outcome.
--
-- m433 rewrote 45 money tables through a driven loop. For a FOR ALL policy it set
-- `using (sel_expr)` and `with check (wri_expr)`, which is right for SELECT and
-- for INSERT/UPDATE — but WRONG for DELETE. On a FOR ALL policy, USING alone
-- governs DELETE row-visibility; there is no WITH CHECK to stop it. So the read
-- expression, which contains can_read_tenant_financials(), became a DELETE grant
-- on the four money tables whose policy is FOR ALL rather than four per-command
-- policies:
--
--   business_expenses.business_expenses_tenant
--   tier_budgets.brok_tier_budgets
--   tier_distributions.brok_tier_distributions
--   transaction_cost_breakdown.brok_transaction_cost_breakdown
--
-- That contradicts the rule m427 established and m428 asserts schema-wide: the
-- owner ruled admin/superadmin/support may READ tenant financials, and nothing in
-- that sentence lets a support operator delete a brokerage's expense ledger.
--
-- HOW IT WAS FOUND, because the method matters more than the fix: not by reading
-- the migration, but by querying the live catalogue AFTER applying it and asking
-- whether the read-only helper had landed on any write clause. It had. A
-- migration that applies cleanly has proved only that it is valid SQL.
--
-- FIXED WITH RESTRICTIVE POLICIES rather than by rewriting the four permissive
-- ones. A RESTRICTIVE policy ANDs with the permissive set, so this can only ever
-- subtract — it cannot widen anything by accident. The alternative, splitting
-- each FOR ALL into per-command policies, means DROP and CREATE, which changes
-- policy names that guards and later migrations pin by name. Subtracting is the
-- smaller and safer edit.
--
-- The predicate is the same write roster m433 gave these tables' WITH CHECK, so a
-- caller who may legitimately INSERT or UPDATE may still DELETE. Only the
-- read-only platform tier loses the delete it briefly had.
--
-- m434 claim 4 is written to match: it allows the read helper on a FOR ALL USING
-- ONLY where a restrictive DELETE policy exists on that table, and fails on any
-- per-command write clause naming it. That is the CONSTRUCT — after this
-- migration a purely textual test would be a false positive, and this workstream
-- asserts constructs rather than spellings.

create policy business_expenses_delete_needs_write_role
  on public.business_expenses as restrictive for delete to authenticated
  using (public.is_platform_admin()
         or (public.has_brokerage_access(brokerage_id) and public.is_tenant_staff()));

create policy tier_budgets_delete_needs_write_role
  on public.tier_budgets as restrictive for delete to authenticated
  using (public.is_platform_admin()
         or (public.has_brokerage_access(brokerage_id) and public.is_tenant_staff()));

create policy tier_distributions_delete_needs_write_role
  on public.tier_distributions as restrictive for delete to authenticated
  using (public.is_platform_admin()
         or (public.has_brokerage_access(brokerage_id) and public.is_brokerage_admin()));

create policy transaction_cost_breakdown_delete_needs_write_role
  on public.transaction_cost_breakdown as restrictive for delete to authenticated
  using (public.is_platform_admin()
         or (public.has_brokerage_access(brokerage_id) and public.is_tenant_staff()));

do $$
declare n int;
begin
  select count(*) into n from pg_policy p
  join pg_class c on c.oid = p.polrelid
  join pg_namespace ns on ns.oid = c.relnamespace
  where ns.nspname = 'public' and not p.polpermissive and p.polcmd = 'd'
    and c.relname in ('business_expenses','tier_budgets','tier_distributions','transaction_cost_breakdown');
  if n <> 4 then
    raise exception 'm437: expected 4 restrictive DELETE guards, found %.', n;
  end if;
  raise notice 'm437: the read-only platform tier can no longer DELETE through a FOR ALL USING clause on the four money tables whose policy is FOR ALL.';
end $$;
