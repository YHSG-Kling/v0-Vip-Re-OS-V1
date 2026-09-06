-- m431 — THE TEAM TIER, AND THE END OF THE "NOT AN AGENT" BRANCH.
--
--   "teams should only see their own board."
--   "agents should only see their own commission splits."
--   "contacts, lenders and vendors do not see commission or any financials but
--    only their own."
--
-- Three things, in the order they depend on each other:
--
--   A. `resolve_team_id()` / `current_user_team_id()` / `agent_team_id()` —
--      THE ONE RULE for "which team is this person on", because there are four
--      places a team can be recorded and today four different call sites each
--      pick a different one.
--   B. `agent_commissions` SELECT — the negative `NOT is_agent_role()` branch
--      replaced by a POSITIVE tier list, with the team tier added.
--   C. `commission_splits` SELECT — the same expression, plus all four of its
--      policies narrowed from PUBLIC to authenticated.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- A. WHICH TEAM IS THIS PERSON ON — ONE RULE, FOUR SOURCES
-- ─────────────────────────────────────────────────────────────────────────────
--
-- A team membership can be recorded in FOUR places on this schema, and all four
-- exist. Measured live before this was written:
--
--   teams.team_lead_id  → users(id).  1 row, populated. THE ONLY populated team
--                         fact on the database. "Williams Elite Team" points at
--                         teamlead@vip.demo.
--   users.team_id       → teams(id).  0 of 23 users populated. Read by
--                         dispatch-showing, connection-center, financials
--                         (logScopedExpense), seller-listing/execution-engine,
--                         podcast-generation, buyer-offer/submit-to-compliance,
--                         and surfaced as AgentContext.teamId.
--   agents.team_id      → teams(id).  1 of 5 agents populated. Read by
--                         app/team/[slug] (the PUBLIC team site roster) and
--                         written by app/actions/agents.ts provisioning.
--   team_members        → the junction, with split_percent, source_of_funds,
--                         effective dating and is_active. 0 rows. Read by
--                         getTeamDashboard, lib/finance/team-pl-writer,
--                         app/actions/admin/team-members.ts (its only writer),
--                         and the recruiting career-tier.
--
-- So `app/team/[slug]` and `lib/finance/team-pl-writer` — the public roster and
-- the team P&L — can disagree about who is on a team RIGHT NOW, on live data:
-- the roster reads agents.team_id (1 member) and the P&L reads team_members
-- (0 members). Neither is wrong; there is simply no rule. This is exactly the
-- shape m423 found for a person's OFFICE and answered with
-- lib/kernel/resolve-user-office.ts, and it gets the same answer here: ONE
-- function that holds the precedence, so a policy and a screen cannot drift.
--
-- WHICH IS AUTHORITATIVE, and why in this order:
--
--   1. teams.team_lead_id = the user.  If you LEAD a team, that is your team,
--      full stop. It is the only team relationship the `teams` table declares
--      itself, it is the only one populated on live data, and it is the one the
--      owner's ruling is actually about. It also survives a team lead who has no
--      `agents` row — and although requiresAgentRow() (lib/kernel/
--      tenant-provisioning-spec.ts) puts 'team_lead' in AGENT_ROLES so a
--      correctly provisioned lead always has one, the ONE live user_type
--      'team_lead' account has no agents row, so that path is real today.
--      Soft-deleted teams are excluded: a deleted team is not a scope.
--
--   2. users.team_id.  m423's rationale, transplanted: the person's own record
--      is what an admin last set deliberately, and it is the only option for
--      someone with no `agents` row. Same precedence direction as
--      resolve-user-office.ts, which puts users.location_id above
--      agents.location_id for exactly this reason.
--
--   3. team_members, active.  The rich model — it carries the split percent the
--      Finance Manager's waterfall needs. Above agents.team_id because
--      app/actions/admin/team-members.ts is a deliberate admin act ("add this
--      agent to this team at this split"), while agents.team_id is also written
--      by provisioning and import paths. The explicit act wins, again m423's
--      rule.
--
--      `is_active` is the marker every existing reader filters on. This adds
--      `effective_to` as a second, NARROWER condition rather than replacing it:
--      removeTeamMember() sets both together, so on any row those readers see
--      the two agree — but a stale row with is_active still true and an
--      effective_to in the past would otherwise keep an ex-member inside a live
--      team's money. Narrowing is the safe direction for a policy helper; the
--      only thing it can ever do is drop someone who has already left.
--
--   4. agents.team_id.  The producing agent's team. Last, not because it is
--      wrong — it is the only populated membership on this database — but
--      because it is the one most likely to have been set by an import.
--
-- NULL means NOT ON A TEAM, and that is fail-closed here, unlike
-- resolve-user-office where NULL means "not pinned, so see everything". The
-- direction is opposite on purpose: an unpinned office WIDENS an admin to their
-- whole brokerage, which is the correct reading of "no narrowing was ever
-- applied"; an unresolved TEAM must not widen a team lead to their whole
-- brokerage, because the owner's ruling is the narrowing. The policy in section
-- B therefore requires the resolved team to be NOT NULL and to MATCH, and a
-- team lead with no team reads nothing rather than everything.
--
-- Parameterised by (user, agent) rather than written twice, because the policy
-- needs it in both directions: "which team am I on" for the reader, and "which
-- team is THIS commission's agent on" for the row. Two copies of a four-source
-- precedence is two rules that will drift; this is one.

create or replace function public.resolve_team_id(p_user_id uuid, p_agent_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    -- 1. you lead it
    (select t.id from public.teams t
      where p_user_id is not null and t.team_lead_id = p_user_id and t.deleted_at is null
      limit 1),
    -- 2. your own user record says so
    (select u.team_id from public.users u
      where p_user_id is not null and u.id = p_user_id and u.team_id is not null
      limit 1),
    -- 3. an active team_members row says so
    (select tm.team_id
       from public.team_members tm
      where tm.is_active
        and (tm.effective_to is null or tm.effective_to >= current_date)
        and (
          (p_agent_id is not null and tm.agent_id = p_agent_id)
          or (p_user_id is not null and tm.agent_id in
                (select a.id from public.agents a where a.user_id = p_user_id))
        )
      order by tm.effective_from desc
      limit 1),
    -- 4. the producing agent row says so
    (select a.team_id from public.agents a
      where a.team_id is not null
        and (
          (p_agent_id is not null and a.id = p_agent_id)
          or (p_user_id is not null and a.user_id = p_user_id)
        )
      limit 1)
  );
$$;

comment on function public.resolve_team_id(uuid, uuid) is
  'THE ONE RULE for "which team is this person on". A team membership can be recorded in FOUR places (teams.team_lead_id, users.team_id, team_members, agents.team_id) and all four exist and are read by different call sites — app/team/[slug] reads agents.team_id while lib/finance/team-pl-writer reads team_members, so the public roster and the team P&L can disagree on live data. Precedence: you lead it > your own user record > an active team_members row > the producing agent row, which is m423''s "the explicit admin act wins" applied to teams instead of offices (see lib/kernel/resolve-user-office.ts and lib/kernel/resolve-user-team.ts, its app-side twin). NULL means NOT ON A TEAM and is fail-closed: the commission policies require a NOT NULL match, so a team lead with no resolvable team reads nothing rather than their whole brokerage.';

-- The reader's side. Same shape as current_user_agent_id() — SECURITY DEFINER so
-- it reads users/agents/teams without tripping their own RLS or recursing into a
-- policy that calls it, STABLE so the planner may cache it per statement instead
-- of re-querying per row — plus the pinned search_path that
-- can_read_tenant_financials() (m427) and is_platform_staff() established as the
-- house shape for a helper written since, so a caller cannot shadow public.users.

create or replace function public.current_user_team_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.resolve_team_id(auth.uid(), public.current_user_agent_id());
$$;

comment on function public.current_user_team_id() is
  'The calling user''s team, through public.resolve_team_id() — the ONE precedence rule for team membership. NULL = not on a team, which the commission policies treat as fail-closed (no team clause can match). The counterpart of current_user_agent_id(); use it, never an inlined read of users.team_id, so a change to the precedence is inherited rather than copied.';

-- The row's side: agent_commissions.agent_id and commission_splits.agent_id are
-- both agents-class (FK → agents.id, verified live), so the question a policy
-- asks of a ROW is "which team is THIS agent on". agents.user_id is NOT NULL, so
-- the user half is always available.

create or replace function public.agent_team_id(p_agent_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.resolve_team_id(
    (select a.user_id from public.agents a where a.id = p_agent_id limit 1),
    p_agent_id
  );
$$;

comment on function public.agent_team_id(uuid) is
  'The team of the agent identified by an agents.id, through public.resolve_team_id() — the same ONE precedence rule current_user_team_id() uses, so the reader''s team and the row''s team are decided by identical logic. Takes agents.id because agent_commissions.agent_id and commission_splits.agent_id are both FKs to agents(id); passing a users.id here silently returns NULL rather than erroring, so never substitute one id class for the other.';

revoke all on function public.resolve_team_id(uuid, uuid)  from public;
revoke all on function public.current_user_team_id()       from public;
revoke all on function public.agent_team_id(uuid)          from public;
grant execute on function public.resolve_team_id(uuid, uuid) to authenticated, service_role;
grant execute on function public.current_user_team_id()      to authenticated, service_role;
grant execute on function public.agent_team_id(uuid)         to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- B. `agent_commissions` SELECT — A POSITIVE TIER LIST
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT THE POLICY SAYS TODAY (m427, verified live before this was written):
--
--   can_read_tenant_financials()
--   or (is_agent_role() and agent_id = current_user_agent_id())
--   or ((not is_agent_role()) and has_brokerage_access(brokerage_id))
--
-- The third disjunct is the defect. `is_agent_role()` is exactly
-- `user_type = 'agent'`, so "NOT an agent" is TRUE for a contact, a lender and a
-- vendor — and all eight of those accounts carry a brokerage_id on this
-- database. That one clause is how a client reads their brokerage's whole
-- commission book. It is also how `tc`, `compliance_officer`, `isa` and the
-- `system` AI-ISA accounts read it, none of which the owner named.
--
-- A negative test admits every role invented later, which is precisely how this
-- defect arrived: the clause was correct when 'agent' and 'broker' were the only
-- two user types, and it silently widened each time a role was added. So it is
-- replaced by a POSITIVE list of the tiers the owner ruled on:
--
--   can_read_tenant_financials()                          ← Platform. ALL
--       tenants, READ ONLY. Unchanged from m427; never appears on a write
--       clause (m428 claim 5 asserts that schema-wide).
--
--   is_brokerage_admin() and has_brokerage_access(...)    ← Brokerage. Own
--       tenant, whole book. is_brokerage_admin() is already the named helper for
--       exactly this roster (admin, broker, broker_owner) and is the same helper
--       the WRITE policies use, so read and write now agree about who runs a
--       brokerage instead of describing it two different ways.
--
--   is_team_lead_role() and has_brokerage_access(...)     ← Team. Own team only.
--       and agent_team_id(agent_id) = current_user_team_id()
--       THIS IS THE NEW RULING. The equality is the whole narrowing: an
--       unresolved team on either side makes it NULL, never TRUE, so a team lead
--       with no team gets nothing rather than the brokerage. has_brokerage_access
--       is kept alongside it and is not redundant defence — it is what stops the
--       clause from ever being satisfiable across tenants if two brokerages'
--       teams were ever mixed, and it is the anchor m428 claim 6 requires.
--
--   is_agent_role() and agent_id = current_user_agent_id()   ← Agent. Own rows.
--       Unchanged. Ruling 4 ALREADY HOLDS post-m427 — because the third disjunct
--       required NOT is_agent_role(), an ordinary agent already matched only
--       their own rows. This migration does not change what an agent sees; m432
--       is what stops it from silently coming back.
--
-- WHO LOSES ACCESS, and why each is correct. Every role that fell through the
-- old negative branch was traced to its screens first:
--
--   contact / lender / vendor  (8 live accounts, all with a brokerage_id)
--       Ruling 2, verbatim. They go to zero. No screen they can load reads this
--       table.
--   system  (2 live AI-ISA accounts, platform_role = 'ai_isa_system')
--       Neither has EVER signed in (auth.users.last_sign_in_at is NULL for
--       both); the AI ISA acts through createServiceClient(), which is not
--       subject to RLS. 23 policies name is_ai_isa_system() and none of them is
--       on a commission table. Nothing changes for it.
--   tc  (1 live account)
--       NOT named by the owner, so this is a conclusion and the owner should
--       correct it if it is wrong. There is precedent both ways and it was
--       resolved by reading the screens: `transaction_commissions` — a DIFFERENT
--       table, the deal-level commission stamp — admits 'tc' and is NOT touched
--       here, so the TC keeps the commission figure attached to the deals they
--       coordinate. What they lose is the AGENT PAYROLL ledger, and no surface a
--       TC can load reads it: app/dashboard/coordinator/page.tsx reads
--       transaction_coordinators and deal_health_scores only. Coordinating a
--       transaction does not require knowing what each agent takes home.
--   compliance_officer  (1 live account)
--       Same, and same caveat. Their commission touchpoint is the CDA — the
--       closing_disclosure_agreement family, where four policies already name
--       'compliance_officer' and none is touched here. app/dashboard/compliance
--       reads neither of these two tables. `updateCommissionStatus`
--       (app/actions/financials.ts:503) is already code-gated to
--       broker/admin/superadmin, i.e. the platform has already decided a
--       compliance officer does not move commission money.
--   isa
--       0 live accounts, so nothing breaks today. An ISA sets appointments and
--       has no book of closings; is_agent_role() is 'agent' only, so an ISA gets
--       nothing here. Flagged rather than special-cased: if an ISA should carry
--       their own ledger, the right fix is to widen is_agent_role(), which every
--       other table would then inherit — not to add a fifth disjunct here.
--
-- WHO KEEPS EXACTLY WHAT THEY HAD: broker, broker_owner, admin (whole brokerage
-- via is_brokerage_admin) and superadmin/support (all tenants via
-- can_read_tenant_financials). Those are the roles the brokerage-wide screens
-- are gated to — app/dashboard/brokerage/page.tsx redirects anything that is not
-- broker/admin/superadmin, and getBrokerageStats/getBrokerageDashboard are the
-- two loaders on it. Nothing on that page changes.
--
-- THE WRITES ARE NOT TOUCHED, AND THE NARROWING DISARMS NONE OF THEM. Postgres
-- evaluates the SELECT policy to LOCATE rows for an UPDATE or DELETE that
-- carries a WHERE reading the table's columns, so narrowing SELECT can silently
-- kill a legitimate write. Checked in both directions here: all three write
-- policies are `is_platform_admin() or (is_brokerage_admin() and
-- has_brokerage_access(brokerage_id))`, and every principal that satisfies them
-- still has whole-tenant SELECT through the brokerage disjunct above. The team
-- lead gains READ only — the UPDATE USING excludes them, so a team lead cannot
-- edit a member's commission.

do $$
begin
  alter policy agent_commissions_tenant_select on public.agent_commissions
    using (
      can_read_tenant_financials()
      or (is_brokerage_admin() and has_brokerage_access(brokerage_id))
      or (is_team_lead_role()
          and has_brokerage_access(brokerage_id)
          and agent_team_id(agent_id) = current_user_team_id())
      or (is_agent_role() and agent_id = current_user_agent_id())
    );

  raise notice 'm431: agent_commissions SELECT — the "not an agent" branch is gone; the brokerage book is a POSITIVE role list, a team lead sees their own team, an agent sees their own rows, and contact/lender/vendor see nothing.';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- C. `commission_splits` — THE SAME EXPRESSION, AND OFF PUBLIC
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Two separate defects on this table.
--
-- (1) THE SAME NEGATIVE BRANCH. It would be incoherent to take a contact off the
--     brokerage's payroll in `agent_commissions` and leave the identical number
--     readable one table over: m419's comment records that both writers
--     (app/actions/agents.ts addAgentCommission, lib/kernel/financial.ts
--     createCommissionRecord) create the twin rows together, and the split row
--     carries agent_amount and brokerage_amount for the SAME commission. So the
--     same expression lands here.
--
--     is_platform_admin() is KEPT as its own leading disjunct rather than being
--     absorbed into can_read_tenant_financials(), for m427's reason: it is
--     carried implicitly by has_brokerage_access() too, and removing it would
--     make this expression depend on that inheritance being noticed by the next
--     reader.
--
-- (2) ALL FOUR POLICIES ARE GRANTED TO PUBLIC. Measured live: every
--     commission_splits policy has polroles = {0}, i.e. PUBLIC, while every
--     agent_commissions policy is TO authenticated. The two ledgers disagree
--     about who the policy even applies to.
--
--     This is harmless TODAY and the reason is worth writing down, because
--     "harmless today" is what keeps this class of defect alive: every helper in
--     the expression bottoms out in `select ... from users where id = auth.uid()`
--     wrapped in COALESCE(..., false), and for the anon role auth.uid() is NULL,
--     so each returns false and the anon reader matches no disjunct. The grant is
--     wrong anyway. TO PUBLIC means the policy is also evaluated for `anon` and
--     for any role added to this database later, and it makes the table's safety
--     depend on the internals of five helper functions rather than on the grant.
--     A single helper that someday returns TRUE for a NULL uid — the exact shape
--     of defect (c) in this workstream, where a NULL satisfies a clause for
--     everyone — would open this table to the open internet. Narrowed to
--     authenticated so the anon role never reaches the expression at all, and so
--     the two commission ledgers stop differing.
--
--     The three WRITE policies keep their expressions byte-for-byte (m419/m427
--     set them; m420 and m428 assert them). Only the role list changes.
--
-- m420's invariant is preserved: every non-empty USING and WITH CHECK expression
-- on this table still names `has_brokerage_access(brokerage_id)` specifically.
--
-- The only session-client reader, app/dashboard/financials/page.tsx, filters
-- `.eq("agent_id", agentId)` on the caller's own agent id, so it returns the
-- same rows before and after. lib/intelligence/brokerage-pnl.ts reads through
-- createServiceClient() and is not subject to RLS.

do $$
begin
  alter policy commission_splits_select on public.commission_splits
    using (
      is_platform_admin()
      or can_read_tenant_financials()
      or (is_brokerage_admin() and has_brokerage_access(brokerage_id))
      or (is_team_lead_role()
          and has_brokerage_access(brokerage_id)
          and agent_team_id(agent_id) = current_user_team_id())
      or (is_agent_role() and agent_id = current_user_agent_id())
    );

  alter policy commission_splits_select on public.commission_splits to authenticated;
  alter policy commission_splits_insert on public.commission_splits to authenticated;
  alter policy commission_splits_update on public.commission_splits to authenticated;
  alter policy commission_splits_delete on public.commission_splits to authenticated;

  raise notice 'm431: commission_splits — same tier list as agent_commissions, and all four policies moved off PUBLIC onto authenticated.';
end $$;
