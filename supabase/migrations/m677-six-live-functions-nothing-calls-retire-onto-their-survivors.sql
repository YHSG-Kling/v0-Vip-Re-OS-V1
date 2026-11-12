-- ── APPLIED LIVE 2026-09-30 via Supabase MCP apply_migration (project hrvaqgvukzxfskkcrwbt) ──
--
-- m677 — wave 91 lane 91A (census burn-down: the hidden-wire census's "not-yet-live slice of (d)").
--
-- THE FINDING. scripts/hidden-wire-census.ts reported 114 migration-defined functions no app
-- code calls through `.rpc()`, and set 111 of them aside as "not-yet-live" because their
-- defining migrations (033-061, before the status-banner convention) never state 'applied'.
-- Measured LIVE (project hrvaqgvukzxfskkcrwbt, 2026-09-30, pg_proc / pg_trigger / pg_policies /
-- other functions' bodies / CHECK constraints / column defaults / views):
--   · 111 of the 114 EXIST live — the "not-yet-live" label was a header artefact, not a fact;
--   · 98 of those have a SQL-internal caller (RLS predicate, trigger, another function);
--   · 7 are called by the proofs / cache generators from scripts/ (assert_tenant_isolation,
--     assert_cross_tenant_read_isolation, tenant_scope_facts, finance_authority_facts,
--     applied_migration_versions, live_foreign_keys_json, live_check_constraints_json) — live
--     doors by design (CLAUDE.md §1: unreferenced is not dead), KEPT;
--   · 3 are already gone (m598, m615, m621 dropped them) — the census could not see a later DROP;
--   · 6 exist live with NO caller of any kind — adjudicated below, each onto a named survivor.
--
-- THE SIX (CLAUDE.md §1 — every deletion names its survivor; none is dropped to move a number):
--
--   1. public.video_content_set_brokerage()      — BEFORE INSERT trigger fn of public.video_content.
--      The table left in m519 (video_content → video_assets); the trigger went with it, the
--      function did not. Survivor: public.video_assets (m519:66-67).
--   2. public.agent_achievements_set_brokerage() — trigger fn of public.agent_achievements, dropped in
--      m484:320 onto public.agent_badges (the one badge ledger). Survivor: public.agent_badges.
--   3. public.commission_records_set_brokerage() — trigger fn of public.commission_records (061), a
--      table that is not live and was never written; the P&L and earnings rollups read
--      public.agent_commissions (app/api/cron/brokerage-pl-rollup/route.ts:68-70,
--      app/api/cron/earnings-rollup/route.ts:67-70). Survivor: public.agent_commissions.
--   4. public.is_team_lead_role()                — `users.user_type = 'team_lead'`. m444 retired this
--      rule from every policy (a team lead is an AGENT who runs a team — teams.team_lead_id, CLAUDE.md
--      §4) and m445 asserts nothing gates on it. Survivor: public.current_user_led_team_id() (m444).
--   5. public.current_user_team_id()             — a one-line alias of
--      `public.resolve_team_id(auth.uid(), public.current_user_agent_id())` whose only callers were the
--      m440 team policies m444 replaced. Survivor: public.resolve_team_id(uuid, uuid) (m431, THE ONE
--      team rule), called with exactly that argument pair.
--   6. public.current_user_contact_id()          — `contacts.contact_user_id = auth.uid() LIMIT 1`: an
--      unordered pick of ONE of a portal user's contact rows (a client seat can front more than one).
--      Every contact-seat policy asks the per-row question instead. Survivor: public.is_self_contact(uuid)
--      (033), which is referenced by live policies.
--
-- All six are EXECUTE-granted to anon + authenticated, so each was a callable surface with no purpose.
-- RESTRICT (the default) — if anything the live read missed depends on one of them, the DROP refuses and
-- the migration fails closed rather than cascading a policy away.

begin;

do $$
declare dep int;
begin
  -- Re-assert the live read at apply time: no policy / trigger / other function names any of the six.
  select count(*) into dep
  from   pg_policies po
  where  coalesce(po.qual, '') || coalesce(po.with_check, '')
         ~ '\m(is_team_lead_role|current_user_team_id|current_user_contact_id|video_content_set_brokerage|agent_achievements_set_brokerage|commission_records_set_brokerage)\M';
  if dep > 0 then
    raise exception 'm677: % live polic(ies) still call one of the six functions — adjudicate before dropping', dep;
  end if;

  select count(*) into dep
  from   pg_trigger t join pg_proc p on p.oid = t.tgfoid
  where  not t.tgisinternal
    and  p.proname in ('video_content_set_brokerage', 'agent_achievements_set_brokerage', 'commission_records_set_brokerage');
  if dep > 0 then
    raise exception 'm677: % trigger(s) still execute a retired table''s set_brokerage function', dep;
  end if;

  select count(*) into dep
  from   pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where  n.nspname = 'public'
    and  p.proname not in ('is_team_lead_role', 'current_user_team_id', 'current_user_contact_id')
    and  p.prosrc ~ '\m(is_team_lead_role|current_user_team_id|current_user_contact_id)\M';
  if dep > 0 then
    raise exception 'm677: % function bod(ies) still call a retired helper', dep;
  end if;
end $$;

drop function if exists public.video_content_set_brokerage();
drop function if exists public.agent_achievements_set_brokerage();
drop function if exists public.commission_records_set_brokerage();
drop function if exists public.is_team_lead_role();
drop function if exists public.current_user_team_id();
drop function if exists public.current_user_contact_id();

-- The survivors stay (fail closed if a survivor is missing — the tombstones above would lie).
do $$
begin
  if to_regprocedure('public.current_user_led_team_id()') is null
     or to_regprocedure('public.resolve_team_id(uuid, uuid)') is null
     or to_regprocedure('public.is_self_contact(uuid)') is null
     or to_regclass('public.video_assets') is null
     or to_regclass('public.agent_badges') is null
     or to_regclass('public.agent_commissions') is null then
    raise exception 'm677: a named survivor is missing — refusing';
  end if;
end $$;

commit;
