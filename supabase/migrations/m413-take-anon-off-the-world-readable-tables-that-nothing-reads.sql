-- m413 — `FOR SELECT USING (true)` to PUBLIC: the class no sweep ever covered.
--
-- ── THE GAP ──────────────────────────────────────────────────────────────────
--
-- Three earlier sweeps each took a slice of "granted to PUBLIC" and none took
-- this one:
--
--   m392/m393  FOR ALL      USING (true)      TO PUBLIC   → dropped
--   m394/m395  the tenant escape                          → narrowed
--   m396/m404  FOR INSERT   WITH CHECK (true) TO PUBLIC   → narrowed
--   …and nobody ever swept  FOR SELECT USING (true) TO PUBLIC.
--
-- There are 25. `anon` — the key shipped in the browser bundle — can read every
-- row of all of them.
--
-- ── WHAT THIS IS AND IS NOT ──────────────────────────────────────────────────
--
-- Measured before writing, so the severity is honest rather than alarming:
-- **none of the 25 tables carries a `brokerage_id`.** This is world-readable
-- PLATFORM data, NOT cross-tenant leakage. Nobody's tenant rows are exposed.
--
-- The owner ruling in play is wave 28's — "playbooks should not be published to
-- the internet". That was applied to `offer_strategy_templates`, the negotiation
-- playbooks, and never to the table literally called `playbooks`. Stated plainly:
-- `playbooks` holds 8 seed rows whose `content` column is NULL on every one, so
-- what is exposed today is a list of generic titles ("New Lead Follow-up",
-- "Pre-Closing Checklist"), not the IP the ruling protects. It is worth closing
-- anyway — it costs nothing, and the moment someone writes real content into
-- that column the exposure becomes the thing the ruling is about.
--
-- ── A NAMED LIST, NOT THE CONSTRUCT, AND THAT IS DELIBERATE ──────────────────
--
-- This repo's discipline is to assert the CONSTRUCT rather than a list, because
-- a list is only ever as complete as the query that built it. Here the construct
-- is deliberately NOT swept, and the reason matters:
--
-- A server-side reader on a LOGGED-OUT route runs as `anon` too. Narrowing a
-- table that feeds a public pricing page would break it, and `subscription_tiers`
-- (13 readers), `platform_settings` (11), `market_rate_snapshots` (5) and
-- `scripts` (4) are exactly that shape. Clearing them means reading each call
-- site and establishing whether its route carries a session — a real census, and
-- rushing it is how a public page breaks quietly.
--
-- So this migration narrows ONLY the tables with **zero readers anywhere** in
-- `app/`, `lib/`, `components/` and `services/`. Nothing calls them, so nothing
-- can break. Each is named with its measured reader count, and the remaining 17
-- are left for the census rather than swept on an assumption.

do $$
declare
  pol             record;
  narrowed        text[] := '{}';
  -- Zero readers in app/ lib/ components/ services/ — verified by grep for
  -- `.from("<table>")` before this file was written. Narrowing these cannot
  -- break a caller because there is no caller.
  --   ai_prompt_templates   0 readers, 0 rows
  --   demo_persona_contacts 0 readers, 0 rows
  --   journey_tools         0 readers
  --   long_form_videos      0 readers, 0 rows
  --   marketing_stats       0 readers, 0 rows
  --   playbooks             0 readers, 8 rows (content NULL on every row)
  --   transparency_videos   0 readers, 0 rows
  --   user_roles            0 readers, 0 rows
  unreferenced    text[] := array[
    'ai_prompt_templates', 'demo_persona_contacts', 'journey_tools',
    'long_form_videos', 'marketing_stats', 'playbooks',
    'transparency_videos', 'user_roles'
  ];
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
      and  c.relname = any(unreferenced)
    order by c.relname, p.polname
  loop
    -- TO only. The expression is not this migration's business: `USING (true)`
    -- is correct for a platform reference table read by every signed-in tenant;
    -- what was wrong is WHO could read it.
    execute format('alter policy %I on public.%I to authenticated',
                   pol.polname, pol.tablename);
    narrowed := narrowed || (pol.tablename || '.' || pol.polname);
  end loop;

  if array_length(narrowed, 1) is null then
    raise notice 'm413: nothing to narrow — no unreferenced table still grants SELECT-true to PUBLIC.';
  else
    raise notice 'm413: narrowed % world-readable SELECT polic(ies) on tables nothing reads: %',
      array_length(narrowed, 1), array_to_string(narrowed, ', ');
  end if;
end $$;
