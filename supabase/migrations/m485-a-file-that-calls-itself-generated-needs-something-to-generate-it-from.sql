-- m485 — let the schema cache be generated from the schema.
--
-- ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
--
-- Three files in scripts/ describe this database and every schema guard in the
-- repo reads them: schema-snapshot.ts (columns), schema-fk-map.ts (foreign keys),
-- check-vocabularies.ts (CHECK vocabularies). They are committed for one reason —
-- CI holds no database credentials, and without them the guards go blind. They are
-- a CACHE of the database, not a second opinion about it.
--
-- Two of the three carried a "GENERATED from the live database — do not hand-edit"
-- banner and had NO GENERATOR ANYWHERE. check-vocabularies.ts did not even document
-- the SQL. So the only way to update either was the hand-edit the banner forbade,
-- and both had drifted:
--
--   schema-fk-map.ts        6 edges wrong — three FK columns on tables m480/m484
--                           dropped (buyer_tours, agent_achievements), three on
--                           tables m479/m481 added (ai_overage_invoices,
--                           tenant_contract_signatures, platform_contract_templates)
--   check-vocabularies.ts   13 columns wrong, and its own header advertised
--                           428 tables / 730 columns while the file held 427 / 736
--
-- A banner nobody can obey is worse than none: it tells the next reader the file
-- can be trusted. This migration supplies what was missing on the DATABASE side —
-- a way for a credentialed script to read the metadata at all.
--
-- ── WHY AN RPC AND NOT A QUERY ───────────────────────────────────────────────
--
-- PostgREST exposes only the schemas it is configured to expose, and supabase-js
-- `.from()` can reach nothing else. `pg_constraint`, `pg_class` and `pg_attribute`
-- live in `pg_catalog`; `information_schema` is its own schema. None is reachable,
-- so a generator holding the SERVICE ROLE KEY still could not read a single foreign
-- key. That is the same wall m410 hit reading supabase_migrations, and it takes the
-- same door.
--
-- `public.live_schema_json()` already opened it for COLUMNS (l72-s14) and the
-- nightly scripts/check-live-schema-drift.ts has read through it since. These two
-- functions complete the set — foreign keys and CHECK constraints — so every cache
-- file has one live source apiece and none of them needs a human with a SQL console.
-- (The fourth, scripts/live-tables.ts, needs no function of its own: the full relation
-- list is the key set of live_schema_json()'s answer, which the snapshot generator was
-- already reading and discarding.) Both mirror live_schema_json()'s posture exactly, verified live before
-- this file was written: SECURITY DEFINER, owned by postgres, acl
-- `postgres=X/postgres | service_role=X/postgres` and nothing else.
--
-- ── THE RAW FACTS CROSS THE WIRE, NOT A CONCLUSION ───────────────────────────
--
-- Neither function aggregates into the shape the committed file takes. FK rows come
-- back as edges and constraint rows as `pg_get_constraintdef` text, because the
-- rules built on top of them belong to the repo, in scripts/schema-cache-builders.ts,
-- where they are reviewable in a pull request and fixable without DDL:
--
--   * which CHECK shapes count as a "vocabulary" (a fixed set of text values —
--     including the nullable variants and the single-value equality form, excluding
--     ranges, lengths, cross-column rules and integer sets)
--   * how FK edges become both the column→table map and the per-table-pair
--     cardinality that predicts PostgREST's PGRST201 ambiguity refusal
--
-- Aggregating in SQL would have frozen those judgements inside the database, where
-- changing one costs a migration. It also lets the drift guard rebuild the file in
-- memory from the same reading the generator used, so the two can never disagree
-- about what the file should have said.
--
-- ── WHAT THIS DISCLOSES, AND WHY THAT IS ACCEPTABLE ──────────────────────────
--
-- Schema metadata: table names, column names, foreign keys, CHECK predicates. NO
-- TENANT ROWS — neither function reads a single application table, both are
-- read-only, and `stable` says so to the planner.
--
-- Still, the grant is service_role only, and deliberately so. The service role
-- already bypasses RLS entirely, so this hands a principal that can read every row
-- the ability to read something strictly smaller — nothing is widened. `anon` is a
-- different matter: it ships in the browser bundle, and the FK graph plus every
-- CHECK predicate is a free map of the write surface for anyone probing it. The
-- revokes below are explicit rather than assumed, because Postgres grants EXECUTE to
-- PUBLIC by default on a new function and "I did not grant it" is not the same fact
-- as "it is not granted".

