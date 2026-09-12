-- m398 — `is_active` on a negotiation playbook means PUBLISHED TO THIS TENANT'S
--        PEOPLE. It has been meaning published to the open internet.
--
-- ── WHAT WAS FOUND (docs/wave20-audit.md § W20-1, carried open through 21–26) ─
--
-- `public.offer_strategy_templates` carries, verbatim:
--
--     CREATE POLICY "Read active templates" ON public.offer_strategy_templates
--       FOR SELECT USING (is_active = true);
--
-- No `TO` clause, so the grantee is Postgres PUBLIC — which includes **`anon`**,
-- the key that ships in the browser bundle. Measured live on this database
-- before writing this file:
--
--   relrowsecurity ............................................. true
--   has_table_privilege('anon', …, 'SELECT') ................... true
--   policies on the table ........................................ 5
--   SELECT-to-PUBLIC policies whose USING is exactly `(is_active = true)`
--     …on a table carrying a `brokerage_id` column ............... 1
--   rows in the table ............................................ 0
--
-- The table is EMPTY, which is the only reason nothing has leaked. It is not a
-- mitigation: an offer strategy template is a brokerage's negotiation playbook —
-- `price_guidance`, `earnest_money_guidance`, `contingency_recommendations`,
-- `risk_level`, `success_rate_estimate` per `market_condition`. The moment any
-- brokerage marks one active it becomes world-readable, and it stays that way
-- until somebody notices.
--
-- ── AND THE LEAK IS NOT ONLY ANONYMOUS ──────────────────────────────────────
--
-- `is_active = true` says nothing about a tenant, so this policy is ALSO the
-- route by which an authenticated user of brokerage B reads brokerage A's
-- playbook. m394's `ALTER … TO authenticated` remedy is therefore NOT sufficient
-- here and this migration does not use it: narrowing the ROLE would close `anon`
-- and leave every other brokerage reading. The PREDICATE is the defect.
--
-- ── THE REPLACEMENT PREDICATE WAS READ OFF THIS SCHEMA, NOT INVENTED ─────────
--
-- Four comparable template tables were read first, and they agree on the shape.
-- None of them gates SELECT on `is_active`; every one of them scopes on
-- `brokerage_id` with a NULL branch for platform-seeded global rows:
--
--   `brokerage_form_library.brokerage_form_library_tenant_select`
--   `content_templates.content_templates_tenant_select`
--       USING ((brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id()))
--   `chat_templates.tenant_read_chat_templates`   (already TO authenticated)
--       USING ((brokerage_id IN (SELECT user_brokerage_ids())) OR (brokerage_id IS NULL))
--   `thank_you_note_templates.tyn_templates_brokerage`
--       USING ((brokerage_id IS NULL) OR (brokerage_id = (SELECT agents.brokerage_id
--              FROM agents WHERE agents.user_id = auth.uid() LIMIT 1)))
--
-- One shape, three spellings of "the caller's brokerage". The first spelling is
-- the one this table ALREADY uses on its own three sibling policies
-- (`offer_strategy_templates_tenant_select` / `_insert` / `_update` / `_delete`),
-- so it is the spelling used here — a table that answers the tenant question two
-- different ways on two of its own policies is a worse outcome than the leak.
--
-- AND THE APPLICATION HAS BEEN COMPUTING EXACTLY THIS PREDICATE IN USERLAND.
-- The sole reader of this table, `app/actions/buyer-offers.ts:411
-- getOrGenerateStrategyRecommendation`, issues:
--
--     .from("offer_strategy_templates").select("*")
--       .eq("is_active", true)
--       .or(`brokerage_id.eq.${brokerageId},brokerage_id.is.null`)
--
-- which is `is_active = true AND (brokerage_id = <tenant> OR brokerage_id IS
-- NULL)` — the conjunction installed below, character for character in meaning.
-- The policy was not enforcing the product's own rule; the product was enforcing
-- it by hand and the policy was quietly wider.
--
-- ── `is_active` IS KEPT AS A CONJUNCT, NOT REPLACED ─────────────────────────
--
-- The ruling is that `is_active` means published to THIS TENANT'S people — so it
-- still gates, it just stops being the only thing that gates. `is_active = true`
-- becomes `is_active = true AND <tenant>`: a PURE NARROWING of the USING
-- expression, on top of a pure narrowing of the role. No principal gains a row.
--
-- ── AND THE HONEST CONSEQUENCE, RECORDED RATHER THAN SMOOTHED ───────────────
--
-- After this change `"Read active templates"` is a STRICT SUBSET of its sibling
-- `offer_strategy_templates_tenant_select`, which carries the same tenant
-- predicate WITHOUT the `is_active` conjunct. Permissive policies OR, so within
-- the tenant an INACTIVE template stays readable through the sibling. That is
-- not what this file could fix: narrowing the sibling would be an edit to the
-- general tenant policy of the table — the `brokerage_id IS NULL` escape family,
-- task #156, an owner ruling — and m394's discipline is that one migration does
-- not pre-empt another's ruling. What this file does is remove the ONLY route by
-- which a non-tenant principal reaches these rows at all. Whether `is_active`
-- should additionally hide inactive drafts from the tenant's own staff is a
-- product question, and it is named here rather than answered.
--
-- ── IS THERE A LEGITIMATE PUBLIC READER? ESTABLISHED BY READING ──────────────
--
-- The wave-22 § W22-2 two-axis test, run before narrowing anything:
--
--  · BROWSER-CLIENT AXIS. `offer_strategy_templates` appears in exactly one
--    non-script file in `app/` or `lib/`: `app/actions/buyer-offers.ts:411`.
--    There is no browser-client file that touches this table, so there is no
--    logged-out browser surface to break.
--  · SESSION-CLIENT-ON-A-LOGGED-OUT-ROUTE AXIS. The browser axis alone is not
--    sufficient — a session server client on a logged-out route runs as `anon`
--    too, which is the whole reason `tool_usage_sessions` is m394's carve-out.
--    That one reader is a `"use server"` action whose enclosing export
--    `getOrGenerateStrategyRecommendation` (line 340) builds its client with
--    `createServiceClient()` at line 362. `service_role` holds BYPASSRLS, so no
--    policy on this table is consulted for it at all — this policy is dead weight
--    to the only code that reads the table.
--  · AND THE TABLE HAS NO RUNTIME WRITER. `scripts/writerless-read-sweep.ts:33`
--    lists it under `SEEDED_REFERENCE`: rows arrive by migration or superadmin,
--    never from application code.
--
-- Conclusion: NO legitimate public reader exists. Nothing logged-out reads this
-- table today, and nothing in the tree could.
--
-- ── PREDICATE, NEVER A NAME ─────────────────────────────────────────────────
--
-- Construct-selected, m394/m396 house style: schema `public`, PERMISSIVE,
-- `polcmd = 'r'` (SELECT), `polroles` contains oid 0 (PUBLIC), USING exactly
-- `(is_active = true)`, and the table carries a live `brokerage_id` attribute. It
-- never looks at a policy name — a name-keyed migration would find whatever
-- happens to be spelled `Read active %` and miss every differently-named one,
-- which is the original mistake (believing a policy's name over its text) in a
-- new coat. A second policy of this shape arriving later is caught for the same
-- reason.
--
-- THE `brokerage_id` COLUMN QUALIFIER IS LOAD-BEARING, and it is m396's, for
-- m396's reason: `brokerage_id` is what this schema means by a tenant table. It
-- is what keeps this migration off `video_templates."Anyone can view active
-- templates"` — the ONE other policy on this database with the identical
-- `(is_active = true)` shape, on a table with NO `brokerage_id` column. That is
-- a platform video catalogue, not a tenant's playbook, and it is a separate
-- question with a separate answer that is NOT dispatchable under this one.
-- Measured: 2 policies carry the shape, 1 satisfies the tenant qualifier.
--
-- ── THE ASSERTION IS m399, AND THAT SPLIT IS THE POINT ──────────────────────
--
-- A `raise` rolls back its own transaction. Asserting in here would undo the
-- very narrowing this migration just made, so one stubborn policy would revert
-- the fix and leave the table exactly as open as before with a red migration as
-- the only difference — the same reason m393 is split from m392, m395 from m394
-- and m397 from m396. Split, this ALTER COMMITs and m399 fails afterwards on
-- whatever genuinely remains.
--
-- Expected at apply time, measured live before writing this file, and confirmed
-- by running this file inside `begin; … rollback;`:
--   1 policy qualifies → 1 rewritten, 0 kept.

do $$
declare
  pol       record;
  rewritten text[] := '{}';
  -- Exclusions. A policy that genuinely SHOULD publish a tenant's templates to
  -- the world must be named here with the logged-out call site that needs it,
  -- not silently spared with a `<>` — the same discipline m392, m394 and m396
  -- used. Empty, and the reading above is why: this table has one reader, it is
  -- a service client, and the table has no runtime writer at all. A carve-out
  -- that is not named is not a carve-out, it is the same defect with a new date
  -- on it.
  keep_world_readable text[] := '{}';
begin
  for pol in
    select p.polname,
           c.relname as tablename
    from   pg_policy p
    join   pg_class     c on c.oid = p.polrelid
    join   pg_namespace n on n.oid = c.relnamespace
    where  n.nspname = 'public'
      and  p.polpermissive                                       -- PERMISSIVE: it ORs
      and  p.polcmd = 'r'                                        -- FOR SELECT
      and  0 = any(p.polroles)                                   -- TO PUBLIC ⊇ anon
      and  coalesce(btrim(pg_get_expr(p.polqual, p.polrelid)), '') = '(is_active = true)'
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
    if (pol.tablename || '.' || pol.polname) = any(keep_world_readable) then
      raise notice 'm398: KEPT (named carve-out, has a real logged-out reader): %.%',
        pol.tablename, pol.polname;
      continue;
    end if;

    -- BOTH halves narrow, and both are needed. `TO authenticated` alone would
    -- leave every other brokerage reading; the USING alone would leave `anon`
    -- evaluating a predicate it can never satisfy, which is merely accidental
    -- safety. The `is_active = true` conjunct is CARRIED FORWARD, not dropped:
    -- the ruling is that active means published to the tenant, not that active
    -- stops meaning anything.
    --
    -- Both column references are guaranteed by the selection above: the USING
    -- expression IS `(is_active = true)`, and the `brokerage_id` attribute is
    -- required to exist and not be dropped.
    execute format(
      'alter policy %I on public.%I to authenticated '
      'using (is_active = true and (brokerage_id is null or brokerage_id = current_user_brokerage_id()))',
      pol.polname, pol.tablename);
    rewritten := rewritten || (pol.tablename || '.' || pol.polname);
  end loop;

  if array_length(rewritten, 1) is null then
    raise notice 'm398: nothing to narrow — no SELECT policy on a `brokerage_id` table grants `is_active = true` to PUBLIC.';
  else
    raise notice 'm398: tenant-scoped % world-readable `is_active = true` SELECT polic(ies) on tenant tables (role narrowed to `authenticated`, `is_active` kept as a conjunct): %',
      array_length(rewritten, 1), array_to_string(rewritten, ', ');
  end if;
end $$;
