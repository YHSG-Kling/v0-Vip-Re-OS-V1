-- m392 — every policy that grants ALL to PUBLIC, whatever it is named.
--
-- ── WHAT WAS FOUND ───────────────────────────────────────────────────────────
--
-- scripts/330-create-client-portal-collaborative-features.sql:217-226 declares,
-- under the comment "Simplified RLS policies - service role has full access,
-- authenticated users can read":
--
--     CREATE POLICY "Service role full access <t>" ON <t> FOR ALL USING (true);
--
-- on nine tables. The NAME says service role. The policy does not.
--
--   · There is no `TO` clause, so it applies to PUBLIC — including `anon` and
--     `authenticated`.
--   · `FOR ALL` is SELECT, INSERT, UPDATE and DELETE.
--   · `USING (true)` is every row in every tenant.
--   · The name is decorative. Postgres does not read policy names, and the
--     service role never needed a policy at all: it BYPASSES RLS. So the one
--     principal the name mentions is the only one it grants nothing to.
--
-- AND RLS POLICIES ARE PERMISSIVE BY DEFAULT, WHICH MEANS THEY *OR* TOGETHER. A
-- live `USING (true)` policy does not sit politely beside a correct one — it
-- makes the correct one decorative. Two of those nine are the buyer portal's own
-- record: `client_portal_activity` (the engagement ledger whose careful
-- four-branch SELECT policy wave 15 spent a slice reasoning about) and
-- `client_portal_messages` (the buyer's message thread).
--
-- ── THEN THE MEASUREMENT, WHICH CHANGED THE SHAPE OF THE FIX ─────────────────
--
-- 330 is not special. The same construct appears **173 times across 42 legacy
-- `scripts/*.sql` files.** It was a house convention.
--
-- The relief, and it is the important half: **`supabase/migrations/` contains
-- ZERO of them.** The corpus that is actually applied to this project is clean;
-- every one of the 173 lives in the legacy `scripts/` corpus, which has no
-- runner in `package.json` and is invoked by nothing. So the likely state is
-- that none of this is live.
--
-- "Likely" is not a security control, and the files cannot settle it —
-- `CREATE TABLE IF NOT EXISTS` is a no-op against an existing table while the
-- `CREATE POLICY` lines after it are NOT conditional, so a partial hand-run of
-- any of those 42 files leaves exactly the state this migration is written for.
-- The Supabase connection was timing out on every query including `select 1`
-- while this was written, so the live check could not be made first.
--
-- It does not need to be. The answer does not change the action, and the action
-- is a no-op if the answer is "clean". **So this asks the database at apply time
-- instead of asking me** — and it asks about the CONSTRUCT across the whole
-- schema rather than about a list of table names I happened to enumerate, since
-- a hardcoded list would only ever be as complete as my grep.
--
-- ── IT REFUSES TO LOCK ANYONE OUT ────────────────────────────────────────────
--
-- Dropping a table's ONLY policy denies every non-service caller. That is the
-- opposite failure and it is just as real — and some of the 67 tables have no
-- policy DDL anywhere else in this tree, so the bad policy may be all they have.
--
-- So each policy is judged on what else is on its table:
--
--   · other policies exist → DROP. They become load-bearing again.
--   · it is the ONLY policy → DO NOT DROP. Record it, and let m393 fail on it.
--
-- The drops COMMIT; the refusal is raised by the separate assertion migration
-- m393 rather than here, deliberately: raising here would roll back the safe
-- drops along with it, so a single table needing a replacement policy would
-- block every table that did not.
--
-- Pre-rollout every one of these tables is EMPTY, so nothing here can lose data.

do $$
declare
  pol            record;
  other_count    int;
  dropped        text[] := '{}';
  only_policy    text[] := '{}';
  -- Named exclusions go here. A policy that genuinely SHOULD grant ALL to PUBLIC
  -- must be named, not silently spared — the same discipline m390 used for the
  -- two tables whose column class it could not prove. Empty, and it should stay
  -- empty: `FOR ALL` includes INSERT/UPDATE/DELETE, which no public reference
  -- table has any business granting to `anon`.
  keep           text[] := '{}';
begin
  for pol in
    select p.polname,
           p.polrelid,
           c.relname as tablename
    from   pg_policy p
    join   pg_class     c on c.oid = p.polrelid
    join   pg_namespace n on n.oid = c.relnamespace
    where  n.nspname = 'public'
      and  p.polpermissive                                     -- PERMISSIVE: it ORs
      and  p.polcmd = '*'                                      -- FOR ALL
      and  coalesce(btrim(pg_get_expr(p.polqual, p.polrelid)), '') = 'true'
      and  (
             0 = any(p.polroles)                               -- TO PUBLIC
             or exists (
               select 1 from pg_roles r
               where  r.oid = any(p.polroles)
                 and  r.rolname in ('anon', 'authenticated')
             )
           )
    order by c.relname, p.polname
  loop
    if (pol.tablename || '.' || pol.polname) = any(keep) then
      continue;
    end if;

    select count(*) into other_count
    from   pg_policy p2
    where  p2.polrelid = pol.polrelid
      and  p2.polname <> pol.polname;

    if other_count = 0 then
      only_policy := only_policy || (pol.tablename || '.' || pol.polname);
    else
      execute format('drop policy %I on public.%I', pol.polname, pol.tablename);
      dropped := dropped || (pol.tablename || '.' || pol.polname);
    end if;
  end loop;

  if array_length(dropped, 1) is null and array_length(only_policy, 1) is null then
    raise notice 'm392: no permissive ALL-to-PUBLIC policy exists in schema public. The legacy scripts/*.sql RLS blocks never applied here.';
  end if;

  if array_length(dropped, 1) is not null then
    raise notice 'm392: dropped % ALL-to-PUBLIC polic(ies): %',
      array_length(dropped, 1), array_to_string(dropped, ', ');
  end if;

  if array_length(only_policy, 1) is not null then
    raise warning 'm392: LEFT IN PLACE (each is the ONLY policy on its table, so dropping it would deny every non-service caller): %. Each needs a tenant-scoped replacement policy written deliberately; m393 FAILS until they are gone.',
      array_to_string(only_policy, ', ');
  end if;
end $$;
