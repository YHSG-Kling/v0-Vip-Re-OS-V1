-- m473 — A TEAM IS A MINI BROKERAGE, AND ITS LEAD KEEPS ITS BOOKS.
--
-- OWNER RULING, verbatim:
--
--   "a team is a mini version of a brokerage and especially if it is a team
--    subscription with no brokerage. if it is a team on a brokerage
--    subscription, then the team needs to also be able to add their branding.
--    the team lead needs to see finaincials pertaining to their contacts and
--    their team and be able to set the caps and percentages of their agents.
--    now this is too strict."
--
-- This RELAXES m472 at TEAM grain without reopening what m472 closed at
-- BROKERAGE grain: the lead still cannot touch the brokerage's books; they gain
-- their OWN team's — read the money their agents make, author their agents'
-- caps and percentages, keep their team's branding (which teams_tenant_update
-- already allowed and the owner has now blessed).
--
-- ── THE ANCHOR, AND WHY THE EXISTING TEAM LANES WERE WRONG IN BOTH DIRECTIONS ─
--
-- Leading a team is a FACT: `teams.team_lead_id = auth.uid()`. It is not a
-- user_type. MEASURED LIVE before this migration:
--
--   · the ONE live team's lead is teamlead@vip.demo, users.user_type = 'agent'.
--     The existing team lanes on agent_commissions / commission_splits keyed on
--     is_team_lead_role() — user_type IN ('team_lead','team_leader') — so the
--     person who ACTUALLY LEADS the team was REFUSED by the lane built for
--     them. ('team_leader' is not even storable: users_user_type_check admits
--     fourteen values and that is not one.)
--   · the seat-holder buyer@yourbrokerage.com (user_type 'team_lead') leads NO
--     team row — yet the old lane paired is_team_lead_role() with
--     current_user_team_id(), which falls back to users.team_id and MEMBERSHIP.
--     A seat-holder who is merely a MEMBER of a team would read that team's
--     books without leading it. Too loose and too strict at once.
--
-- can_read_agent_books() (m467) already carries the CORRECT anchor
-- (agent_team_id(x) = current_user_led_team_id()); this migration brings the
-- stragglers onto it.
--
-- ── WHAT THIS DELIBERATELY DOES NOT DO ───────────────────────────────────────
--
-- · Does not widen is_brokerage_admin() or is_brokerage_finance_admin(): the
--   brokerage/team boundary of m472 stands. The lead's new authority is scoped
--   BY ROW to their own team's agents, not by roster.
-- · Does not build a "team-only subscription" tier: a team subscription with no
--   brokerage IS the tenant — its lead signs up as the brokerage owner of their
--   own brokerages row, and every brokerage-grain rule already serves them.
--   Nothing to model.
-- · teams_tenant_update keeps `OR team_lead_id = auth.uid()` — branding AND the
--   team row's terms — which m472 flagged for a ruling and the owner has now
--   given ("the team needs to also be able to add their branding", "set the
--   caps").

-- ─────────────────────────────────────────────────────────────────────────────
-- 0. Preconditions: the policies we are about to replace exist as measured.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='agent_commissions' and policyname='agent_commissions_tenant_select') then
    raise exception 'm473 precondition: agent_commissions_tenant_select missing';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='commission_splits' and policyname='commission_splits_select') then
    raise exception 'm473 precondition: commission_splits_select missing';
  end if;
  if not exists (select 1 from pg_policies where schemaname='public'
                 and tablename='team_members' and policyname='team_members_tenant_update') then
    raise exception 'm473 precondition: team_members_tenant_update missing';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. can_read_team_books: the third disjunct becomes the FACT.
--    (Also consumed by team_commission_profiles, team_earnings, and the
--    team-leader listing/transaction reads — all fixed transitively.)
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.can_read_team_books(target_team_id uuid)
returns boolean
language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
  select public.can_read_tenant_financials()
    or public.can_read_brokerage_books()
    -- LEADING the team is the authority — teams.team_lead_id, not a user_type.
    -- The old form (is_team_lead_role() AND current_user_team_id() = target)
    -- refused the live FK lead whose user_type is 'agent', and would have
    -- admitted a seat-holding MEMBER to books they do not keep.
    or (target_team_id is not null
        and target_team_id = public.current_user_led_team_id());
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. The two wrong-anchor SELECT lanes: agent-level money the lead may read.
--    Every other disjunct is carried verbatim; ONLY the team lane changes.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy agent_commissions_tenant_select on public.agent_commissions;
create policy agent_commissions_tenant_select on public.agent_commissions
for select using (
  can_read_tenant_financials()
  or (is_brokerage_finance_admin() and has_brokerage_access(brokerage_id))
  or (has_brokerage_access(brokerage_id)
      and agent_team_id(agent_id) is not null
      and agent_team_id(agent_id) = current_user_led_team_id())
  or (is_agent_role() and (agent_id = current_user_agent_id()))
);

