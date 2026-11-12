-- m418 — asserts m417.
--
-- Separate file because a `raise` rolls back its own transaction: asserting
-- inside m417 would undo the narrowings it was checking. Same split as
-- m393/m395/m397/m399/m403/m405/m407/m409/m412/m414/m416.
--
-- ── THE CONSTRUCT, AND THIS TIME THE WHOLE OF IT ─────────────────────────────
--
-- m414 asserted a LIST of eight tables and reported the other 17 as a notice,
-- because a red gate on unfinished work pressures whoever hits it into
-- narrowing a table that feeds a logged-out page. That was the right call while
-- the census was outstanding. The census is done, so the claim can be the one
-- that actually holds a line: **no permissive `FOR SELECT USING (true)` policy
-- in `public` is granted to PUBLIC.** Zero, on any table, including tables that
-- do not exist yet.
--
-- PUBLIC includes `anon`, which is the key shipped inside the browser bundle,
-- and `anon` holds Supabase's default GRANT on these tables — so RLS is the
-- only thing in the way and `USING (true)` says yes to every row. A policy
-- authored next month with this shape is a table published to the internet by
-- accident, and it fails here instead of six waves later.
--
-- ── THE ESCAPE HATCH IS REAL, AND IT IS NOT THIS SHAPE ───────────────────────
--
-- Nothing here forbids serving data to logged-out visitors. /pricing and
-- /get-started do exactly that today and are untouched by this assertion,
-- because they read through `createServiceClient()`, which bypasses RLS
-- entirely. That is the pattern for a genuinely public surface: a server-side
-- read on the service client, with the route deciding what is public — not a
-- policy that hands `anon` the whole table and hopes no one asks.

do $$
declare
  offenders text[];
begin
  select coalesce(array_agg(c.relname || '.' || p.polname order by c.relname, p.polname), '{}')
  into   offenders
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public'
    and  p.polpermissive
    and  p.polcmd = 'r'
    and  0 = any(p.polroles)
    and  coalesce(btrim(pg_get_expr(p.polqual, p.polrelid)), '') = 'true';

  if array_length(offenders, 1) is not null then
    raise exception
      'm418: % permissive SELECT polic(ies) grant every row to PUBLIC: %. PUBLIC includes `anon` — the key shipped in the browser bundle — and `anon` holds Supabase''s default GRANT on public tables, so RLS is the only thing in the way and `USING (true)` says yes to every row. If this table genuinely feeds a logged-out page, do NOT reopen the policy: read it server-side through createServiceClient(), which bypasses RLS and leaves the route in charge of what is public. That is how /pricing and /get-started serve subscription_tiers today. If it feeds a signed-in surface, grant it TO authenticated.',
      array_length(offenders, 1), array_to_string(offenders, ', ');
  end if;

  raise notice 'm418: no permissive SELECT-true policy in public is granted to PUBLIC.';
end $$;
