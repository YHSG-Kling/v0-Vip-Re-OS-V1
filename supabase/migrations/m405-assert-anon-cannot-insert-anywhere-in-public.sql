-- m405 — asserts m404, and closes the pair with m397.
--
-- Together m397 (tables WITH a brokerage_id) and this one (tables without) cover
-- EVERY table in schema public. So the invariant is now sayable without a
-- qualifier: **`anon` cannot INSERT anywhere in `public`**, outside two policies
-- named with the logged-out call sites that need them.
--
-- Stating it as one assertion over the whole schema rather than two half-scans
-- is the point. The 20 policies m404 narrowed survived m396 precisely because
-- m396's qualifier — "on a tenant table" — was a reasonable boundary for the
-- migration and an unreasonable one for the invariant. A rule with a qualifier
-- has a shadow, and the shadow is where the audit trail was sitting.
--
-- Separate file because a `raise` rolls back its own transaction: asserting
-- inside m404 would undo the very narrowings it was checking.

do $$
declare
  remaining_anon_insert text[];
  -- The complete set, carried from m396/m397. Both have REAL logged-out writers
  -- and PUBLIC is correct for them, so this assertion must not demand them back:
  --   listing_inquiries   — app/listings/[listingId]/public-info-form.tsx
  --                         (browser client, logged-out listing page).
  --   tool_usage_sessions — app/actions/calculators.ts:607 trackToolUsage, under
  --                         "PUBLIC TOOLS (Zero Friction, No Email Required)"
  --                         (session client on a logged-out route ⇒ `anon`).
  -- m404 added none: its census found no browser-client writer for any of the 20
  -- tables it narrowed.
  keep_anon_insert      text[] := array[
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
    and  not ((c.relname || '.' || p.polname) = any(keep_anon_insert));
    -- NO table qualifier. That omission is the whole point of this file.

  if array_length(remaining_anon_insert, 1) is not null then
    raise exception
      'm405: % INSERT-true polic(ies) in schema public still let PUBLIC write: %. PUBLIC includes `anon`, the key shipped in the browser bundle, and `anon` holds Supabase''s default GRANT ALL on these tables — RLS is the only thing in the way and each of these says yes to an anonymous INSERT of any row. If the table is an audit or access log, note that an anonymous caller need not ERASE history to ruin it: forging and flooding it destroys the same property. Narrow it (ALTER POLICY <name> ON public.<table> TO authenticated), or name it in m404''s keep_anon_insert WITH the logged-out call site that needs it — a carve-out without a call site is the same defect with a new date on it.',
      array_length(remaining_anon_insert, 1),
      array_to_string(remaining_anon_insert, ', ');
  end if;

  raise notice 'm405: no INSERT-true policy in schema public is granted to PUBLIC outside the two named logged-out surfaces. `anon` cannot insert anywhere in public. Verified, not assumed.';
end $$;