drop policy commission_splits_select on public.commission_splits;
create policy commission_splits_select on public.commission_splits
for select using (
  is_platform_admin()
  or can_read_tenant_financials()
  or (is_brokerage_finance_admin() and has_brokerage_access(brokerage_id))
  or (has_brokerage_access(brokerage_id)
      and agent_team_id(agent_id) is not null
      and agent_team_id(agent_id) = current_user_led_team_id())
  or (is_agent_role() and (agent_id = current_user_agent_id()))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 3. agent_commission_profiles writes: the lead AUTHORS their agents' terms.
--
--    THE SELF-WRITE LANE IS REMOVED. The old qual admitted
--    `agent_id = current_user_agent_id()` on INSERT/UPDATE/DELETE — any agent
--    could author their OWN split and cap. The ruling assigns that authority to
--    the lead ("set the caps and percentages of their agents") and to finance
--    admins; an agent setting their own commission terms is the inverse of a
--    gate. VERIFIED before removal: the only cookie-client toucher of this
--    table (lib/brokerage/get-default-commission-structure.ts) READS it; every
--    WRITER goes through the service client, which RLS does not bind — so no
--    live path loses a write it was making.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy agent_commission_profiles_tenant_insert on public.agent_commission_profiles;
create policy agent_commission_profiles_tenant_insert on public.agent_commission_profiles
for insert with check (
  is_platform_admin()
  or (has_brokerage_access(brokerage_id)
      and (is_brokerage_finance_admin()
           or (agent_id is not null
               and agent_team_id(agent_id) is not null
               and agent_team_id(agent_id) = current_user_led_team_id())))
);

drop policy agent_commission_profiles_tenant_update on public.agent_commission_profiles;
create policy agent_commission_profiles_tenant_update on public.agent_commission_profiles
for update using (
  is_platform_admin()
  or (has_brokerage_access(brokerage_id)
      and (is_brokerage_finance_admin()
           or (agent_id is not null
               and agent_team_id(agent_id) is not null
               and agent_team_id(agent_id) = current_user_led_team_id())))
) with check (
  is_platform_admin()
  or (has_brokerage_access(brokerage_id)
      and (is_brokerage_finance_admin()
           or (agent_id is not null
               and agent_team_id(agent_id) is not null
               and agent_team_id(agent_id) = current_user_led_team_id())))
);

drop policy agent_commission_profiles_tenant_delete on public.agent_commission_profiles;
create policy agent_commission_profiles_tenant_delete on public.agent_commission_profiles
for delete using (
  is_platform_admin()
  or (has_brokerage_access(brokerage_id)
      and (is_brokerage_finance_admin()
           or (agent_id is not null
               and agent_team_id(agent_id) is not null
               and agent_team_id(agent_id) = current_user_led_team_id())))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 4. agent_cap_tracking writes: the lead lane is ADDED; the self lane STAYS.
--    Cap-tracking rows are derived bookkeeping (ensureAgentCapWindow) written
--    on the agent's own activity — keeping self here authors no terms. The
--    TERMS live in agent_commission_profiles, whose self lane §3 removed.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy agent_cap_tracking_tenant_insert on public.agent_cap_tracking;
create policy agent_cap_tracking_tenant_insert on public.agent_cap_tracking
for insert with check (
  is_platform_admin()
  or (has_brokerage_access(brokerage_id)
      and (is_brokerage_finance_admin()
           or (agent_id is not null and agent_id = current_user_agent_id())
           or (agent_id is not null
               and agent_team_id(agent_id) is not null
               and agent_team_id(agent_id) = current_user_led_team_id())))
);

drop policy agent_cap_tracking_tenant_update on public.agent_cap_tracking;
create policy agent_cap_tracking_tenant_update on public.agent_cap_tracking
for update using (
  is_platform_admin()
  or (has_brokerage_access(brokerage_id)
      and (is_brokerage_finance_admin()
           or (agent_id is not null and agent_id = current_user_agent_id())
           or (agent_id is not null
               and agent_team_id(agent_id) is not null
               and agent_team_id(agent_id) = current_user_led_team_id())))
) with check (
  is_platform_admin()
  or (has_brokerage_access(brokerage_id)
      and (is_brokerage_finance_admin()
           or (agent_id is not null and agent_id = current_user_agent_id())
           or (agent_id is not null
               and agent_team_id(agent_id) is not null
               and agent_team_id(agent_id) = current_user_led_team_id())))
);

drop policy agent_cap_tracking_tenant_delete on public.agent_cap_tracking;
create policy agent_cap_tracking_tenant_delete on public.agent_cap_tracking
for delete using (
  is_platform_admin()
  or (has_brokerage_access(brokerage_id)
      and (is_brokerage_finance_admin()
           or (agent_id is not null
               and agent_team_id(agent_id) is not null
               and agent_team_id(agent_id) = current_user_led_team_id())))
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 5. team_members writes: TODAY these carry NO role test — any tenant user,
--    including a contact seat, may INSERT/UPDATE/DELETE roster rows INCLUDING
--    split_percent. That is #180's class, live in this exact domain. Writes
--    become finance admin (any team) or the lead (their own team). SELECT
--    stays tenant-wide: the roster is operational visibility.
-- ─────────────────────────────────────────────────────────────────────────────
drop policy team_members_tenant_insert on public.team_members;
create policy team_members_tenant_insert on public.team_members
for insert with check (
  brokerage_id = current_user_brokerage_id()
  and (is_brokerage_finance_admin() or team_id = current_user_led_team_id())
);

drop policy team_members_tenant_update on public.team_members;
create policy team_members_tenant_update on public.team_members
for update using (
  brokerage_id = current_user_brokerage_id()
  and (is_brokerage_finance_admin() or team_id = current_user_led_team_id())
) with check (
  brokerage_id = current_user_brokerage_id()
  and (is_brokerage_finance_admin() or team_id = current_user_led_team_id())
);

drop policy team_members_tenant_delete on public.team_members;
create policy team_members_tenant_delete on public.team_members
for delete using (
  brokerage_id = current_user_brokerage_id()
  and (is_brokerage_finance_admin() or team_id = current_user_led_team_id())
);

-- ─────────────────────────────────────────────────────────────────────────────
-- 6. is_team_lead_role: drop the phantom 'team_leader' spelling. Not storable
--    (users_user_type_check, VALIDATED), matches zero rows — removing it is a
--    proven no-op. The function keeps answering the SEAT question for any
--    remaining seat-level consumer; the two policies that mis-used it for the
--    LEADS-THIS-TEAM question were rewritten above and no policy composes it
--    now (asserted below).
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.is_team_lead_role()
returns boolean
language sql stable security definer
as $$
  select coalesce(
    (select user_type = 'team_lead' from public.users where id = auth.uid() limit 1),
    false
  );
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 7. Postconditions.
-- ─────────────────────────────────────────────────────────────────────────────
do $$
declare v_bad int;
begin
  -- No policy keys team authority on the seat any more.
  select count(*) into v_bad from pg_policies
  where schemaname='public' and (qual ~ 'is_team_lead_role' or with_check ~ 'is_team_lead_role');
  if v_bad <> 0 then
    raise exception 'm473: % policies still anchor team authority on is_team_lead_role', v_bad;
  end if;

  -- No write policy on the terms table admits self.
  select count(*) into v_bad from pg_policies
  where schemaname='public' and tablename='agent_commission_profiles'
    and cmd <> 'SELECT'
    and (coalesce(qual,'') ~ 'current_user_agent_id' or coalesce(with_check,'') ~ 'current_user_agent_id');
  if v_bad <> 0 then
    raise exception 'm473: agent_commission_profiles still lets an agent author their own terms';
  end if;

  -- Every team_members write policy now carries a role test.
  select count(*) into v_bad from pg_policies
  where schemaname='public' and tablename='team_members' and cmd <> 'SELECT'
    and coalesce(qual, with_check) !~ 'is_brokerage_finance_admin';
  if v_bad <> 0 then
    raise exception 'm473: a team_members write policy lost its role test';
  end if;

  -- The four tables kept exactly four policies each (no lane silently dropped).
  select count(*) into v_bad from (
    select tablename from pg_policies where schemaname='public'
    and tablename in ('agent_commissions','commission_splits','agent_commission_profiles','agent_cap_tracking','team_members')
    group by tablename having count(*) <> 4
  ) t;
  if v_bad <> 0 then
    raise exception 'm473: a governed table no longer has exactly 4 policies';
  end if;
end $$;
