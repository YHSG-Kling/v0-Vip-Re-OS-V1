-- m465 — A GRAIN GATE THAT LIVES ONLY IN APP CODE IS NOT A GRAIN GATE
--
-- subscriber_service_areas holds THREE simultaneously-true facts on one zip:
--   brokerage grain (team_id NULL, agent_user_id NULL) — the ONLY grain the
--     platform lead rotation reads (lib/platform/distribution-engine.ts step 6)
--   team grain      (team_id set)
--   agent grain     (agent_user_id set)
--
-- MEASURED BEFORE WRITING — all four policies were tenant-scoped and NOTHING
-- ELSE:
--   subscriber_service_areas_tenant_select  USING       brokerage_id = current_user_brokerage_id()
--   subscriber_service_areas_tenant_insert  WITH CHECK  brokerage_id = current_user_brokerage_id()
--   subscriber_service_areas_tenant_update  USING + WC  brokerage_id = current_user_brokerage_id()
--   subscriber_service_areas_tenant_delete  USING       brokerage_id = current_user_brokerage_id()
--
-- So ANY authenticated user in the tenant could write ANY grain. That is not
-- only "an agent could claim brokerage-wide coverage". MEASURED on the live
-- users table, the tenant's authenticated population includes user_type
-- 'contact' (4), 'vendor' (2) and 'lender' (2) — a CLIENT could file a
-- brokerage-wide territory claim and change which agent the platform routes
-- leads to. The grain gate existed, correctly, in app code
-- (app/dashboard/settings/territories/territory-rules.ts:authorizeTerritoryWrite),
-- INSIDE the database boundary but not AT it, and the previous entry said so
-- rather than implying the table was protected.
--
-- ── THIS MIRRORS THE APP RULE, IT DOES NOT INVENT A SECOND ONE ──────────────
-- authorizeTerritoryWrite, verbatim in behaviour:
--   brokerage admin  → may write every grain
--   brokerage grain  → admin only
--   team grain       → target.teamId must be a team the caller LEADS
--   agent grain      → target.agentUserId must BE the caller
-- and grainOf() classifies agent_user_id FIRST, then team_id, else brokerage —
-- so a row carrying both is an AGENT row, and the predicate below is ordered to
-- match. Two definitions of one rule is how they drift apart; this one is
-- written to be checkable against that file.
--
-- ── WHY NOT current_user_led_team_id() ──────────────────────────────────────
-- It exists, it is SECURITY DEFINER, and it would have been the obvious call.
-- It ends `limit 1`. MEASURED: teams has NO unique index on team_lead_id, so
-- nothing stops one person leading two teams — and the app already models this
-- as a LIST (`viewer.ledTeamIds.includes(...)`, plural). Keyed on that helper,
-- a lead of two teams would be silently REFUSED on their second team: zero rows,
-- error null, the app reporting success. This uses an EXISTS against teams
-- instead, which is correct however many teams the caller leads. The helper is
-- left alone — its `limit 1` is reported here, not quietly changed underneath
-- its other callers.
--
-- ── WHY THE ADMIN TEST IS NOT JUST is_brokerage_admin() ─────────────────────
-- is_brokerage_admin() reads users.user_type IN ('admin','broker','broker_owner').
-- The app's requireBrokerageAdmin admits that set AND a tenant role GRANT in
-- user_role_assignments, deliberately ("Merged forward rather than dropped").
-- MEASURED: agent1@yourbrokerage.com is user_type 'agent' and holds an 'admin'
-- GRANT on brokerage 231f4e64 — a real account the app admits today and that
-- the tenant-only policy lets through. Keying this gate on is_brokerage_admin()
-- alone would have REGRESSED that account into a silent zero-row refusal — the
-- precise failure this migration exists to end, introduced by the fix for it.
-- So the grant is tested here too.
--
-- REPORTED, NOT CHANGED HERE: is_brokerage_admin() misses that grant for every
-- one of its callers, and it is referenced by 60+ policies across this database.
-- Correcting it is a platform-wide act with a platform-wide blast radius, not a
-- side effect of a territory migration. It is named so it can be decided on its
-- own terms.
--
-- IDEMPOTENT. Safe to re-run.

begin;

