-- m435 — "platform needs to see all tenants and their users."
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHAT WAS ACTUALLY TRUE BEFORE THIS FILE (measured on the live database, not
-- assumed — a rolled-back fixture that borrowed one user's platform_role)
-- ─────────────────────────────────────────────────────────────────────────────
--
--   principal                       users visible   brokerages visible
--   ─────────────────────────────   ─────────────   ──────────────────
--   platform support                            5                   1
--   platform marketing                          5                   1
--   ordinary tenant agent                       5                   1
--   superadmin                                 18                   2
--
-- Two brokerages and 23 users exist. Read that table again: a platform
-- `support` operator was indistinguishable from an ordinary agent at the
-- same brokerage, and even the SUPERADMIN — the one principal the old policies
-- did name — could not see a single user outside its own tenant.
--
-- The two causes were different, and both are fixed here:
--
--   brokerages_select was `is_platform_admin() OR id = current_user_brokerage_id()`.
--   `is_platform_admin()` is superadmin ONLY. Owner ruling #169 defines platform
--   staff as FOUR roles — superadmin, admin, support, marketing — so three
--   quarters of the roster fell through to the tenant branch and saw one row.
--
--   users had NO platform clause at all. `users_same_brokerage_select` was
--   `(id = auth.uid()) OR (brokerage_id = current_user_brokerage_id())` and that
--   is the whole of it. "and their users" was never implemented, for anybody,
--   including the superadmin.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE HELPER CHOICE, STATED SO IT CAN BE OVERRULED IN ONE LINE
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Three helpers could carry "platform" here and picking wrong either
-- under-delivers the ruling or over-grants:
--
--   is_platform_admin()          superadmin only.                    TOO NARROW.
--   is_platform_staff()          superadmin, admin, marketing, support.  CHOSEN.
--   can_read_tenant_financials() is_platform_staff() minus marketing.
--
-- `is_platform_staff()` is chosen for BOTH tables, on four grounds:
--
--   1. THE ROSTER IS THE RULING. #169 says platform staff are those four roles.
--      `can_read_tenant_financials()` exists (m427) because a LATER, NARROWER
--      ruling carved marketing out of FINANCIALS specifically. A brokerage row
--      and a users row are not financials. Reaching for the financial helper
--      here would silently import a carve-out the owner scoped to money.
--
--   2. THE APP ALREADY DECIDED, IN CODE, THE SAME WAY. The platform capability
--      map (lib/platform/platform-staff-roster.ts) grants `tenants` to all four
--      roles — `marketing: ["marketing", "tenants"]` is explicit. Both
--      /dashboard/superadmin/brokerages and /brokerages/[id] gate on
--      requirePlatformCapability("tenants"), and searchUsersByEmailAction —
--      cross-tenant user lookup returning email, name, role and tenant — is
--      gated on that same capability. Putting the DATABASE narrower than the
--      capability the product already grants would create a second, contrary
--      answer to one question, which is the defect this workstream keeps
--      closing.
--
--   3. IT IS THE ESTABLISHED SHAPE. m408 and m421 already write platform-wide
--      clauses as `is_platform_staff() or brokerage_id = current_user_brokerage_id()`.
--      This is that shape, on the two tables that define what a tenant IS.
--
--   4. THE PII OBJECTION IS REAL AND LANDS SOMEWHERE ELSE. `users` rows carry
--      email, phone and names. But every surface that renders them today reads
--      through createServiceClient(), which BYPASSES RLS — so this policy is not
--      what is holding marketing back from tenant PII, and tightening it here
--      would buy no confidentiality while making the database disagree with the
--      app. What bounds PII is the surface and the column list. Said plainly so
--      it is not mistaken for a claim of safety.
--
-- TO OVERRULE: if the owner wants marketing out of tenant PII, it is one line —
--   alter policy users_same_brokerage_select on public.users
--     using (public.can_read_tenant_financials() or id = auth.uid()
--            or brokerage_id = public.current_user_brokerage_id());
-- and the m436 assertion still passes, because m436 pins that a platform clause
-- EXISTS by helper name, not which of the platform helpers it is.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- READ ONLY. THE PLATFORM CLAUSE IS NOT ADDED TO ANY WRITE POLICY
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The ruling is "needs to SEE". brokerages_insert/update/delete keep
-- `is_platform_admin()` (superadmin only) untouched, and users_insert/update keep
-- `id = auth.uid()` untouched. A platform `support` operator gains the ability to
-- READ every tenant and every tenant's users, and gains nothing else. Widening a
-- USING clause on SELECT cannot disarm a write here (recurring defect (e)),
-- because the write policies on both tables carry their own USING and neither
-- was narrowed.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE RECURSION TRAP, CHECKED RATHER THAN ASSUMED
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A `users` policy that calls a helper which SELECTs FROM public.users is the
-- classic infinite-recursion footgun, and it fails at QUERY time, not at
-- migration time — so a migration that applies cleanly proves nothing.
--
-- What makes it safe is measured on this database:
--   · public.users is owned by `postgres` and relforcerowsecurity = FALSE.
--   · public.is_platform_staff() is SECURITY DEFINER owned by `postgres`.
-- A table owner is exempt from its own RLS unless FORCE ROW LEVEL SECURITY is
-- set, so the helper's inner `select … from public.users` runs as the owner and
-- never re-enters the policy. This is the identical mechanism that already lets
-- `current_user_brokerage_id()` sit inside this very policy today.
--
-- `is_platform_staff()` additionally carries `SET search_path = public, pg_temp`
-- (m408), which `current_user_brokerage_id()` does not. That pin is not what
-- prevents recursion — ownership is — but it is the stronger shape, and it is
-- the shape to copy if a new helper is ever added here.
--
-- No new helper is defined by this migration. Nothing to match.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- THE SECOND SELECT POLICY ON `users` IS DROPPED, AND IT IS PROVABLY A NO-OP
-- ─────────────────────────────────────────────────────────────────────────────
--
-- `users` carried TWO permissive SELECT policies, both TO PUBLIC:
--     "Users can view own data"      USING (id = auth.uid())
--     users_same_brokerage_select    USING (id = auth.uid() OR brokerage_id = …)
-- Permissive policies OR together, and the first is a literal disjunct of the
-- second: A OR (A OR B) ≡ A OR B. Identical cmd, identical permissiveness,
-- identical grantee — so dropping it removes no row from any principal. Two
-- rules answering one question is how the two drift apart; one rule cannot.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- TO authenticated — m417/m418 swept the SELECT-true class and missed these
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Every policy on both tables was granted TO PUBLIC, which includes `anon` — the
-- key shipped inside the browser bundle — and `anon` holds Supabase's default
-- table GRANT on both. Narrowing to `authenticated` removes exactly zero rows
-- from anyone, and that is checkable rather than hopeful: for `anon`,
-- auth.uid() is NULL so `id = auth.uid()` is NULL (never true), the helpers all
-- COALESCE to false, and `id = current_user_brokerage_id()` is NULL = NULL.
-- Every predicate on both tables already evaluated to not-true for anon. What
-- changes is that it now says so structurally instead of arithmetically.
--
-- service_role is unaffected: it carries rolbypassrls, so every
-- createServiceClient() reader — which is how the god console actually loads
-- these two tables — bypasses RLS entirely and is untouched by this file.

-- ─────────────────────────────────────────────────────────────────────────────
-- brokerages — the platform sees every tenant
-- ─────────────────────────────────────────────────────────────────────────────

alter policy brokerages_select on public.brokerages
  to authenticated
  using (
    public.is_platform_staff()
    or id = public.current_user_brokerage_id()
  );

-- Writes unchanged in substance; grantee narrowed only.
alter policy brokerages_insert on public.brokerages to authenticated;
alter policy brokerages_update on public.brokerages to authenticated;
alter policy brokerages_delete on public.brokerages to authenticated;

-- ─────────────────────────────────────────────────────────────────────────────
-- users — the platform sees every tenant's users
-- ─────────────────────────────────────────────────────────────────────────────

-- Subsumed by users_same_brokerage_select's own `id = auth.uid()` disjunct.
drop policy if exists "Users can view own data" on public.users;

alter policy users_same_brokerage_select on public.users
  to authenticated
  using (
    public.is_platform_staff()
    or id = auth.uid()
    or brokerage_id = public.current_user_brokerage_id()
  );

-- Writes unchanged in substance; grantee narrowed only. A platform operator
-- gains READ across tenants and no write anywhere.
alter policy "Users can insert own row" on public.users to authenticated;
alter policy "Users can update own row" on public.users to authenticated;

do $$
declare
  n_public int;
begin
  select count(*) into n_public
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace ns on ns.oid = c.relnamespace
  where  ns.nspname = 'public' and c.relname in ('users','brokerages')
    and  0 = any(p.polroles);

  raise notice
    'm435: platform clause is public.is_platform_staff() on users and brokerages (SELECT only); % polic(ies) on the two tables still granted to PUBLIC.',
    n_public;
end $$;
