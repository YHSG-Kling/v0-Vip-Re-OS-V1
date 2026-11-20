-- m396 — the anonymous INSERT on a tenant table stops being granted to `anon`,
--        on the tenant tables m394's qualifier could not see.
--
-- ── WHAT m394 DID, AND WHAT IT LEFT ─────────────────────────────────────────
--
-- m394 PART 2 narrowed `FOR INSERT WITH CHECK (true)` policies granted to PUBLIC
-- — but only on tables that ALSO carry a policy containing the
-- `brokerage_id IS NULL` tenant escape. Measured live, before and after:
--
--   INSERT-true granted to PUBLIC, schema public ................. 74
--     · on a table carrying the escape ........................... 16   ← m394
--         narrowed by m394 ...................................... 15
--         named carve-out (`tool_usage_sessions_insert`) .......... 1
--     · not on an escape table, but the table HAS `brokerage_id` .. 38   ← this file
--     · not on an escape table, no `brokerage_id` column .......... 20   ← untouched
--
-- ── WHY THE QUALIFIER CHANGES HERE, AND WHY THAT IS NOT A REVERSAL ──────────
--
-- m394's qualifier was "the same table also carries the escape". That was the
-- right call and this migration does not overturn it: it is precisely what kept
-- m394 away from `listing_inquiries`, the real public inquiry form, and away
-- from the other 58 public-surface INSERT policies that had not been censused
-- yet. Narrowing those under m394's evidence would have been an unreviewed
-- behaviour change on live surfaces.
--
-- But the escape is a PROXY for "this table is tenant-scoped", and it is a
-- lossy one. It is carried by whichever tables migrations 029/030 happened to
-- reach; it is not the definition. The definition this schema actually uses for
-- a tenant table is the `brokerage_id` COLUMN — `has_brokerage_access(brokerage_id)`
-- is the shape every hand-written tenant policy in this codebase keys on. So
-- this migration swaps the proxy for the thing: **an INSERT-true-to-PUBLIC
-- policy on a table that carries a `brokerage_id` column.**
--
-- Same defect, same remedy, one wider qualifier. m394 narrowed what its evidence
-- covered; wave 21 and wave 22 ran the census that covers the rest, and this
-- file narrows exactly what that census cleared. Nothing m394 decided is undone
-- — including its named carve-out, which is carried forward below.
--
-- ── THE CENSUS THAT CLEARED THEM. TWO AXES, BOTH RUN ────────────────────────
--
-- Thirty-eight policies qualify. `agent_monthly_earnings`, `agent_points_log`,
-- `communications`, `document_requests`, `document_downloads`, `automation_logs`,
-- `push_notification_queue`, `transaction_pending_actions` and
-- `newsletter_scheduled_sends` are among them — an anonymous caller can insert
-- into an earnings ledger. None of these is a public write surface.
--
--  · BROWSER-CLIENT AXIS (docs/wave21-audit.md § W21-5). 34 of the 38 have no
--    browser-client file touching them at all; six have no insert call site
--    anywhere in `app/` or `lib/` (`agent_metrics`, `agent_notifications`,
--    `appointments`, `lead_conversation_history`, `lead_external_behavior`,
--    `lead_social_intelligence`). Of the four with a browser client, three are
--    authenticated app pages — `ai_autopilot_actions` (agent dashboard),
--    `closing_gifts` (transaction detail), `newsletter_scheduled_sends`
--    (marketing studio) — and a browser client on an authenticated page carries
--    the user's JWT and queries as `authenticated`, not `anon`. The fourth is
--    `listing_inquiries`, and it is the carve-out.
--
--  · SESSION-CLIENT-ON-A-LOGGED-OUT-ROUTE AXIS. The browser axis alone is NOT
--    sufficient, and `tool_usage_sessions` is why: a session server client on a
--    logged-out route runs as `anon` too. All 34 are written from server code;
--    eight are session-client-only. The two that wave 21 left open are closed in
--    docs/wave22-audit.md § W22-2 — `calculator_history`'s callers are under
--    `/portal`, which requires a Supabase session
--    (`app/portal/[contactId]/layout.tsx:58` calls `getUser()`, `:156` redirects
--    to `/portal/login`), and `document_downloads`' caller is an authenticated
--    partner route whose membership read returns empty for an anonymous caller,
--    so the insert is unreachable before RLS is consulted.
--
--  · SPOT-CHECKED AGAINST THE SOURCE, five of the 37, before writing this file:
--      `agent_monthly_earnings` — `app/api/cron/earnings-rollup/route.ts:99`,
--        `createServiceClient()` behind `verifyCronAuth`. BYPASSRLS; the policy
--        is dead weight. (`app/actions/financials.ts:53` is a read.)
--      `communications` — `lib/connections/zoom-transcripts.ts:147`, `svc`
--        (`ReturnType<typeof createServiceClient>`). BYPASSRLS.
--      `automation_logs` — `app/actions/assistant.ts:93`, session client, gated
--        by `authorizeForUser` (`lib/auth/authorize-for-user.ts:56`:
--        `if (!user) return { ok: false, error: "Not authenticated" }`). Fails
--        closed for `anon`.
--      `property_search_log` — `app/actions/idx-search.ts:130 smartSearch`,
--        session client, and `/properties/search` has no auth gate. It is still
--        not an anonymous writer: the first thing `smartSearch` does is read
--        `contacts` by id and `throw`s on error, and every SELECT policy on
--        `contacts` requires `auth.uid()` to resolve to a `users` row. `contacts`
--        carries NO escape, so for `anon` the read is refused and the function
--        returns before the insert.
--      `showing_communications` — `app/actions/ai-showing-management.ts:598
--        aiSendShowingConfirmation`, session client, sole caller
--        `app/components/dashboard/listings/showings/confirmed-showings-list.tsx:70`
--        (authenticated dashboard). Its `showings` read reaches `anon` today only
--        through the escape, which m394 has already narrowed by the time this
--        migration runs.
--
-- ── THE TWO NAMED CARVE-OUTS. NEITHER IS A SILENT `<>` ──────────────────────
--
--  · `listing_inquiries.listing_inquiries_insert` — THE REAL PUBLIC INQUIRY
--    FORM. `app/listings/[listingId]/public-info-form.tsx` posts it from a
--    browser client on a logged-out page, so it genuinely runs as `anon`. It is
--    also the shape m394's header points at as CORRECT: `FOR INSERT WITH CHECK
--    (true)` open, with SELECT/UPDATE/DELETE gated by `has_brokerage_access`.
--    Keeping it is the whole reason m394 chose the narrower qualifier, and
--    widening the qualifier must not cost it.
--
--  · `tool_usage_sessions.tool_usage_sessions_insert` — CARRIED FORWARD FROM
--    m394, WHERE IT IS ALREADY NAMED. Its table carries both the escape AND a
--    `brokerage_id` column, so it satisfies this migration's qualifier too; left
--    unnamed here, m396 would silently narrow the one policy m394 deliberately
--    kept and reverse an earlier ruling by accident. Its writer is real:
--    `app/actions/calculators.ts:607 trackToolUsage`, under
--    `// PUBLIC TOOLS (Zero Friction, No Email Required)`, using `createClient()`
--    from `@/lib/supabase/server` — `anon` for a logged-out visitor. m396's keep
--    set must therefore stay a SUPERSET of m394's.
--
-- ── WHAT THIS MIGRATION DOES *NOT* DO, DELIBERATELY ─────────────────────────
--
--  · IT DOES NOT TOUCH THE `brokerage_id IS NULL` BRANCH. That is the
--    cross-tenant half — any authenticated user of any brokerage can still read,
--    update and delete untenanted rows — and it is task #156, an owner ruling,
--    because it has three different correct resolutions depending on the table.
--    m394 said so and nothing here changes it. No USING, no WITH CHECK, no DROP,
--    no CREATE: the only thing this file removes is `anon`.
--
--  · IT DOES NOT TOUCH THE 20 INSERT-TRUE POLICIES ON TABLES WITH NO
--    `brokerage_id` COLUMN. Those are not tenant tables; whether each is a
--    deliberate logged-out surface is a separate question with a separate
--    answer, and it is not dispatchable under this one.
--
-- ── PREDICATE, NEVER A NAME ─────────────────────────────────────────────────
--
-- Construct-selected throughout: schema `public`, PERMISSIVE, `polcmd = 'a'`
-- (INSERT), WITH CHECK exactly `true`, `polroles` contains oid 0 (PUBLIC), and
-- the table carries a live `brokerage_id` attribute. It never looks at a policy
-- name — a name-keyed migration would find whatever happens to be spelled
-- `%_insert` and miss every differently-named one, which is the original mistake
-- (believing a policy's name over its text) in a new coat. A 39th policy of this
-- shape arriving later is caught for the same reason.
--
-- ── THE ASSERTION IS m397, AND THAT SPLIT IS THE POINT ──────────────────────
--
-- A `raise` rolls back its own transaction. Asserting in here would undo the
-- very narrowings this migration just made, so one stubborn policy would revert
-- all 37 and leave the schema exactly as open as before with a red migration as
-- the only difference — the same reason m393 is split from m392 and m395 from
-- m394. Split, these ALTERs COMMIT and m397 fails afterwards on whatever
-- genuinely remains.
--
-- Expected at apply time, measured live before writing this file (m394 applied
-- first, in the same rolled-back transaction that parsed this one):
--   38 policies qualify → 37 narrowed, 1 kept (`listing_inquiries`).
--   `tool_usage_sessions` is already PUBLIC-free of this file's reach because
--   m394 keeps it and m396 keeps it too.

do $$
declare
  pol              record;
  insert_narrowed  text[] := '{}';
  -- Exclusions. A policy that genuinely SHOULD be reachable by `anon` must be
  -- named here with the call site that needs it, not silently spared with a
  -- `<>` — the same discipline m392 and m394 used. A carve-out that is not named
  -- is not a carve-out, it is the same defect with a new date on it.
  --
  --   listing_inquiries  — the public inquiry form. Browser client on a
  --                        logged-out page: app/listings/[listingId]/public-info-form.tsx.
  --   tool_usage_sessions — m394's carve-out, carried forward so this migration
  --                        does not reverse it. Logged-out session client:
  --                        app/actions/calculators.ts:607 trackToolUsage.
  keep_anon_insert text[] := array[
    'listing_inquiries.listing_inquiries_insert',
    'tool_usage_sessions.tool_usage_sessions_insert'
  ];
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
      and  exists (                                              -- …on a TENANT table
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
      raise notice 'm396: KEPT (named carve-out, has a real anonymous writer): %.%',
        pol.tablename, pol.polname;
      continue;
    end if;

    -- TO only. No USING, no WITH CHECK: the expressions are not this migration's
    -- business, and the `brokerage_id IS NULL` branch on these tables is the
    -- owner ruling (task #156) it must not pre-empt.
    execute format('alter policy %I on public.%I to authenticated',
                   pol.polname, pol.tablename);
    insert_narrowed := insert_narrowed || (pol.tablename || '.' || pol.polname);
  end loop;

  if array_length(insert_narrowed, 1) is null then
    raise notice 'm396: nothing to narrow — no INSERT-true policy on a `brokerage_id` table is granted to PUBLIC outside the named carve-outs.';
  else
    raise notice 'm396: narrowed % anonymous INSERT-true polic(ies) on tenant tables to `authenticated` (expressions untouched; only `anon` removed): %',
      array_length(insert_narrowed, 1), array_to_string(insert_narrowed, ', ');
  end if;
end $$;
