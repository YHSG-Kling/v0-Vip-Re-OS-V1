-- m417 — the census is done, so the construct can be swept.
--
-- ── WHY THIS IS A SWEEP AND m413 WAS A LIST ──────────────────────────────────
--
-- m413 narrowed 8 of the 25 `FOR SELECT USING (true) TO PUBLIC` policies — the
-- ones on tables with zero readers — and deliberately left 17 alone, because
-- **a server-side reader on a logged-out route runs as `anon` too**. "No browser
-- client" does not prove a narrowing is safe; only reading each call site does.
-- Sweeping on the assumption is how a public pricing page breaks quietly.
--
-- That census is now done: 96 call sites across the 17 tables, every one
-- resolved to the client it actually uses and the surface it is reached from.
-- The result was unanimous, and the two surfaces that genuinely serve
-- logged-out visitors were the reason to check:
--
--   /pricing and /get-started render `subscription_tiers` through
--   lib/platform/public-tiers.ts:loadPublicTiers(svc) — and every caller passes
--   `createServiceClient()`. Service-role BYPASSES RLS, so the public pricing
--   page is untouched by any policy on that table.
--
--   /portal/[contactId]/documents reads `state_compliance_requirements` on the
--   cookie client, but app/portal/[contactId]/layout.tsx admits nobody without
--   a Supabase auth user (portal clients ARE auth users — the OTP magic link
--   creates one) and redirects to /portal/login otherwise.
--
-- Everything else resolved to one of two shapes: a `createServiceClient()` read
-- (crons, kernel, seeders, compliance loaders — RLS bypassed), or a cookie-client
-- read inside a server action or /dashboard page that has already resolved a
-- session. Not one anon-context reader among the 17.
--
-- ── ONE CODE CHANGE WAS REQUIRED FIRST, AND IT WAS A REAL DEFECT ─────────────
--
-- `platform_settings` was the single table this could have broken, and the way
-- it would have broken is worth stating: lib/ai/cost-tracking.ts
-- checkPlatformAIEnabled() read the platform AI kill switch through
-- `createClient()` — the CALLER's session — and FAILS OPEN, returning
-- `{ enabled: true }` on a refused read. Narrowing the policy under that code
-- would have left `emergency_mode` silently unenforced for any anon-context
-- call while the log line scrolled past. That read is now on the service client,
-- which is what it should always have been: a platform-wide stop button has no
-- business depending on who is asking. Fail-open is kept — a settings outage
-- should not take AI down for every tenant — but the read now succeeds.
--
-- ── WHAT CHANGES AND WHAT DOES NOT ───────────────────────────────────────────
--
-- TO only. The expression stays `USING (true)`: for a platform reference table
-- read by every signed-in tenant — plan limits, state fair-housing classes,
-- appraiser adjustment rates, the approved script catalogue — "every row" is
-- the correct answer. What was wrong is WHO. None of these 17 tables carries a
-- `brokerage_id`, so this is world-readable PLATFORM data coming off the open
-- internet, not cross-tenant leakage being closed.

do $$
declare
  pol       record;
  narrowed  text[] := '{}';
begin
  for pol in
    select p.polname, c.relname as tablename
    from   pg_policy p
    join   pg_class     c on c.oid = p.polrelid
    join   pg_namespace n on n.oid = c.relnamespace
    where  n.nspname = 'public'
      and  p.polpermissive                                       -- PERMISSIVE: it ORs
      and  p.polcmd = 'r'                                        -- FOR SELECT
      and  0 = any(p.polroles)                                   -- TO PUBLIC ⊇ anon
      and  coalesce(btrim(pg_get_expr(p.polqual, p.polrelid)), '') = 'true'
    order by c.relname, p.polname
  loop
    execute format('alter policy %I on public.%I to authenticated',
                   pol.polname, pol.tablename);
    narrowed := narrowed || (pol.tablename || '.' || pol.polname);
  end loop;

  if array_length(narrowed, 1) is null then
    raise notice 'm417: nothing to narrow — the SELECT-true-to-PUBLIC class is already empty.';
  else
    raise notice 'm417: narrowed % world-readable SELECT polic(ies) to authenticated: %',
      array_length(narrowed, 1), array_to_string(narrowed, ', ');
  end if;
end $$;
