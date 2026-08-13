-- m410 — let CI ask the database which migrations it has actually run.
--
-- ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
--
-- Wave 27 found that m392 through m397 — the entire waves-20/22 RLS remediation
-- — had never been applied. They existed as files. Nothing in this repo applies
-- migrations: not the four workflows, not a `package.json` script. So "wrote the
-- migration" and "the database changed" were two different facts, and six waves
-- treated them as one. The live database still handed `anon` select/insert/
-- update/delete on every untenanted row of 324 tables the whole time those waves
-- were recorded as complete.
--
-- A guard cannot detect that from the filesystem. `supabase/migrations/*.sql`
-- looks identical whether or not anything ran. The only source of truth is
-- `supabase_migrations.schema_migrations`, and that schema is NOT exposed through
-- PostgREST — supabase-js can only reach exposed schemas, so a guard using the
-- service key still cannot read it directly.
--
-- Hence this RPC, following the EXACT pattern already established for
-- `live_schema_json()` (the nightly live-schema drift check's reader):
-- SECURITY DEFINER, owned by postgres, EXECUTE revoked from PUBLIC/anon/
-- authenticated and granted ONLY to service_role. Verified live before writing
-- this file — `live_schema_json` carries acl `postgres=X/postgres |
-- service_role=X/postgres` and nothing else.
--
-- ── WHAT IT DISCLOSES, AND WHY THAT IS ACCEPTABLE ────────────────────────────
--
-- Migration versions and names. No table data, no schema, no policy text. It is
-- reachable only by the service role, which by definition already bypasses RLS
-- entirely — so this grants a principal that can read everything the ability to
-- read something strictly smaller. The revokes are still explicit rather than
-- assumed, because Postgres grants EXECUTE to PUBLIC by default on new
-- functions and "I did not grant it" is not the same as "it is not granted".

create or replace function public.applied_migration_versions()
returns table (version text, name text)
language sql
security definer
set search_path = ''
as $$
  select m.version::text, m.name::text
  from   supabase_migrations.schema_migrations m
  order  by m.version
$$;

-- Postgres grants EXECUTE to PUBLIC by default. Take it back, then grant the one
-- principal that should have it. PUBLIC includes `anon`, the key shipped in the
-- browser bundle.
revoke all on function public.applied_migration_versions() from public;
revoke all on function public.applied_migration_versions() from anon;
revoke all on function public.applied_migration_versions() from authenticated;
grant  execute on function public.applied_migration_versions() to service_role;

comment on function public.applied_migration_versions() is
  'Service-role-only reader for supabase_migrations.schema_migrations. Exists so scripts/migration-ledger-guard.ts can prove that every migration FILE in supabase/migrations/ has actually been applied — the defect wave 27 found, where m392-m397 sat unapplied while six waves recorded them as done. Mirrors live_schema_json()''s grant posture.';
