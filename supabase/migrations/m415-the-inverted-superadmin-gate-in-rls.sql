-- m415 — the wave-30 inversion, second half: it was in the DATABASE too.
--
-- ── WHAT WAVE 30 FIXED, AND WHAT IT MISSED ───────────────────────────────────
--
-- Wave 30 established the owner's roster ("platform roles are the staff
-- including superadmin, admin, support, marketing") and found the live
-- superadmin is stored as (user_type='admin', platform_role='superadmin'). The
-- defect it fixed was a gate matching a platform_role roster against the
-- user_type COLUMN — so the gate admitted NOBODY who should pass.
--
-- That fix landed in TypeScript. The identical inversion was sitting in 13 RLS
-- policies across 12 tables, spelled:
--
--     current_user_type() = 'superadmin'
--
-- and `current_user_type()` is literally `SELECT user_type FROM users WHERE
-- id = auth.uid()`. Measured on the live database: ZERO users carry
-- user_type='superadmin'. The one superadmin is (admin, superadmin). So every
-- one of these 13 predicates is false for every user who has ever existed.
--
-- ── WHAT THAT COSTS ──────────────────────────────────────────────────────────
--
-- Two of the 13 are the WHOLE gate, not a disjunct, so the capability is
-- simply absent:
--
--   superadmin_audit_log.sal_superadmin_read   — the superadmin cannot read
--       the superadmin audit log. The record of privileged action is
--       unreadable by the only role entitled to read it.
--   state_protected_classes.spc_superadmin_write — the superadmin cannot add
--       or correct a state's fair-housing protected classes. That table feeds
--       lib/compliance-rules/state-fair-housing.ts; its 49 rows are frozen.
--
-- The other 11 are the cross-tenant escape on a tenant read
-- (`brokerage_id = current_user_brokerage_id() OR <this>`). Those fail CLOSED —
-- the superadmin simply sees nothing outside their own brokerage — which is
-- safe but wrong, and silently so: the console renders an empty table rather
-- than saying it was refused.
--
-- ── THE SURVIVOR ─────────────────────────────────────────────────────────────
--
-- `is_platform_admin()` — already the canonical superadmin helper in this
-- schema, backing 505 policies across 179 tables:
--
--     platform_role = 'superadmin' OR user_type IN ('superadmin','super_admin')
--
-- It is a strict SUPERSET of what these 13 tried to express: it still admits a
-- user_type='superadmin' row if one is ever written, and additionally admits
-- the platform_role spelling that is how the superadmin is ACTUALLY stored.
-- Nothing is widened beyond superadmin. This deliberately does NOT reach for
-- m408's `is_platform_staff()` (the four-role roster) — the ruling says who the
-- staff are, not that a marketing account may read the superadmin audit log.
--
-- ── HOW THE SWAP IS DONE ─────────────────────────────────────────────────────
--
-- Text substitution on `pg_get_expr()` output. That is safe here and only here:
-- the needle is not hand-typed source, it is Postgres's OWN deparser output for
-- a function call it normalises identically every time. m416 asserts the
-- construct reaches ZERO and that the policy COUNT is unchanged, so a
-- substitution that mangled an expression would surface as a dropped policy.

do $$
declare
  pol       record;
  fixed     text[] := '{}';
  needle    constant text := '(current_user_type() = ''superadmin''::text)';
  before_n  int;
  after_n   int;
begin
  select count(*) into before_n
  from pg_policy p join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public';

  for pol in
    select p.polname, c.relname as tablename,
           pg_get_expr(p.polqual, p.polrelid)      as qual,
           pg_get_expr(p.polwithcheck, p.polrelid) as wc
    from   pg_policy p
    join   pg_class     c on c.oid = p.polrelid
    join   pg_namespace n on n.oid = c.relnamespace
    where  n.nspname = 'public'
      and (coalesce(pg_get_expr(p.polqual, p.polrelid), '')      like '%' || needle || '%'
        or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') like '%' || needle || '%')
    order by c.relname, p.polname
  loop
    -- USING and WITH CHECK are set in one statement so the policy is never
    -- momentarily half-migrated (a WITH CHECK-only policy would reject every
    -- write in the window between two ALTERs inside the same transaction).
    if pol.qual is not null and pol.wc is not null then
      execute format('alter policy %I on public.%I using (%s) with check (%s)',
                     pol.polname, pol.tablename,
                     replace(pol.qual, needle, 'is_platform_admin()'),
                     replace(pol.wc,   needle, 'is_platform_admin()'));
    elsif pol.qual is not null then
      execute format('alter policy %I on public.%I using (%s)',
                     pol.polname, pol.tablename,
                     replace(pol.qual, needle, 'is_platform_admin()'));
    else
      execute format('alter policy %I on public.%I with check (%s)',
                     pol.polname, pol.tablename,
                     replace(pol.wc, needle, 'is_platform_admin()'));
    end if;
    fixed := fixed || (pol.tablename || '.' || pol.polname);
  end loop;

  select count(*) into after_n
  from pg_policy p join pg_class c on c.oid = p.polrelid
  join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public';

  if before_n <> after_n then
    raise exception 'm415: policy count changed % -> % during an ALTER-only migration. Something was dropped, not rewritten.',
      before_n, after_n;
  end if;

  raise notice 'm415: repointed % polic(ies) off the inverted user_type gate onto is_platform_admin(): %',
    coalesce(array_length(fixed, 1), 0), array_to_string(fixed, ', ');
end $$;
