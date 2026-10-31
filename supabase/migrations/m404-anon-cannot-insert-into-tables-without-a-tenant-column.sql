-- m404 — the other half of m396: `anon` INSERT on tables that have NO tenant column.
--
-- ── WHAT m396 LEFT BEHIND, AND WHY ───────────────────────────────────────────
--
-- m396 narrowed every `FOR INSERT ... WITH CHECK (true) TO PUBLIC` policy on a
-- table CARRYING a `brokerage_id`. That qualifier was deliberate — it kept the
-- migration to the tenant class it was reasoning about — but it left 20 policies
-- standing on tables that simply have no tenant column. PUBLIC includes `anon`,
-- the key shipped in the browser bundle, and `anon` holds Supabase's default
-- GRANT ALL on these tables, so RLS is the only thing in the way and each of
-- these says yes to an anonymous INSERT of any row.
--
-- FOUR OF THE TWENTY ARE THE AUDIT TRAIL: `audit_log`, `document_audit_trail`,
-- `document_access_log`, `conversation_audit_flags`. An anonymous caller cannot
-- ERASE history there — no DELETE is granted — but can FORGE and FLOOD it, which
-- damages the same property those tables exist to provide. An audit trail that
-- anyone can write to is not an audit trail; it is a suggestion box.
--
-- ── THE CARVE-OUT ARRAY IS EMPTY, AND THAT IS A MEASUREMENT ──────────────────
--
-- m396 kept two policies because they had real logged-out writers, each NAMED
-- with its call site: `listing_inquiries_insert`
-- (`app/listings/[listingId]/public-info-form.tsx`) and
-- `tool_usage_sessions_insert` (`app/actions/calculators.ts:607 trackToolUsage`).
-- Both of those tables carry a `brokerage_id`, so neither is in this set — there
-- is no interaction between the two migrations.
--
-- For these 20 the census was run before writing this file, across `app/`,
-- `lib/`, `components/`, `hooks/` and `services/`:
--
--   · 8 of the 20 have NO writer anywhere in the tree at all —
--     cma_comparables, embedding_queue, long_form_videos, marketing_stats,
--     newsletter_seo_scores, notification_queue, tool_shares,
--     transparency_videos.
--   · The other 12 are written only from server actions, API routes and lib
--     modules, on a SERVICE client (which BYPASSes RLS, so the policy is dead
--     weight to it) or a SESSION client on an authenticated surface.
--   · ZERO are written by a browser client. Not one of the writing files is a
--     `"use client"` component or imports `@/lib/supabase/client`, and
--     `components/` and `hooks/` contain no writer of any of the 20.
--
-- So the empty array is the answer the tree gave, not a shortcut. A carve-out
-- that is not named with a live call site is not a carve-out — it is the same
-- defect with a new date on it.
--
-- ── CONSTRUCT, NOT A LIST ────────────────────────────────────────────────────
--
-- The selection asks the catalog for the SHAPE — permissive, FOR INSERT,
-- WITH CHECK exactly `true`, granted to PUBLIC, on a table with no
-- `brokerage_id` — so a 21st written next month is caught too. A hardcoded list
-- of 20 names would only ever be as complete as today's query.
--
-- PURE NARROWING: `TO` only. No USING, no WITH CHECK, no DROP, no CREATE. The
-- expressions are not this migration's business and reversal is
-- `ALTER POLICY ... TO public`. The assertion is m405, split because a `raise`
-- rolls back its own transaction — asserting here would undo the narrowings.

do $$
declare
  pol              record;
  insert_narrowed  text[] := '{}';
  -- Empty by MEASUREMENT (see the census in the header). A policy that genuinely
  -- should admit `anon` must be named here WITH the logged-out call site that
  -- needs it, exactly as m396 named its two.
  keep_anon_insert text[] := '{}';
begin
  for pol in
    select p.polname,
           c.relname as tablename
    from   pg_policy p
    join   pg_class     c on c.oid = p.polrelid
    join   pg_namespace n on n.oid = c.relnamespace
    where  n.nspname = 'public'
      and  p.polpermissive                                       -- PERMISSIVE: it ORs
      and  p.polcmd = 'a'                                        -- FOR INSERT
      and  0 = any(p.polroles)                                   -- TO PUBLIC ⊇ anon
      and  coalesce(btrim(pg_get_expr(p.polwithcheck, p.polrelid)), '') = 'true'
      and  not exists (                                          -- …with NO tenant column
             select 1
             from   pg_attribute a
             where  a.attrelid = p.polrelid
               and  a.attname  = 'brokerage_id'
               and  a.attnum   > 0
               and  not a.attisdropped
           )
    order by c.relname, p.polname
  loop
    if (pol.tablename || '.' || pol.polname) = any(keep_anon_insert) then
      raise notice 'm404: KEPT (named carve-out, has a real anonymous writer): %.%',
        pol.tablename, pol.polname;
      continue;
    end if;

    execute format('alter policy %I on public.%I to authenticated',
                   pol.polname, pol.tablename);
    insert_narrowed := insert_narrowed || (pol.tablename || '.' || pol.polname);
  end loop;

  if array_length(insert_narrowed, 1) is null then
    raise notice 'm404: nothing to narrow — no INSERT-true policy on a tenant-columnless table is granted to PUBLIC.';
  else
    raise notice 'm404: narrowed % anonymous INSERT-true polic(ies) on tables with no brokerage_id to `authenticated` (expressions untouched; only `anon` removed): %',
      array_length(insert_narrowed, 1), array_to_string(insert_narrowed, ', ');
  end if;
end $$;
