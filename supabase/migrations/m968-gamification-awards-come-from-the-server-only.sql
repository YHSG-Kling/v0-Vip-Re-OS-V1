-- ── APPLIED LIVE 2026-11-18 via Supabase MCP (project hrvaqgvukzxfskkcrwbt) — wave 154, lane 154E ── read back: award_agent_points EXECUTE false for anon / authenticated; award_agent_points_once true for service_role only; agent_points_log has no INSERT policy; agent_badges is SELECT-only for authenticated; gamification_badges insert / update / delete are admin-scoped; trigger agents_gamification_points_server_only present; 0 agents whose total disagrees with the ledger
--
-- m968 — GAMIFICATION AWARDS COME FROM THE SERVER ONLY.
--
-- Wave 153 retired app/actions/gamification.ts addPoints (a public "use server" door that let a seat award itself
-- FIRST_CLOSE in a loop). The DATABASE kept four doors of the same shape open — measured LIVE on hrvaqgvukzxfskkcrwbt,
-- 2026-11-18, before this migration:
--   (1) public.award_agent_points() is EXECUTE-granted to `authenticated` (m484) and its session branch admits
--       `p_agent_id = current_user_agent_id()` — any agent seat can call it from the browser with the public anon key:
--       supabase.rpc('award_agent_points', { p_agent_id: <own>, p_points: 100000, p_reason: 'FIRST_CLOSE' }).
--   (2) policy agent_points_log_insert admits `agent_id = current_user_agent_id()` — a seat can write its own ledger rows,
--       which the period leaderboards (week / month) are computed from.
--   (3) policy agent_badges_tenant is FOR ALL with only a tenant predicate — any seat can insert, update or delete any
--       badge for anyone in its tenant.
--   (4) policy agents_update_own + the table UPDATE grant cover agents.gamification_points — an agent can overwrite its
--       own total, which is the number tier and badges are computed from.
--   (5) gamification_badges UPDATE / DELETE admit any tenant seat on PLATFORM rows (brokerage_id IS NULL) — a seat can set
--       a platform rung's required_points to 0.
-- Every app award path already runs on the SERVICE client (lib/kernel/event-reactor.ts → awardLifecycleMilestones,
-- app/actions/contact-reassignment.ts, lib/recruiting/challenge-runner.ts, app/actions/gamification.ts
-- checkAndAwardBadges + correctAgentPoints), so none of these doors is needed by the product.
--
-- Live state when written: 5 agents, 0 agent_points_log rows, 0 agent_badges rows, 0 agents whose total disagrees with
-- SUM(agent_points_log.points). Nothing to repair; this keeps it that way.

-- ─── (A) THE ONCE-AWARD, RACE-FREE ──────────────────────────────────────────
-- lib/gamification/award-points.ts awardAgentPointsOnce read the ledger, then awarded: two concurrent workers (a repeated
-- webhook, a retried emit) could both pass the read. Here the read happens under a transaction-scoped advisory lock on
-- (agent, reason, reference), so the twins serialize and the second sees the first's row. It DELEGATES to
-- award_agent_points() — the ONE writer of the total and the ledger row; this function writes nothing itself.
create or replace function public.award_agent_points_once(
  p_agent_id uuid,
  p_points integer,
  p_reason text,
  p_reference_type text default null,
  p_reference_id uuid default null,
  p_since timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_result jsonb;
begin
  if auth.uid() is not null then
    raise exception 'award_agent_points_once: points are awarded by the server on a verified event, never by a session';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(
    'award_agent_points_once:' || coalesce(p_agent_id::text, '') || ':' || coalesce(p_reason, '') || ':' || coalesce(p_reference_id::text, ''), 0));
  if exists (
    select 1 from public.agent_points_log
     where agent_id = p_agent_id
       and reason = p_reason
       and (p_reference_id is null or reference_id = p_reference_id)
       and (p_since is null or created_at >= p_since)
  ) then
    return jsonb_build_object('already_awarded', true, 'agent_id', p_agent_id);
  end if;
  v_result := public.award_agent_points(p_agent_id, p_points, p_reason, p_reference_type, p_reference_id);
  return v_result || jsonb_build_object('already_awarded', false);
end $$;

revoke all on function public.award_agent_points_once(uuid, integer, text, text, uuid, timestamptz) from public, anon, authenticated;
grant execute on function public.award_agent_points_once(uuid, integer, text, text, uuid, timestamptz) to service_role;

