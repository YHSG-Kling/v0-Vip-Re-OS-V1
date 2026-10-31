-- m436 — asserts m435.
--
-- Separate file because a `raise` rolls back its own transaction: asserting
-- inside m435 would undo the policy rewrites it was checking. Same split as
-- m393/m395/m397/m399/m403/m405/m407/m409/m412/m414/m416/m418/m420/m422/m424/
-- m426/m428/m430.
--
-- Every claim below pins a CONSTRUCT — the PRESENCE of a named helper whose
-- whole purpose is to be the single place a rule lives, a grantee, the side of
-- the read/write line a clause sits on, and the ownership property that keeps a
-- self-referencing policy from recursing. None pins a predicate's text, a
-- disjunct order, or a policy name, because guards that pin spellings go red on
-- strictly better code — that has happened four times in this workstream.

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 1 — BOTH TABLES CARRY A PLATFORM CLAUSE, AND "PLATFORM" MEANS THE ROSTER
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Owner ruling: "platform needs to see all tenants and their users." `brokerages`
-- IS the tenant list and `users` IS its users, so the SELECT policy on each must
-- name a helper that answers for platform staff.
--
-- WHICH helpers count, and why the list is exactly two:
--
--   public.is_platform_staff()            superadmin, admin, marketing, support
--   public.can_read_tenant_financials()   the same minus marketing
--
-- Both answer for the ROSTER (ruling #169), so either satisfies the ruling and
-- the owner can move between them with one `alter policy` without turning this
-- guard red. That freedom is deliberate: m435 chose is_platform_staff() and said
-- why at length, and a cheap overrule is worth more than a pinned answer.
--
-- `public.is_platform_admin()` deliberately does NOT count. It is
-- `platform_role = 'superadmin'` — ONE role — and accepting it as "the platform"
-- is precisely the defect m435 repaired: a platform `support` operator was
-- measured, live, seeing 1 brokerage and 5 users, indistinguishable from an
-- ordinary agent at the same tenant. A revert to the superadmin-only helper must
-- fail here, so this claim would go red on the pre-m435 brokerages policy too.
--
-- Nothing here requires ONE policy or ONE disjunct. Permissive policies OR, so
-- the clause may live in any permissive SELECT policy on the table, spelled any
-- way, in any order.

do $$
declare
  tbl        text;
  hit        boolean;
  offenders  text[] := '{}';
begin
  foreach tbl in array array['users','brokerages'] loop
    select exists (
      select 1
      from   pg_policy p
      join   pg_class     c  on c.oid  = p.polrelid
      join   pg_namespace ns on ns.oid = c.relnamespace
      where  ns.nspname = 'public' and c.relname = tbl
        and  p.polpermissive
        and  p.polcmd in ('r','*')                       -- FOR SELECT, or FOR ALL
        and  pg_get_expr(p.polqual, p.polrelid) ~
             '(is_platform_staff|can_read_tenant_financials)\s*\('
    ) into hit;
    if not hit then offenders := offenders || tbl; end if;
  end loop;

  if array_length(offenders, 1) is not null then
    raise exception
      'm436(1): no roster-level platform clause on the SELECT side of public.%. Owner ruling: "platform needs to see all tenants and their users" — `brokerages` IS the tenant list and `users` IS its users. The clause must name public.is_platform_staff() (superadmin/admin/marketing/support) or public.can_read_tenant_financials() (the same minus marketing); either satisfies the ruling and the owner may swap between them freely. public.is_platform_admin() does NOT satisfy it — that helper is the superadmin ALONE, and accepting it is the exact defect m435 repaired: measured live before m435, a platform `support` operator saw 1 brokerage and 5 of 23 users, indistinguishable from an ordinary agent at the same tenant, and `users` carried no platform clause at all so not even the superadmin could see another tenant''s users.',
      array_to_string(offenders, ', public.');
  end if;

  raise notice 'm436(1): users and brokerages each carry a roster-level platform SELECT clause.';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 2 — NEITHER TABLE IS GRANTED TO PUBLIC OR anon, ON ANY COMMAND
-- ─────────────────────────────────────────────────────────────────────────────
--
-- PUBLIC includes `anon`, the key shipped inside the browser bundle, and `anon`
-- holds Supabase's default table GRANT on both tables — so RLS is the only thing
-- in the way. `users` is the PII table (email, phone, names) and `brokerages` is
-- the subscriber list; neither has any business naming the logged-out role in a
-- policy, on any command.
--
-- m417/m418 swept the `SELECT USING (true) TO PUBLIC` class and these two tables
-- were missed, because their predicates were not `true` — they were merely
-- granted to the wrong role while relying on arithmetic (auth.uid() IS NULL, the
-- helpers COALESCE to false) to keep anon out. That is a correct outcome reached
-- by accident, and it survives only as long as nobody adds a disjunct that is
-- true for a NULL identity — recurring defect (c), which this workstream has
-- found on several tables already.
--
-- A genuinely public surface does NOT reopen the policy: it reads server-side
-- through createServiceClient(), which carries rolbypassrls. That is how
-- /pricing serves subscription_tiers today, and it is how every god-console
-- reader of these two tables already works.

do $$
declare
  anon_oid  oid := (select oid from pg_roles where rolname = 'anon');
  offenders text[];
begin
  -- polcmd is "char", not text — the cast is required or the concatenation is
  -- an ambiguous-operator error at RUNTIME, inside the guard that is supposed to
  -- be reporting someone else's mistake.
  select coalesce(array_agg(c.relname || '.' || p.polname || ' (' || p.polcmd::text || ')'
                            order by c.relname, p.polname), '{}')
  into   offenders
  from   pg_policy p
  join   pg_class     c  on c.oid  = p.polrelid
  join   pg_namespace ns on ns.oid = c.relnamespace
  where  ns.nspname = 'public' and c.relname in ('users','brokerages')
    and (0 = any(p.polroles)                                          -- TO PUBLIC
         or (anon_oid is not null and anon_oid = any(p.polroles)));   -- TO anon

  if array_length(offenders, 1) is not null then
    raise exception
      'm436(2): % polic(ies) on users/brokerages name PUBLIC or anon: %. PUBLIC includes `anon` — the key shipped in the browser bundle — and `anon` holds Supabase''s default GRANT on both tables, so RLS is the only thing in the way. `users` carries email, phone and names; `brokerages` is the subscriber list. Grant them TO authenticated. Nothing is lost: every predicate on both tables is already not-true for anon (auth.uid() is NULL, the helpers COALESCE to false), so this is structure replacing arithmetic — and the arithmetic breaks the day someone adds a disjunct that a NULL identity satisfies. If a logged-out surface genuinely needs this data, read it server-side through createServiceClient(), which bypasses RLS and leaves the route in charge of what is public.',
      array_length(offenders, 1), array_to_string(offenders, ', ');
  end if;

  raise notice 'm436(2): no policy on users or brokerages names PUBLIC or anon.';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 3 — THE PLATFORM CLAUSE IS ON THE READ SIDE ONLY
-- ─────────────────────────────────────────────────────────────────────────────
--
-- The ruling is "needs to SEE". A platform operator reading every tenant is the
-- ruling; a platform operator EDITING every tenant's users is a different
-- decision the owner has not made. The standing rule is explicit — platform
-- financial access is "ALL tenants. READ ONLY — never add it to a write clause"
-- — and the same restraint governs the tenant and identity tables.
--
-- This is where recurring defect (f) bites hardest: `users` and `brokerages` are
-- the tables that DEFINE tenancy, so an unscoped WITH CHECK carrying a platform
-- helper would let a row be moved between tenants — or a user's own
-- brokerage_id, user_type or platform_role be rewritten — by any of four roles.
-- Writes on both tables stay where m435 left them: brokerages on
-- is_platform_admin() (superadmin alone), users on `id = auth.uid()`.
--
-- Checked on BOTH halves: USING (which rows you may act on) and WITH CHECK (what
-- the row may BECOME).

do $$
declare
  offenders text[];
begin
  select coalesce(array_agg(c.relname || '.' || p.polname || ' (' || p.polcmd::text || ')'
                            order by c.relname, p.polname), '{}')
  into   offenders
  from   pg_policy p
  join   pg_class     c  on c.oid  = p.polrelid
  join   pg_namespace ns on ns.oid = c.relnamespace
  where  ns.nspname = 'public' and c.relname in ('users','brokerages')
    and  p.polcmd in ('a','w','d','*')                    -- INSERT / UPDATE / DELETE / ALL
    and (coalesce(pg_get_expr(p.polqual,      p.polrelid), '') ~
           '(is_platform_staff|can_read_tenant_financials)\s*\('
      or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') ~
           '(is_platform_staff|can_read_tenant_financials)\s*\(');

  if array_length(offenders, 1) is not null then
    raise exception
      'm436(3): % write polic(ies) on users/brokerages carry a roster-level platform helper: %. The owner ruled that the platform "needs to SEE all tenants and their users" — that is a READ grant, and the standing rule on platform access is "ALL tenants. READ ONLY — never add it to a write clause." These two tables DEFINE tenancy, so a platform helper on the write side lets four roles rewrite a user''s brokerage_id, user_type or platform_role, or move a row between tenants through an unscoped WITH CHECK. Keep writes where they are: brokerages on public.is_platform_admin() (superadmin alone), users on `id = auth.uid()`. If cross-tenant staff WRITE is genuinely wanted, it needs its own ruling, not a widened USING.',
      array_length(offenders, 1), array_to_string(offenders, ', ');
  end if;

  raise notice 'm436(3): the platform clause on users/brokerages is read-only.';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- CLAIM 4 — THE RECURSION GUARD THAT MAKES A users POLICY ABLE TO READ users
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Every helper in the `users` SELECT policy — is_platform_staff(),
-- current_user_brokerage_id() — SELECTs FROM public.users. A policy on `users`
-- that calls a function that reads `users` is the classic infinite-recursion
-- footgun, and it fails at QUERY time, not at migration time: the DDL applies
-- clean and the whole app 500s afterwards.
--
-- What actually prevents it is ownership, not the search_path pin and not
-- SECURITY DEFINER on its own: a table's OWNER is exempt from that table's RLS
-- unless FORCE ROW LEVEL SECURITY is set, so a SECURITY DEFINER function owned by
-- the owner of public.users runs its inner select outside the policy and never
-- re-enters it. Two properties therefore have to hold together, and this claim
-- pins both:
--
--   · public.users is NOT force-RLS.
--   · every SECURITY DEFINER helper named by a public.users policy is owned by
--     the owner of public.users.
--
-- Break either one and the recursion is live. Setting FORCE ROW LEVEL SECURITY on
-- `users` for defence-in-depth is the likely way it happens, which is exactly why
-- it is asserted rather than commented.
--
-- Discovered by NAME from the live policy text, not from a hardcoded list, so a
-- helper added later is covered without editing this file.

do $$
declare
  users_owner  oid;
  forced       boolean;
  offenders    text[];
begin
  select c.relowner, c.relforcerowsecurity into users_owner, forced
  from   pg_class c join pg_namespace ns on ns.oid = c.relnamespace
  where  ns.nspname = 'public' and c.relname = 'users';

  if forced then
    raise exception
      'm436(4): public.users has FORCE ROW LEVEL SECURITY. Its own SELECT policy calls SECURITY DEFINER helpers that SELECT FROM public.users; those helpers are safe only because the table owner is exempt from the table''s RLS. FORCE removes that exemption and the policy recurses infinitely — at QUERY time, not migration time, so this applies clean and then every read of users fails. If force-RLS is genuinely wanted, the helpers must stop reading public.users first.';
  end if;

  select coalesce(array_agg(distinct pr.proname order by pr.proname), '{}')
  into   offenders
  from   pg_proc pr
  join   pg_namespace pn on pn.oid = pr.pronamespace
  where  pn.nspname = 'public'
    and  pr.prosecdef
    and  pr.proowner <> users_owner
    and  exists (
      select 1
      from   pg_policy p
      join   pg_class     c  on c.oid  = p.polrelid
      join   pg_namespace ns on ns.oid = c.relnamespace
      where  ns.nspname = 'public' and c.relname = 'users'
        and (coalesce(pg_get_expr(p.polqual,      p.polrelid), '')
          || coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''))
             ~ ('\m' || pr.proname || '\s*\(')
    );

  if array_length(offenders, 1) is not null then
    raise exception
      'm436(4): SECURITY DEFINER helper(s) named by a public.users policy are NOT owned by the owner of public.users: %. That ownership is the ONLY thing stopping the recursion — the helper SELECTs FROM public.users, and it escapes the policy solely because a table owner is exempt from its own RLS. Owned by anyone else, the helper''s inner read re-enters the policy that called it and every query against users fails at RUNTIME with infinite recursion. Any helper added to a users policy must match the shape of public.is_platform_staff(): SECURITY DEFINER, owned by the table owner, and SET search_path = public, pg_temp.',
      array_to_string(offenders, ', ');
  end if;

  raise notice 'm436(4): users is not force-RLS and every SECURITY DEFINER helper in its policies is owner-run — no recursion.';
end $$;
