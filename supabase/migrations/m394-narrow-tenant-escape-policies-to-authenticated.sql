-- m394 — the tenant escape hatch, and the anonymous INSERT sitting beside it,
--        stop being granted to `anon`.
--
-- ── WHAT WAS FOUND (measured on this database, docs/wave20-audit.md W20-1) ────
--
-- Migrations 029 and 030 added `brokerage_id` to a large slice of the schema and
-- installed the tenant policy in this shape:
--
--     CREATE POLICY "<t>_tenant" ON public.<t> FOR ALL
--       USING      (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id())
--       WITH CHECK (brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id());
--
-- 029's own header explains the `IS NULL` branch honestly — "all target tables
-- were empty or near-empty at apply time" — so it was written as a grandfather
-- clause for rows believed not to exist. It is not a grandfather clause. It is a
-- standing rule that any row without a tenant belongs to everyone, and there is
-- no `TO` clause, so "everyone" is Postgres PUBLIC — which includes **`anon`**,
-- the key that ships in the browser bundle.
--
--   policies containing the escape ........................... 1,029
--   of those, granted to PUBLIC (⊇ anon) ..................... 1,025, on 320 tables
--   all 1,025 are PERMISSIVE (they OR, they do not restrict) .. verified
--
-- Not inferred — executed, as `anon`, in a transaction that was rolled back and
-- verified rolled back: SELECT 270 rows, UPDATE 125 rows, DELETE 3 rows, and an
-- INSERT of 1 row. 523 of the 1,025 carry the escape in WITH CHECK, so an
-- anonymous caller can *manufacture* untenanted rows, each of which is then
-- readable, updatable and deletable by everyone under the same policy.
--
-- ── AND A SECOND, INDEPENDENT ANONYMOUS WRITE PATH ON THE SAME TABLES ────────
--
-- 74 policies in schema `public` are `FOR INSERT WITH CHECK (true)` granted to
-- PUBLIC. Narrowing the escape does nothing to them — a permissive INSERT policy
-- ORs in on its own. **16 of the 74 sit on tables that are ALSO under the escape**,
-- i.e. on tables that declare themselves tenant-scoped and simultaneously accept
-- anonymous writes. Two of the sixteen name the principal they fail to grant
-- anything to (`"System can insert insights"`, `"Service role can insert vendor
-- usage"`) — `service_role` holds BYPASSRLS and never needed a policy, so those
-- exist only as an anon grant. `ai_usage_log` and `vendor_usage_tracking` are the
-- metering ledgers the vendor budget gate reads; `orchestrator_tasks` is a work
-- queue; `generated_content` is a content-injection surface.
--
-- ── WHY THIS IS SAFE. EVERY LINE OF THIS WAS CHECKED, NOT ASSUMED ────────────
--
--  · ROLES. `anon` and `authenticated` are the only non-BYPASSRLS application
--    roles. `postgres`, `service_role` and `supabase_admin` BYPASS RLS, so cron,
--    webhooks and every server-side service-client write are unaffected by any
--    policy change whatsoever. `authenticator` never queries as itself —
--    PostgREST `SET ROLE`s to one of the two.
--  · POLICIES OR TOGETHER. A table with a deliberate public policy keeps it; 53
--    of the 320 have one. This migration removes `anon` from one policy, it does
--    not close a table.
--  · NO LOGGED-OUT BROWSER SURFACE DEPENDS ON THE ESCAPE. Only two browser-client
--    reads run outside a session. `listing_inquiries` (the public inquiry form)
--    is NOT in the escape set and already has the correct shape — `FOR INSERT
--    WITH CHECK (true)` to PUBLIC with SELECT/UPDATE/DELETE gated by
--    `has_brokerage_access`. That is the pattern to point at, and this migration
--    deliberately does not touch it (see the tenant-table qualifier below).
--  · THE ONE APPARENT EXCEPTION PROVES THE POINT. `neighborhood_reports` IS in
--    the escape set and `NeighborhoodWidget.tsx:92` reads it from the browser on
--    the public listing page. That fetch is guarded by `if (initialData ||
--    !listingId) return`, and its only renderer — `app/listing/[slug]/page.tsx:352`
--    — passes `data={neighborhoodData}` and NO `listingId`. The client fetch has
--    never run. Had it run, its only route through RLS is the escape, so it could
--    only ever have returned reports with NO tenant: the escape is not what makes
--    that widget work, it is what would have made it look like it worked, on
--    other tenants' data.
--
-- ── WHAT THIS MIGRATION DOES *NOT* DO, DELIBERATELY ──────────────────────────
--
-- IT DOES NOT REMOVE THE `brokerage_id IS NULL` BRANCH. That is the *cross-tenant*
-- half — any authenticated user of any brokerage can still read, update and delete
-- untenanted rows — and it is recorded in the audit as needing an owner ruling,
-- because it has three different correct resolutions depending on the table:
-- genuine platform-global catalogue content (`onboarding_steps`,
-- `training_videos`, `help_topics_kb`, …) wants a READ-ONLY global grant, not a
-- removal; `api_response_logs` writes `brokerage_id: null` on purpose and wants a
-- platform-admin policy rather than a tenant one; and everywhere else removal
-- would start failing every writer that currently omits `brokerage_id`. Three
-- resolutions for one predicate is a ruling, not a refactor.
--
-- So this is a STRICT NARROWING: `ALTER POLICY … TO authenticated`. The USING and
-- WITH CHECK expressions are untouched. The only thing removed is `anon`.
--
-- ── PREDICATE VS. LIST, AND THE ONE NAMED CARVE-OUT ──────────────────────────
--
-- PART 1 is construct-selected with no list at all: schema `public`, `polroles`
-- contains oid 0 (PUBLIC), and the escape appears in USING **or** WITH CHECK. It
-- never looks at a policy name — a name-keyed migration would find whatever
-- happens to be spelled `%_tenant` and miss every differently-named one, which is
-- the original mistake (believing a policy's name over its text) in a new coat.
--
-- PART 2 is construct-selected too — permissive, `polcmd = 'a'` (INSERT), WITH
-- CHECK exactly `true`, granted to PUBLIC — but with one further construct
-- qualifier and one named exception:
--
--   · THE TENANT-TABLE QUALIFIER. It fires only where the SAME TABLE also carries
--     a policy containing the escape. That is what makes the policy incoherent
--     rather than merely permissive: the table has declared itself tenant-scoped.
--     It is also what keeps this migration away from `listing_inquiries` and the
--     other 58 public-surface INSERT policies, which are a separate question with
--     a separate answer and are NOT dispatchable under this one. A construct
--     rather than a list, so a 17th on a tenant table is caught too.
--     (The qualifier is role-independent on purpose: PART 1 has already stripped
--     PUBLIC off the escape policies by the time PART 2 runs in this same
--     transaction, so a qualifier that asked for `0 = any(polroles)` would match
--     nothing.)
--
--   · `tool_usage_sessions_insert` IS KEPT, NAMED, NOT SILENTLY SKIPPED. It is
--     the one policy in the sixteen with a real anonymous writer:
--     `app/actions/calculators.ts:607 trackToolUsage` sits under the header
--     `// PUBLIC TOOLS (Zero Friction, No Email Required)`, is commented
--     `// Track tool usage anonymously`, and uses `createClient()` from
--     `@/lib/supabase/server` — so for a logged-out visitor it runs as `anon` and
--     genuinely needs this policy. Its table is in the escape set, so PART 1 does
--     narrow the escape there; that write is unaffected, because an INSERT is
--     admitted by ANY permissive WITH CHECK and this one stays `true` to PUBLIC.
--     For the other fifteen the measurement is the opposite: zero browser-client
--     files touch any of them, and every writer found goes through the service
--     client (BYPASSRLS, so the policy is dead weight) or a session client on an
--     authenticated surface — `chat_sessions` via `lib/education/agent-guide.ts:106`
--     and `client-tutor.ts:139` (`svc`), `email_tracking` via
--     `app/api/webhooks/sendgrid-events/route.ts:110` (`svc`), `ai_suggestions`
--     via `app/api/chat/stream/route.ts:114` (`createServiceClient`), and
--     `saved_calculations` / `prospects` / `prospect_context` have no insert call
--     sites at all.
--
-- ── THE ASSERTION IS m395, AND THAT SPLIT IS THE POINT ───────────────────────
--
-- A `raise` rolls back its own transaction. Asserting in here would undo the very
-- narrowings this migration just made, so one stubborn policy would revert all
-- 1,040 and leave the schema exactly as open as before with a red migration as
-- the only difference. Split, these ALTERs COMMIT and m395 fails afterwards on
-- whatever genuinely remains.
--
-- Expected at apply time, measured live before writing this file:
--   PART 1 → 1,025 policies across 320 tables
--   PART 2 → 15 policies (16 minus the named carve-out)

do $$
declare
  pol             record;
  narrowed        text[] := '{}';
  insert_narrowed text[] := '{}';
  -- PART 1 exclusions. A tenant-escape policy that genuinely SHOULD be reachable
  -- by `anon` must be named here, not silently spared — the same discipline m392
  -- used. Empty, and it should stay empty: the escape grants SELECT/INSERT/
  -- UPDATE/DELETE on every untenanted row, which no anonymous caller has any
  -- business holding.
  keep_escape     text[] := '{}';
  -- PART 2 exclusions. See the header: this one has a real anonymous writer.
  keep_anon_insert text[] := array['tool_usage_sessions.tool_usage_sessions_insert'];
begin
  -- ── PART 1: the tenant escape hatch ───────────────────────────────────────
  for pol in
    select p.polname,
           c.relname as tablename
    from   pg_policy p
    join   pg_class     c on c.oid = p.polrelid
    join   pg_namespace n on n.oid = c.relnamespace
    where  n.nspname = 'public'
      and  0 = any(p.polroles)                                   -- TO PUBLIC ⊇ anon
      and  (
             strpos(coalesce(pg_get_expr(p.polqual, p.polrelid), ''),
                    'brokerage_id IS NULL') > 0
          or strpos(coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
                    'brokerage_id IS NULL') > 0
           )
    order by c.relname, p.polname
  loop
    if (pol.tablename || '.' || pol.polname) = any(keep_escape) then
      continue;
    end if;

    -- TO only. No USING, no WITH CHECK: the expressions are not this migration's
    -- business, and rewriting them here is the owner ruling it must not pre-empt.
    execute format('alter policy %I on public.%I to authenticated',
                   pol.polname, pol.tablename);
    narrowed := narrowed || (pol.tablename || '.' || pol.polname);
  end loop;

  -- ── PART 2: the anonymous INSERT on the same tenant tables ────────────────
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
      and  exists (                                              -- …on a TENANT table
             select 1
             from   pg_policy p2
             where  p2.polrelid = p.polrelid
               and  (
                      strpos(coalesce(pg_get_expr(p2.polqual, p2.polrelid), ''),
                             'brokerage_id IS NULL') > 0
                   or strpos(coalesce(pg_get_expr(p2.polwithcheck, p2.polrelid), ''),
                             'brokerage_id IS NULL') > 0
                    )
           )
    order by c.relname, p.polname
  loop
    if (pol.tablename || '.' || pol.polname) = any(keep_anon_insert) then
      raise notice 'm394: KEPT (named carve-out, has a real anonymous writer): %.%',
        pol.tablename, pol.polname;
      continue;
    end if;

    execute format('alter policy %I on public.%I to authenticated',
                   pol.polname, pol.tablename);
    insert_narrowed := insert_narrowed || (pol.tablename || '.' || pol.polname);
  end loop;

  if array_length(narrowed, 1) is null and array_length(insert_narrowed, 1) is null then
    raise notice 'm394: nothing to narrow — no policy in schema public grants the tenant escape or an INSERT-true to PUBLIC.';
  end if;

  if array_length(narrowed, 1) is not null then
    raise notice 'm394: narrowed % tenant-escape polic(ies) to `authenticated` (expressions untouched; only `anon` removed).',
      array_length(narrowed, 1);
  end if;

  if array_length(insert_narrowed, 1) is not null then
    raise notice 'm394: narrowed % anonymous INSERT-true polic(ies) on tenant tables to `authenticated`: %',
      array_length(insert_narrowed, 1), array_to_string(insert_narrowed, ', ');
  end if;
end $$;
