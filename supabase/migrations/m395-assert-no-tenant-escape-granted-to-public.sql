-- m395 — the assertion half of m394, and the reason it is a separate file.
--
-- m394 narrows to `authenticated` every policy in schema `public` that grants a
-- `brokerage_id IS NULL` tenant escape to PUBLIC (1,025 of them, across 320
-- tables, measured live), plus the 15 `FOR INSERT WITH CHECK (true)` policies
-- granted to PUBLIC that sit on those same tenant tables. It changes no
-- expression: the only thing it removes is `anon`, the key that ships in the
-- browser bundle.
--
-- That leaves a gap that must not be allowed to close quietly, so this migration
-- is the gate: **if any tenant-escape policy — or any anonymous INSERT-true
-- policy on a tenant table — is still granted to PUBLIC, this FAILS and names
-- every one of them.**
--
-- WHY A SEPARATE MIGRATION rather than a `raise exception` at the end of m394:
-- a raise rolls back its whole transaction. Raising inside m394 would undo the
-- 1,040 narrowings along with it, so ONE policy that could not be narrowed would
-- revert every policy that could — and the schema would stay exactly as open to
-- `anon` as before, with a red migration as the only difference. Split, m394's
-- ALTERs COMMIT and this fails afterwards on the genuine remainder.
--
-- HOW TO SATISFY IT: for each policy named in the failure, decide who it is for
-- and say so in DDL, in its own migration.
--   · It is for signed-in users of the tenant — the ordinary case, and what m394
--     does: `ALTER POLICY <name> ON public.<table> TO authenticated;`
--   · It genuinely must be reachable logged-out — then say that out loud rather
--     than inheriting it: `ALTER POLICY … TO anon, authenticated;` and add the
--     policy to m394's `keep_escape` / `keep_anon_insert` array with the call site
--     that needs it, the way `tool_usage_sessions_insert` is named there
--     (`app/actions/calculators.ts:607 trackToolUsage`, a logged-out visitor
--     running as `anon`). A carve-out that is not named is not a carve-out, it is
--     the same defect with a new date on it.
-- Do NOT satisfy it by deleting this file.
--
-- WHAT THIS DOES **NOT** ASSERT, and must not be read as blessing: the
-- `brokerage_id IS NULL` branch itself survives m394 untouched, so any
-- AUTHENTICATED user of ANY brokerage can still read, update and delete
-- untenanted rows. That is the cross-tenant half, it is recorded in
-- docs/wave20-audit.md as needing an owner ruling (three different correct
-- resolutions depending on the table), and a green m395 says only that the
-- ANONYMOUS half is closed.

do $$
declare
  remaining_escape       text[];
  remaining_anon_insert  text[];
  -- The one named carve-out, kept in step with m394's `keep_anon_insert`. It has
  -- a real anonymous writer (app/actions/calculators.ts:607 trackToolUsage, under
  -- "PUBLIC TOOLS (Zero Friction, No Email Required)"), so PUBLIC is correct here
  -- and this assertion must not demand it back.
  keep_anon_insert       text[] := array['tool_usage_sessions.tool_usage_sessions_insert'];
begin
  -- ── the tenant escape hatch, still granted to PUBLIC ──────────────────────
  select coalesce(array_agg(c.relname || '.' || p.polname order by c.relname, p.polname), '{}')
  into   remaining_escape
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public'
    and  0 = any(p.polroles)                                     -- TO PUBLIC ⊇ anon
    and  (
           strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), ''),
                  'brokerage_id IS NULL') > 0
        or strpos(coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
                  'brokerage_id IS NULL') > 0
         );

  -- ── the anonymous INSERT sitting on those same tenant tables ──────────────
  select coalesce(array_agg(c.relname || '.' || p.polname order by c.relname, p.polname), '{}')
  into   remaining_anon_insert
  from   pg_policy p
  join   pg_class     c on c.oid = p.polrelid
  join   pg_namespace n on n.oid = c.relnamespace
  where  n.nspname = 'public'
    and  p.polpermissive                                         -- PERMISSIVE: it ORs
    and  p.polcmd = 'a'                                          -- FOR INSERT
    and  0 = any(p.polroles)                                     -- TO PUBLIC ⊇ anon
    and  coalesce(btrim(pg_get_expr(p.polwithcheck, p.polrelid)), '') = 'true'
    and  not ((c.relname || '.' || p.polname) = any(keep_anon_insert))
    and  exists (                                                -- …on a TENANT table
           select 1
           from   pg_policy p2
           where  p2.polrelid = p.polrelid
             and  (
                    strpos(coalesce(pg_get_expr(p2.polqual, p2.polrelid), ''),
                           'brokerage_id IS NULL') > 0
                 or strpos(coalesce(pg_get_expr(p2.polwithcheck, p2.polrelid), ''),
                           'brokerage_id IS NULL') > 0
                  )
         );

  if array_length(remaining_escape, 1) is not null
     or array_length(remaining_anon_insert, 1) is not null then
    raise exception
      'm395: % tenant-escape polic(ies) still grant `brokerage_id IS NULL` to PUBLIC: %. And % INSERT-true polic(ies) on those same tenant tables still let PUBLIC write: %. PUBLIC includes `anon`, the key shipped in the browser bundle, and `anon` holds Supabase''s default GRANT ALL on these tables — RLS is the only thing in the way, and each of these says yes. Narrow each one to the principal it was written for (ALTER POLICY <name> ON public.<table> TO authenticated), or name it as a deliberate logged-out surface in m394''s keep arrays with the call site that needs it.',
      coalesce(array_length(remaining_escape, 1), 0),
      case when array_length(remaining_escape, 1) is null then '(none)'
           else array_to_string(remaining_escape, ', ') end,
      coalesce(array_length(remaining_anon_insert, 1), 0),
      case when array_length(remaining_anon_insert, 1) is null then '(none)'
           else array_to_string(remaining_anon_insert, ', ') end;
  end if;

  raise notice 'm395: no tenant-escape policy and no INSERT-true policy on a tenant table is granted to PUBLIC in schema public. `anon` is off both paths. Verified, not assumed.';
end $$;
