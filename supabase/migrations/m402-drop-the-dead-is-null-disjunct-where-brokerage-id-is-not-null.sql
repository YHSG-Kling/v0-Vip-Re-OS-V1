-- m402 — #156, stratum A: remove the escape where it is PROVABLY DEAD.
--
-- ── THE OWNER RULING, AND WHY THIS IS THE SAFE THIRD OF IT ───────────────────
--
-- Task #156 resolves per table: 7 platform catalogues get a read-only global
-- grant, `api_response_logs` gets a platform-admin policy, and the
-- `brokerage_id IS NULL` escape is REMOVED everywhere else.
--
-- "Removed everywhere else" has a real hazard, and it is not the DDL. Removing
-- the disjunct from a `WITH CHECK` turns an unstamped INSERT into a REFUSAL —
-- and supabase-js RESOLVES a refusal, so a writer that does not destructure
-- `error` reports success over a row that never existed. That is the wave-26
-- class, and it is why this migration does NOT touch the nullable tables where
-- unstamped writers still exist.
--
-- It touches only the third where the question cannot arise.
--
-- ── WHY THIS IS A NO-OP, NOT A NARROWING ─────────────────────────────────────
--
-- On these 127 tables `brokerage_id` is **NOT NULL**. Therefore:
--
--   · USING — `brokerage_id IS NULL` is never true of an existing row, so the
--     disjunct admits nothing. It cannot be hiding a row from anyone.
--   · WITH CHECK — a NEW row carrying a NULL `brokerage_id` violates the NOT
--     NULL constraint regardless of RLS, so the disjunct cannot rescue a write.
--     Removing it changes WHICH error is raised, never WHETHER the write fails.
--
-- So this is a dead-branch deletion. It changes no visibility and no write
-- outcome. What it changes is that the schema stops *claiming* an escape it
-- does not have, which is what makes the remaining 196 nullable tables legible
-- as the real #156 surface instead of being lost in a population of 324.
--
-- ── MEASURED, NOT ASSUMED, AND THE SELECTION IS EXACT ────────────────────────
--
-- 507 policies across 127 tables qualify, and they are ONE SHAPE. Verified live
-- before writing this file:
--
--     total 507 · qual exact 381 + qual null 126 = 507
--               · with_check exact 252 + with_check null 255 = 507
--               · commands a,d,r,w — no FOR ALL
--
-- Every non-null expression is CHARACTER-IDENTICAL to
--     ((brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id()))
-- so the rewrite is a substitution of a known constant, not a parse. A policy
-- whose expression differs by one character is NOT matched and is left alone —
-- which is the point of comparing the whole string rather than pattern-hunting
-- for `IS NULL`.
--
-- THREE GUARDS ON THE SELECTION, each removing a way to be wrong:
--   1. `col.is_nullable = 'NO'` — the deadness argument depends entirely on this.
--   2. expression contains no `SELECT` — a `brokerage_id IS NULL` inside a
--      subquery refers to ANOTHER TABLE's column, whose nullability this
--      migration has not proven. `prospect_context` is exactly that case: it has
--      no `brokerage_id` of its own and inherits `prospects.brokerage_id IS NULL`
--      through an EXISTS. 11 such policies across 10 tables exist and are all
--      excluded here.
--   3. whole-string equality — see above.
--
-- ── THE ALTER IS BUILT PER COMMAND, BECAUSE POSTGRES REJECTS THE ALTERNATIVE ─
--
-- A SELECT or DELETE policy has no WITH CHECK and Postgres errors if you give it
-- one; an INSERT policy has no USING. So each statement names only the clauses
-- the policy actually has, read from the catalog rather than assumed from the
-- command. An UPDATE policy with a NULL with_check keeps it NULL — Postgres then
-- defaults it to the new USING, which is the same expression, so the behaviour
-- is unchanged there too.
--
-- The assertion is m403, split because a `raise` rolls back its own transaction.
-- Pre-rollout there is no data, but that is not what makes this safe: the NOT
-- NULL constraint is.

do $$
declare
  pol        record;
  rewritten  text[] := '{}';
  clauses    text;
  escape_expr constant text :=
    '((brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id()))';
  fixed_expr  constant text := '(brokerage_id = current_user_brokerage_id())';
begin
  for pol in
    select c.relname                                as tablename,
           p.polname,
           pg_get_expr(p.polqual, p.polrelid)       as q,
           pg_get_expr(p.polwithcheck, p.polrelid)  as wc
    from   pg_policy p
    join   pg_class     c on c.oid = p.polrelid
    join   pg_namespace n on n.oid = c.relnamespace
    join   information_schema.columns col
           on col.table_schema = 'public'
          and col.table_name   = c.relname
          and col.column_name  = 'brokerage_id'
    where  n.nspname = 'public'
      and  col.is_nullable = 'NO'                       -- GUARD 1: the disjunct is dead
      and  ( coalesce(pg_get_expr(p.polqual, p.polrelid), '')      = escape_expr
          or coalesce(pg_get_expr(p.polwithcheck, p.polrelid), '') = escape_expr )
      and  strpos(                                       -- GUARD 2: no subquery
             coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
             coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''),
             'SELECT') = 0
    order by c.relname, p.polname
  loop
    clauses := '';
    -- GUARD 3 is the equality below: only a clause that IS the known escape gets
    -- rewritten. A policy carrying the escape in one clause and something else
    -- in the other has only the escape clause touched.
    if pol.q = escape_expr then
      clauses := clauses || format(' using %s', fixed_expr);
    end if;
    if pol.wc = escape_expr then
      clauses := clauses || format(' with check %s', fixed_expr);
    end if;

    if clauses = '' then
      continue;
    end if;

    execute format('alter policy %I on public.%I%s', pol.polname, pol.tablename, clauses);
    rewritten := rewritten || (pol.tablename || '.' || pol.polname);
  end loop;

  if array_length(rewritten, 1) is null then
    raise notice 'm402: nothing to do — no policy on a NOT NULL brokerage_id column still carries the dead `brokerage_id IS NULL` disjunct.';
  else
    raise notice 'm402: removed the dead `brokerage_id IS NULL` disjunct from % polic(ies) on NOT NULL columns. No visibility and no write outcome changes: the column cannot be null, so the branch could never fire.',
      array_length(rewritten, 1);
  end if;
end $$;
