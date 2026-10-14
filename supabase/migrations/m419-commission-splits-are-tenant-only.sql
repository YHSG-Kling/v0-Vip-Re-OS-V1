-- m419 — "commission should be tenant only" (owner ruling).
--
-- ── WHAT WAS WRONG, AND IT WAS TWO THINGS ────────────────────────────────────
--
-- `commission_splits` had the tenant predicate on HALF its policies:
--
--   SELECT  is_platform_admin() OR (is_agent_role() AND agent_id = current_user_agent_id())
--                               OR has_brokerage_access(brokerage_id)        ✅
--   DELETE  is_platform_admin() OR (is_brokerage_admin() AND has_brokerage_access(brokerage_id))  ✅
--   INSERT  WITH CHECK (is_platform_admin() OR is_brokerage_admin())          ❌ no tenant at all
--   UPDATE  USING      (… has_brokerage_access(brokerage_id))                 ✅
--           WITH CHECK (is_platform_admin() OR is_brokerage_admin())          ❌ no tenant at all
--
-- The INSERT hole was reported earlier: any brokerage admin — `user_type` in
-- ('admin','broker','broker_owner') at ANY tenant — could write a commission
-- split for ANY brokerage, or with `brokerage_id` NULL, which is worse: a NULL
-- row is invisible to every `has_brokerage_access` reader, so it lands in the
-- ledger and shows up in nobody's books.
--
-- The UPDATE hole was NOT reported and is the same defect one step later. A
-- policy's USING clause decides which rows you may act on; the WITH CHECK
-- decides what the row is allowed to look like AFTER the write. With USING
-- scoped and WITH CHECK unscoped, a brokerage admin could take a split they
-- legitimately own and MOVE it — rewrite `brokerage_id` to another tenant, or to
-- NULL — and the row would leave their books and land in someone else's. Money
-- moving across a tenant boundary by UPDATE is the same leak as by INSERT.
--
-- ── THE FIX IS THE HELPER THIS TABLE ALREADY USES ────────────────────────────
--
--   has_brokerage_access(x) := is_platform_admin()
--                              OR (x IS NOT NULL AND x = current_user_brokerage_id())
--
-- It already backs this table's SELECT and DELETE, so applying it to the two
-- write-side checks makes all four policies agree rather than introducing a new
-- rule. Note it rejects NULL EXPLICITLY — which is exactly what "tenant only"
-- means for money, and is why no separate NOT NULL constraint is needed to close
-- the untenanted-row case.
--
-- ── WHY THIS BREAKS NO WRITER ────────────────────────────────────────────────
--
-- Both in-repo writers were read before this was written and both already stamp
-- the tenant, so neither starts failing:
--   app/actions/agents.ts:627        brokerage_id: agentRow.brokerage_id
--   lib/kernel/financial.ts:1167     brokerage_id: ctx.brokerageId
-- The other four call sites are status UPDATEs keyed on commission_id
-- (financial.ts:717/791/909/969) which do not touch brokerage_id, so they
-- continue to satisfy the new WITH CHECK on the row's existing value.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────
--
-- It does not attempt to model a MULTI-LOCATION brokerage. The owner has asked
-- for advice on that separately and it is not settled. Stated plainly so the
-- next reader is not misled: today a "multi-location" brokerage is a SINGLE
-- `brokerages` row whose `plan_tier` is 'multi_location' — there is no
-- parent/child column on `brokerages` and no offices table, so every location
-- under one plan shares one `brokerage_id` and this policy already lets its
-- admin see all of it. If locations are ever split into separate `brokerages`
-- rows, `has_brokerage_access()` is the ONE function that would need to learn
-- the relationship, and every policy here inherits the answer for free. That is
-- the reason to route this through the helper rather than inline the equality.

do $$
begin
  alter policy commission_splits_insert on public.commission_splits
    with check (
      is_platform_admin()
      or (is_brokerage_admin() and has_brokerage_access(brokerage_id))
    );

  alter policy commission_splits_update on public.commission_splits
    using (
      is_platform_admin()
      or (is_brokerage_admin() and has_brokerage_access(brokerage_id))
    )
    with check (
      is_platform_admin()
      or (is_brokerage_admin() and has_brokerage_access(brokerage_id))
    );

  raise notice 'm419: commission_splits INSERT and UPDATE write-side checks now carry the tenant predicate, matching SELECT and DELETE.';
end $$;