-- ── THE PREDICATE ───────────────────────────────────────────────────────────
-- SECURITY DEFINER on purpose: it reads user_role_assignments and teams to
-- answer a question about the CALLER'S OWN authority. Under the caller's own
-- RLS those reads could themselves be refused, and a refused authorisation read
-- returns false — which would fail the gate closed against a legitimate writer.
-- It returns nothing but a boolean about the caller, so it leaks no rows.
create or replace function public.can_write_service_area(
  p_brokerage_id  uuid,
  p_team_id       uuid,
  p_agent_user_id uuid
) returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  -- coalesce(..., false) IS THE POINT, not tidiness. MEASURED after the first
  -- apply: with no identity, `p_agent_user_id = auth.uid()` is NULL rather than
  -- false, and SQL three-valued logic carries that NULL out through the OR and
  -- the AND — so the agent branch returned NULL where it meant "no". RLS treats
  -- NULL as unsatisfied, so the gate still failed closed and nothing was
  -- exposed; but a boolean function that answers NULL is a trap for anything
  -- that ever composes it (a NOT, a coalesce with a different default, a join),
  -- and "it happens to be safe in today's only caller" is not a property worth
  -- relying on. It now answers a strict boolean: could-not-establish = no.
  select coalesce(
    -- The tenant test is retained, not replaced. The grain gate is ON TOP of it.
    p_brokerage_id is not null
    and p_brokerage_id = public.current_user_brokerage_id()
    and (
      -- Brokerage admin by user_type …
      public.is_brokerage_admin()

      -- … or by a tenant role GRANT, matching requireBrokerageAdmin. Pinned to
      -- p_brokerage_id: a grant administering ANOTHER brokerage authorises
      -- nothing here.
      or exists (
        select 1
        from   public.user_role_assignments ura
        where  ura.user_id      = auth.uid()
          and  ura.role         in ('admin','broker','broker_owner')
          and  ura.brokerage_id = p_brokerage_id
      )

      -- AGENT GRAIN, tested FIRST because grainOf() reads agent_user_id first:
      -- your own coverage, and only your own.
      or (p_agent_user_id is not null and p_agent_user_id = auth.uid())

      -- TEAM GRAIN: a team you actually LEAD. team_lead_id is a users id and
      -- auth.uid() is a users id — the same id class, verified rather than
      -- assumed, because agents.id and users.id are two different spaces on
      -- this schema and mixing them is how these gates fail open.
      -- `p_agent_user_id is null` keeps the branches disjoint so a row carrying
      -- BOTH ids can never be authorised as a team row: grainOf() calls it an
      -- agent row, so only the agent branch may admit it.
      or (
        p_agent_user_id is null
        and p_team_id is not null
        and exists (
          select 1
          from   public.teams t
          where  t.id           = p_team_id
            and  t.brokerage_id = p_brokerage_id
            and  t.deleted_at   is null
            and  t.team_lead_id = auth.uid()
        )
      )

      -- NOTE the branch that is absent: brokerage grain (both ids NULL) reaches
      -- no clause but the two admin ones. That absence IS the rule — it is the
      -- grain the platform rotation reads, so it is admin-only.
    ),
    false  -- could-not-establish = no. See the note at the top of the body.
  )
$$;

comment on function public.can_write_service_area(uuid, uuid, uuid) is
  'RLS grain gate for subscriber_service_areas. Mirrors authorizeTerritoryWrite in app/dashboard/settings/territories/territory-rules.ts: brokerage grain is admin-only, team grain requires leading that team, agent grain requires being that agent. Admin means user_type OR a tenant role grant, matching requireBrokerageAdmin.';

-- ── THE POLICIES ────────────────────────────────────────────────────────────
-- SELECT stays TENANT-WIDE and is deliberately untouched: seeing who covers
-- which zip inside your own brokerage is what the settings surface is for, and
-- narrowing reads would blank the page for everyone but admins.

drop policy if exists subscriber_service_areas_tenant_insert on public.subscriber_service_areas;
create policy subscriber_service_areas_grain_insert
  on public.subscriber_service_areas
  for insert to authenticated
  with check (public.can_write_service_area(brokerage_id, team_id, agent_user_id));

-- UPDATE is gated on BOTH sides on purpose. USING says you may only touch a row
-- at a grain you control; WITH CHECK says you may not MOVE a row into a grain
-- you do not. Without the second half, an agent could take their own agent-grain
-- row and null out agent_user_id, turning it into the brokerage-wide claim that
-- steers the platform rotation — passing the gate on the way in.
drop policy if exists subscriber_service_areas_tenant_update on public.subscriber_service_areas;
create policy subscriber_service_areas_grain_update
  on public.subscriber_service_areas
  for update to authenticated
  using      (public.can_write_service_area(brokerage_id, team_id, agent_user_id))
  with check (public.can_write_service_area(brokerage_id, team_id, agent_user_id));

-- DELETE is a write. Retiring coverage is normally an UPDATE to active=false,
-- but a hard delete of someone else's claim is the same act with no audit trail,
-- so it answers to the same gate.
drop policy if exists subscriber_service_areas_tenant_delete on public.subscriber_service_areas;
create policy subscriber_service_areas_grain_delete
  on public.subscriber_service_areas
  for delete to authenticated
  using (public.can_write_service_area(brokerage_id, team_id, agent_user_id));

commit;

-- ── MEASURED AFTER APPLYING, ON THE LIVE DATABASE ───────────────────────────
-- Eleven cases, each run as the real account by setting the request JWT subject,
-- then every test row deleted. Residue afterwards: 0.
--
--   plain agent, brokerage grain ................. REFUSED 42501
--   plain agent, a team they do not lead ......... REFUSED 42501
--   plain agent, another agent's coverage ........ REFUSED 42501
--   plain agent, their OWN coverage .............. ALLOWED, 1 row
--   plain agent, promoting their own row up ...... REFUSED 42501
--   team lead, their own team .................... ALLOWED, 1 row
--   team lead, brokerage grain ................... REFUSED 42501
--   brokerage admin, brokerage grain ............. ALLOWED, 1 row
--   brokerage admin, an agent's coverage ......... ALLOWED
--   brokerage admin, a DIFFERENT brokerage ....... REFUSED 42501
--   GRANT-only admin, brokerage grain ............ ALLOWED, 1 row
--
-- The last two are the ones worth reading together. The tenant test still bites
-- (an admin cannot reach another brokerage), and the account the app admits by
-- role grant is admitted here too — so this closes a hole without opening a
-- silent refusal in its place. The fourth and sixth matter just as much as the
-- refusals: a gate that also blocks legitimate writers is not a fixed gate, it
-- is a different bug.
--
-- ── WHAT THIS DOES NOT DO ───────────────────────────────────────────────────
-- It does not remove the app-side gate. authorizeTerritoryWrite still runs and
-- still produces the sentence a person reads ("You can only set coverage for a
-- team you lead"). RLS produces a zero-row refusal, which is a fact, not an
-- explanation. Both are wanted: the app says WHY, the database makes it TRUE.
