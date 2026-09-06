-- m397 — the assertion half of m396, and the reason it is a separate file.
--
-- m396 narrows to `authenticated` every `FOR INSERT WITH CHECK (true)` policy in
-- schema `public` that is granted to PUBLIC and sits on a table carrying a
-- `brokerage_id` column (37 of them, measured live), excluding two NAMED
-- carve-outs that have real anonymous writers. It changes no expression: the
-- only thing it removes is `anon`, the key that ships in the browser bundle.
--
-- Together with m394 that closes 52 of the 74 INSERT-true-to-PUBLIC policies on
-- this database — m394 the 15 on escape-carrying tables, m396 the 37 on the
-- remaining `brokerage_id` tables. What is deliberately still PUBLIC after both:
-- the 20 policies on tables with NO `brokerage_id` column (not tenant tables; a
-- separate question with a separate answer) and the two named carve-outs.
--
-- That leaves a gap that must not be allowed to close quietly, so this migration
-- is the gate: **if any `INSERT WITH CHECK (true)` policy on a `brokerage_id`
-- table is still granted to PUBLIC outside the named carve-outs, this FAILS and
-- names every one of them.**
--
-- WHY A SEPARATE MIGRATION rather than a `raise exception` at the end of m396:
-- a raise rolls back its whole transaction. Raising inside m396 would undo the
-- 37 narrowings along with it, so ONE policy that could not be narrowed would
-- revert every policy that could — and the schema would stay exactly as open to
-- `anon` as before, with a red migration as the only difference. Split, m396's
-- ALTERs COMMIT and this fails afterwards on the genuine remainder. Same reason
-- m393 is split from m392 and m395 from m394.
--
-- HOW TO SATISFY IT: for each policy named in the failure, decide who it is for
-- and say so in DDL, in its own migration.
--   · It is for signed-in users of the tenant — the ordinary case, and what m396
--     does: `ALTER POLICY <name> ON public.<table> TO authenticated;`
--   · It genuinely must be reachable logged-out — then say that out loud rather
--     than inheriting it: `ALTER POLICY … TO anon, authenticated;` and add the
--     policy to m396's `keep_anon_insert` array WITH THE CALL SITE that needs it,
--     the way `listing_inquiries_insert` is named there
--     (`app/listings/[listingId]/public-info-form.tsx`, a browser client on a
--     logged-out page). A carve-out that is not named is not a carve-out, it is
--     the same defect with a new date on it.
-- Do NOT satisfy it by deleting this file.
--
-- THE CARVE-OUT SET IS A SUPERSET OF m394'S, ON PURPOSE.
-- `tool_usage_sessions_insert` is m394's carve-out; its table carries both the
-- escape and a `brokerage_id` column, so it satisfies m396's qualifier as well.
-- It is named in m396 and named again here so that widening the qualifier cannot
-- silently reverse m394's ruling — and so that this assertion does not demand
-- back a grant m394 deliberately kept.
--
-- WHAT THIS DOES **NOT** ASSERT, and must not be read as blessing:
--   · The `brokerage_id IS NULL` branch survives m394 and m396 untouched, so any
--     AUTHENTICATED user of ANY brokerage can still read, update and delete
--     untenanted rows. That is the cross-tenant half — task #156, an owner
--     ruling with three different correct resolutions depending on the table.
--   · The 20 INSERT-true-to-PUBLIC policies on tables with no `brokerage_id`
--     column are out of this assertion's scope by construction. m395 and this
--     file between them say the ANONYMOUS half is closed on TENANT tables, and
--     nothing more.

do $$
declare
  remaining_anon_insert  text[];
  -- Kept in step with m396's `keep_anon_insert`, and a SUPERSET of m394's. Both
  -- have real anonymous writers, so PUBLIC is correct for them and this
  -- assertion must not demand them back:
  --   listing_inquiries   — app/listings/[listingId]/public-info-form.tsx
  --                         (browser client, logged-out listing page).
  --   tool_usage_sessions — app/actions/calculators.ts:607 trackToolUsage, under
  --                         "PUBLIC TOOLS (Zero Friction, No Email Required)"
  --                         (session client on a logged-out route ⇒ `anon`).
  keep_anon_insert       text[] := array[
    'listing_inquiries.listing_inquiries_insert',
    'tool_usage_sessions.tool_usage_sessions_insert'
  ];
begin
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
           from   pg_attribute a
           where  a.attrelid = p.polrelid
             and  a.attname  = 'brokerage_id'
             and  a.attnum   > 0
             and  not a.attisdropped
         );

  if array_length(remaining_anon_insert, 1) is not null then
    raise exception
      'm397: % INSERT-true polic(ies) on tables carrying `brokerage_id` still let PUBLIC write: %. PUBLIC includes `anon`, the key shipped in the browser bundle, and `anon` holds Supabase''s default GRANT ALL on these tables — RLS is the only thing in the way, and each of these says yes to an anonymous INSERT of any row. These are tenant tables: one of them is an earnings ledger. Narrow each one to the principal it was written for (ALTER POLICY <name> ON public.<table> TO authenticated), or name it as a deliberate logged-out surface in m396''s keep_anon_insert array with the call site that needs it.',
      array_length(remaining_anon_insert, 1),
      array_to_string(remaining_anon_insert, ', ');
  end if;

  raise notice 'm397: no INSERT-true policy on a `brokerage_id` table is granted to PUBLIC in schema public, outside the two named carve-outs. `anon` cannot insert into a tenant table. Verified, not assumed.';
end $$;