-- ── 1. FOREIGN KEYS ─────────────────────────────────────────────────────────
-- One row per (constraint, constrained column) inside `public`. Foreign keys whose
-- TARGET leaves public (auth.users and friends) are excluded: PostgREST cannot embed
-- across that boundary, so an edge to it would only add noise to a map whose whole
-- job is resolving embeds.
create or replace function public.live_foreign_keys_json()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'src_table', src_table,
           'src_col',   src_col,
           'tgt_table', tgt_table,
           'name',      name
         ) order by src_table, src_col, name), '[]'::jsonb)
  from (
    select src.relname::text  as src_table,
           a.attname::text    as src_col,
           tgt.relname::text  as tgt_table,
           c.conname::text    as name
    from   pg_catalog.pg_constraint c
    join   pg_catalog.pg_class     src on src.oid = c.conrelid
    join   pg_catalog.pg_namespace sn  on sn.oid  = src.relnamespace
    join   pg_catalog.pg_class     tgt on tgt.oid = c.confrelid
    join   pg_catalog.pg_namespace tn  on tn.oid  = tgt.relnamespace
    join   unnest(c.conkey) as k(attnum) on true
    join   pg_catalog.pg_attribute a on a.attrelid = src.oid and a.attnum = k.attnum
    where  c.contype = 'f'
      and  sn.nspname = 'public'
      and  tn.nspname = 'public'
  ) t;
$$;

revoke all    on function public.live_foreign_keys_json() from public;
revoke all    on function public.live_foreign_keys_json() from anon;
revoke all    on function public.live_foreign_keys_json() from authenticated;
grant  execute on function public.live_foreign_keys_json() to service_role;

comment on function public.live_foreign_keys_json() is
  'Service-role-only reader for the public-schema foreign-key graph, one row per (constraint, constrained column). Exists so scripts/generate-schema-fk-map.ts can regenerate scripts/schema-fk-map.ts from the live database instead of a human hand-editing a file whose banner said it was generated. pg_constraint is not reachable through PostgREST, so this is the only door. Mirrors live_schema_json()''s grant posture.';

-- ── 2. CHECK CONSTRAINTS ────────────────────────────────────────────────────
-- Single-column CHECKs only, with the constrained column resolved from conkey[1] and
-- the predicate handed over as text. Multi-column CHECKs are not vocabularies of one
-- column's literals and there is nothing for a source-literal guard to compare them
-- against.
create or replace function public.live_check_constraints_json()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'table',  tbl,
           'column', col,
           'name',   name,
           'def',    def
         ) order by tbl, col, name), '[]'::jsonb)
  from (
    select r.relname::text                          as tbl,
           a.attname::text                          as col,
           con.conname::text                        as name,
           pg_catalog.pg_get_constraintdef(con.oid)  as def
    from   pg_catalog.pg_constraint con
    join   pg_catalog.pg_class     r  on r.oid = con.conrelid
    join   pg_catalog.pg_namespace n  on n.oid = r.relnamespace
    join   pg_catalog.pg_attribute a  on a.attrelid = r.oid and a.attnum = con.conkey[1]
    where  con.contype = 'c'
      and  n.nspname = 'public'
      and  r.relkind in ('r', 'p')
      and  array_length(con.conkey, 1) = 1
  ) t;
$$;

revoke all    on function public.live_check_constraints_json() from public;
revoke all    on function public.live_check_constraints_json() from anon;
revoke all    on function public.live_check_constraints_json() from authenticated;
grant  execute on function public.live_check_constraints_json() to service_role;

