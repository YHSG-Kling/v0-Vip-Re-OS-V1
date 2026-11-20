-- m416 — asserts m415.
--
-- Separate file because a `raise` rolls back its own transaction: asserting
-- inside m415 would undo the rewrites it was checking. Same split as
-- m393/m395/m397/m399/m403/m405/m407/m409/m412/m414.
--
-- ── THE CONSTRUCT, NOT THE LIST ──────────────────────────────────────────────
--
-- m415 found 13 policies. This asserts ZERO — anywhere in `public`, on any
-- table, in either USING or WITH CHECK. That is the difference between a
-- migration that cleaned up 13 rows and an invariant: a policy authored next
-- month with the same inverted spelling fails here rather than silently
-- admitting nobody for another six waves.
--
-- The spelling being banned is `current_user_type() = 'superadmin'`, and the
-- reason is measurable rather than stylistic: `current_user_type()` returns
-- `users.user_type`, and the superadmin of this platform is stored as
-- (user_type='admin', platform_role='superadmin'). The predicate is false for
-- every user in the table. `is_platform_admin()` is the helper that reads the
-- column the value actually lives in.
--
-- `current_user_type()` itself is NOT banned — comparing it to 'broker',
-- 'agent' or 'contact' is correct and several policies do. Only the
-- 'superadmin' comparison is the inversion, because that is the one value
-- that does not live in that column.

do $$
declare
  offenders text[];
  needle    constant text := 'current_user_type() = ''superadmin''';
  admin_n   int;
begin
  select coalesce(array_agg(c.relname || '.' || p.polname order by c.relname, p.polname), '{}')
  into   offenders
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public'
    and (coalesce(pg_get_expr(p.polqual, p.polrelid), '')      like '%' || needle || '%'
      or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') like '%' || needle || '%');

  if array_length(offenders, 1) is not null then
    raise exception
      'm416: % polic(ies) still gate on `current_user_type() = ''superadmin''`: %. That helper returns users.user_type, and NO row in public.users carries user_type=''superadmin'' — the platform superadmin is (user_type=''admin'', platform_role=''superadmin''). The predicate is therefore false for every user who has ever signed in: where it is the whole gate the capability is simply absent, and where it is the cross-tenant disjunct on a tenant read the superadmin silently sees nothing outside their own brokerage. Use is_platform_admin(), which reads platform_role AND still accepts the user_type spelling. This is the same inversion wave 30 fixed in TypeScript; it was in the database too.',
      array_length(offenders, 1), array_to_string(offenders, ', ');
  end if;

  -- The rewrite must have LANDED, not merely removed the old spelling. If a
  -- future edit deletes these policies instead of repointing them, the
  -- construct check above still passes while the capability is gone. Anchor on
  -- the two that are a WHOLE gate rather than a disjunct: those are the ones
  -- whose absence is invisible from the application side.
  select count(*) into admin_n
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public'
    and  c.relname in ('superadmin_audit_log', 'state_protected_classes')
    and (coalesce(pg_get_expr(p.polqual, p.polrelid), '')      like '%is_platform_admin()%'
      or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') like '%is_platform_admin()%');

  if admin_n < 2 then
    raise exception
      'm416: expected at least 2 is_platform_admin() policies across superadmin_audit_log and state_protected_classes, found %. The inverted spelling is gone but the capability did not land — the superadmin still cannot read the privileged-action audit log or correct a state''s fair-housing protected classes.',
      admin_n;
  end if;

  raise notice 'm416: no policy in public gates on the user_type spelling of superadmin; the two whole-gate cases carry is_platform_admin().';
end $$;
