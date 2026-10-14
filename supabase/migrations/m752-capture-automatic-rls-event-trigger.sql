-- ── APPLIED LIVE 2026-10-08 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — live function verified byte-identical, ensure_rls already enabled; the COMMENT was the only change ──
--
-- m752 — CAPTURE the automatic new-table RLS backstop that exists ONLY in the live database
-- (wave 139, lane 139E). Owner, wave 139 "approve all" (1): "automatic new-table RLS captured in
-- an idempotent migration".
--
-- WHY: every public table on the live project has RLS on (767/767, read 2026-10-08) because the
-- event trigger `ensure_rls` (ddl_command_end on CREATE TABLE / CREATE TABLE AS / SELECT INTO)
-- runs public.rls_auto_enable(), which ENABLEs row level security on each new table in `public`.
-- No repo file created either object (finding R-1, wave 138F), so a rebuilt environment would lose
-- RLS-by-default and every new table would be readable through the anon/authenticated API.
--
-- SOURCE: read from the live catalog 2026-10-08 (Supabase MCP, read-only):
--   pg_event_trigger: evtname=ensure_rls, evtevent=ddl_command_end, evtenabled=O, owner postgres,
--                     evttags={CREATE TABLE, CREATE TABLE AS, SELECT INTO}, fn rls_auto_enable()
--   pg_get_functiondef(public.rls_auto_enable): reproduced byte-for-byte below (SECURITY DEFINER,
--                     search_path pg_catalog, owner postgres).
--
-- WHAT IT DOES NOT DO: it grants nothing and creates no policy. A table this trigger touches gets
-- RLS ENABLED WITH NO POLICY — deny-all to anon/authenticated until a later migration writes a
-- tenant-scoped policy. Existing tables and existing policies are untouched. No DROP statement
-- (the MCP holds standalone DROPs for the owner): the function is CREATE OR REPLACE, and the event
-- trigger is created only when pg_event_trigger has no `ensure_rls` row (re-enabled if disabled).
--
-- IDEMPOTENT: applying it to the live project is a no-op (same function body; trigger present).
-- Two parts, each safe alone: PART 1 the function, PART 2 the event trigger.

-- ── PART 1 — the function (live definition) ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.rls_auto_enable()
 RETURNS event_trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog'
AS $function$
DECLARE
  cmd record;
BEGIN
  FOR cmd IN
    SELECT *
    FROM pg_event_trigger_ddl_commands()
    WHERE command_tag IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      AND object_type IN ('table','partitioned table')
  LOOP
     IF cmd.schema_name IS NOT NULL AND cmd.schema_name IN ('public') AND cmd.schema_name NOT IN ('pg_catalog','information_schema') AND cmd.schema_name NOT LIKE 'pg_toast%' AND cmd.schema_name NOT LIKE 'pg_temp%' THEN
      BEGIN
        EXECUTE format('alter table if exists %s enable row level security', cmd.object_identity);
        RAISE LOG 'rls_auto_enable: enabled RLS on %', cmd.object_identity;
      EXCEPTION
        WHEN OTHERS THEN
          RAISE LOG 'rls_auto_enable: failed to enable RLS on %', cmd.object_identity;
      END;
     ELSE
        RAISE LOG 'rls_auto_enable: skip % (either system schema or not in enforced list: %.)', cmd.object_identity, cmd.schema_name;
     END IF;
  END LOOP;
END;
$function$;

COMMENT ON FUNCTION public.rls_auto_enable() IS
  'Event-trigger backstop: ENABLE ROW LEVEL SECURITY on every new table in public (no policy, no grant). Captured from live by m752 (wave 139E).';

-- ── PART 2 — the event trigger, created only if absent (no DROP) ─────────────────────────────
DO $m752$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtname = 'ensure_rls') THEN
    CREATE EVENT TRIGGER ensure_rls
      ON ddl_command_end
      WHEN TAG IN ('CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO')
      EXECUTE FUNCTION public.rls_auto_enable();
  ELSIF EXISTS (SELECT 1 FROM pg_catalog.pg_event_trigger WHERE evtname = 'ensure_rls' AND evtenabled = 'D') THEN
    ALTER EVENT TRIGGER ensure_rls ENABLE;
  END IF;
END
$m752$;

-- POSTCONDITION (read-only; run after apply):
--   SELECT evtname, evtevent, evtenabled, evttags, evtfoid::regprocedure FROM pg_event_trigger WHERE evtname = 'ensure_rls';
--     → 1 row: ddl_command_end, O, {CREATE TABLE,CREATE TABLE AS,SELECT INTO}, rls_auto_enable()
--   SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--    WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND NOT c.relrowsecurity;   → 0