comment on function public.live_check_constraints_json() is
  'Service-role-only reader for every single-column CHECK constraint in public, as raw pg_get_constraintdef text. Exists so scripts/generate-check-vocabularies.ts can regenerate scripts/check-vocabularies.ts from the live database — that file declared itself generated, had no generator and no documented SQL, and was hand-edited anyway. The predicate is returned unparsed on purpose: which shapes count as a vocabulary is a rule the repo owns (scripts/schema-cache-builders.ts). Mirrors live_schema_json()''s grant posture.';

-- ── POSTCONDITIONS ──────────────────────────────────────────────────────────
-- Both functions exist, are read-only, are SECURITY DEFINER, are reachable by
-- service_role and by NOBODY else, and return the shape the generators parse. The
-- element counts are asserted against the same catalog scan the functions run, so a
-- silently-empty result cannot pass for a healthy one.
select 'fn_exists',
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('live_foreign_keys_json', 'live_check_constraints_json'))
union all
select 'fn_security_definer_and_stable',
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('live_foreign_keys_json', 'live_check_constraints_json')
           and p.prosecdef and p.provolatile = 's')
union all
select 'fn_acl_matches_live_schema_json',
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('live_foreign_keys_json', 'live_check_constraints_json')
           and array_to_string(p.proacl, ' | ') = 'postgres=X/postgres | service_role=X/postgres')
union all
select 'anon_cannot_execute',
       (select count(*)::text from pg_proc p join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname in ('live_foreign_keys_json', 'live_check_constraints_json')
           and (has_function_privilege('anon', p.oid, 'EXECUTE')
             or has_function_privilege('authenticated', p.oid, 'EXECUTE')))
union all
select 'fk_rows',
       jsonb_array_length(public.live_foreign_keys_json())::text
union all
select 'fk_rows_expected',
       (select count(*)::text
        from pg_constraint c
        join pg_class src on src.oid = c.conrelid
        join pg_namespace sn on sn.oid = src.relnamespace
        join pg_class tgt on tgt.oid = c.confrelid
        join pg_namespace tn on tn.oid = tgt.relnamespace
        join unnest(c.conkey) as k(attnum) on true
        where c.contype = 'f' and sn.nspname = 'public' and tn.nspname = 'public')
union all
select 'fk_shape',
       (select string_agg(k, ',' order by k)
        from jsonb_object_keys(public.live_foreign_keys_json() -> 0) k)
union all
select 'check_rows',
       jsonb_array_length(public.live_check_constraints_json())::text
union all
select 'check_rows_expected',
       (select count(*)::text
        from pg_constraint con
        join pg_class r on r.oid = con.conrelid
        join pg_namespace n on n.oid = r.relnamespace
        where con.contype = 'c' and n.nspname = 'public'
          and r.relkind in ('r','p') and array_length(con.conkey,1) = 1)
union all
select 'check_shape',
       (select string_agg(k, ',' order by k)
        from jsonb_object_keys(public.live_check_constraints_json() -> 0) k);

-- Expected, against the schema as measured on 2026-08-19:
--   fn_exists                        2
--   fn_security_definer_and_stable   2
--   fn_acl_matches_live_schema_json  2
--   anon_cannot_execute              0
--   fk_rows / fk_rows_expected       1778 / 1778
--   fk_shape                         name,src_col,src_table,tgt_table
--   check_rows / check_rows_expected 881 / 881
--   check_shape                      column,def,name,table
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ──────────────────────────────────────
--   * It does not replace public.live_schema_json(). That function already reads the
--     columns, the nightly drift check already goes through it, and rewriting a
--     working reader to match a naming scheme is churn.
--   * It does not aggregate into the committed files' shape. See above — those rules
--     live in the repo so changing one is a pull request, not a migration.
--   * It does not grant anything to `authenticated`. No product surface reads schema
--     metadata; the only callers are the generators and the drift guard, and both
--     run with the service key.