-- ─── (1) THE RPC IS SERVER-ONLY ─────────────────────────────────────────────
revoke execute on function public.award_agent_points(uuid, integer, text, text, uuid) from anon, authenticated;
grant execute on function public.award_agent_points(uuid, integer, text, text, uuid) to service_role;

-- ─── (2) NO SESSION WRITES INTO THE LEDGER ──────────────────────────────────
-- With no INSERT policy, RLS refuses every session insert; the service role bypasses RLS. UPDATE / DELETE stay
-- platform-admin only (agent_points_log_update / agent_points_log_delete, unchanged) — the ledger is append-only for
-- everyone else.
drop policy if exists agent_points_log_insert on public.agent_points_log;

-- ─── (3) BADGES ARE READ BY SEATS, WRITTEN BY THE SERVER ────────────────────
-- The read predicate is the old policy's, unchanged, so no signed-in surface loses a row it could see; `to authenticated`
-- closes the anon reach the old PUBLIC policy carried (scripts/rls-anon-tenant-escape-guard.ts).
drop policy if exists agent_badges_tenant on public.agent_badges;
drop policy if exists agent_badges_tenant_select on public.agent_badges;
create policy agent_badges_tenant_select on public.agent_badges
  for select to authenticated using ((brokerage_id is null) or (brokerage_id = public.current_user_brokerage_id()));

-- ─── (4) THE TOTAL MOVES ONLY THROUGH award_agent_points() ──────────────────
-- A column-level REVOKE cannot narrow a table-level UPDATE grant, so a trigger holds the column: a SESSION caller
-- (auth.uid() set) may not change gamification_points, and may only create an agents row at 0. The service role
-- (auth.uid() null) — which is how award_agent_points() now runs — passes.
create or replace function public.agents_gamification_points_server_only()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  if auth.uid() is null then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if coalesce(new.gamification_points, 0) <> 0 then
      raise exception 'agents.gamification_points starts at 0; points are awarded by the server on a verified event';
    end if;
  elsif new.gamification_points is distinct from old.gamification_points then
    raise exception 'agents.gamification_points moves only through award_agent_points() on a verified event';
  end if;
  return new;
end $$;

drop trigger if exists agents_gamification_points_server_only on public.agents;
create trigger agents_gamification_points_server_only
  before insert or update of gamification_points on public.agents
  for each row execute function public.agents_gamification_points_server_only();

-- ─── (5) THE BADGE CATALOG: tenant rows by a brokerage admin, platform rows by platform staff ──
drop policy if exists gamification_badges_tenant_insert on public.gamification_badges;
drop policy if exists gamification_badges_tenant_update on public.gamification_badges;
drop policy if exists gamification_badges_tenant_delete on public.gamification_badges;
create policy gamification_badges_tenant_insert on public.gamification_badges
  for insert to authenticated with check (
    ((brokerage_id = public.current_user_brokerage_id()) and public.is_brokerage_admin())
    or ((brokerage_id is null) and public.is_platform_admin()));
create policy gamification_badges_tenant_update on public.gamification_badges
  for update to authenticated using (
    ((brokerage_id = public.current_user_brokerage_id()) and public.is_brokerage_admin())
    or ((brokerage_id is null) and public.is_platform_admin()))
  with check (
    ((brokerage_id = public.current_user_brokerage_id()) and public.is_brokerage_admin())
    or ((brokerage_id is null) and public.is_platform_admin()));
create policy gamification_badges_tenant_delete on public.gamification_badges
  for delete to authenticated using (
    ((brokerage_id = public.current_user_brokerage_id()) and public.is_brokerage_admin())
    or ((brokerage_id is null) and public.is_platform_admin()));

-- READ-BACK (integrator, after applying):
--   select has_function_privilege('authenticated','public.award_agent_points(uuid,integer,text,text,uuid)','execute');      -- false
--   select has_function_privilege('service_role','public.award_agent_points_once(uuid,integer,text,text,uuid,timestamptz)','execute'); -- true
--   select policyname, cmd from pg_policies where tablename in ('agent_points_log','agent_badges','gamification_badges') order by 1;
--   select tgname from pg_trigger where tgrelid = 'public.agents'::regclass and tgname = 'agents_gamification_points_server_only';
--   select count(*) from agents a where coalesce(a.gamification_points,0) <> coalesce((select sum(points) from agent_points_log l where l.agent_id = a.id),0); -- 0
