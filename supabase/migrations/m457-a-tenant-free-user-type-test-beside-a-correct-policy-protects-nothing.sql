-- m457 — two tables whose write policies name a role and forget the tenant.
-- Found by the W46 agents while building the settings surfaces that sit on top
-- of them; verified against pg_policies before and after.
--
-- ══ PART 1 — global_settings ══════════════════════════════════════════════
--
-- MEASURED, and it is m438's exact shape:
--   "Admins can modify settings"           ALL    TO public
--       USING (users.user_type = 'admin')          ← no tenant test
--       WITH CHECK — ABSENT
--   "Admins and brokers can view settings" SELECT TO public
--       USING (user_type IN ('admin','broker'))    ← no tenant test
--
-- PERMISSIVE POLICIES OR TOGETHER, so the correctly-scoped
-- global_settings_tenant_* policies sitting beside these protected NOTHING:
--   · an admin or broker of tenant A could READ every tenant's settings;
--   · an admin of tenant A could UPDATE or DELETE any tenant's row — and on a
--     FOR ALL policy USING alone governs DELETE (there is no WITH CHECK to stop
--     it), while an absent WITH CHECK means Postgres reuses USING as the check,
--     so nothing constrained what the row could BECOME either.
--
-- This is not theoretical for this wave: W46 makes global_settings.app_name a
-- MIRROR of brokerages.name, i.e. the brokerage name clients see in the portal
-- and inside the TCPA consent text a lead agrees to. A cross-tenant write here
-- puts one brokerage's name on another brokerage's consent record.
--
-- The tenant_* policies already say the right thing. The fix is to delete the
-- two that forgot the tenant, and to add the role test to the write side, which
-- the app has always enforced anyway (lib/kernel/global-settings.ts's
-- requireBrokerAdmin) while the database did not.
drop policy if exists "Admins can modify settings"           on public.global_settings;
drop policy if exists "Admins and brokers can view settings" on public.global_settings;
drop policy if exists global_settings_tenant_update          on public.global_settings;
drop policy if exists global_settings_tenant_insert          on public.global_settings;
drop policy if exists global_settings_tenant_delete          on public.global_settings;

-- READ stays open to every member of the tenant: the client portal and the
-- open-house kiosk render app_name/logo/colour to ordinary users, so narrowing
-- the read to admins would blank the branding those surfaces exist to show.
-- (global_settings_tenant_select already says exactly this and is left in place.)

-- WRITE is a brokerage-admin act. is_brokerage_admin() = admin | broker |
-- broker_owner, which is the same roster lib/kernel/global-settings.ts gates on
-- — except the kernel omits broker_owner, so the DATABASE is now the broader-
-- but-correct authority and the app is the narrower one. Reported, not widened
-- here, because narrowing app-side is the safe direction.
create policy global_settings_tenant_insert on public.global_settings
  for insert to authenticated
  with check (brokerage_id = public.current_user_brokerage_id() and public.is_brokerage_admin());

create policy global_settings_tenant_update on public.global_settings
  for update to authenticated
  using      (brokerage_id = public.current_user_brokerage_id() and public.is_brokerage_admin())
  with check (brokerage_id = public.current_user_brokerage_id() and public.is_brokerage_admin());

create policy global_settings_tenant_delete on public.global_settings
  for delete to authenticated
  using (brokerage_id = public.current_user_brokerage_id() and public.is_brokerage_admin());

-- ══ PART 2 — teams ════════════════════════════════════════════════════════
--
-- MEASURED: all FOUR commands were the bare tenant test
--   brokerage_id = current_user_brokerage_id()
-- with NO role test and NO lead test. So any authenticated user of the tenant —
-- an ordinary agent, or a user_type='contact' with a users row, i.e. a CLIENT —
-- could UPDATE or DELETE any team in the brokerage.
--
-- The branding columns are the mild half. The severe half is that the same rows
-- carry team_split_type, team_split_percent, team_split_value, team_fees_json
-- and member_overrides_json, which lib/commission/waterfall/08-team-split.ts:30
-- reads to compute what an agent is paid. An agent could rewrite their own
-- team's split against the API and the database would allow it.
--
-- Owner ruling this wave: "teams also may have a different logo than the
-- brokerage" — that makes teams a first-class settings surface, so the policy
-- has to say who owns a team. Leading a team is a FACT: teams.team_lead_id =
-- auth.uid(), the same predicate public.current_user_led_team_id() uses (verified
-- — it compares team_lead_id to auth.uid(), a users.id, NOT an agents.id).
--
-- VERIFIED FIRST: there are ZERO writers to `teams` anywhere in app/ or lib/
-- besides the surface this wave adds, so narrowing these three commands cannot
-- break an existing flow.
--
--   CORRECTION (W48, recorded here rather than silently edited, because the
--   sentence above is an assertion of fact and a reader must be able to see it
--   was wrong): there were TWO more writers.
--     · app/actions/multi-persona.ts:createTeam — the session-client INSERT
--       behind the Create Team dialog. It is now gated by
--       requireBrokerageAdmin and resolves its tenant from the session, so the
--       policy below is what it mirrors rather than something it trips over.
--     · lib/kernel/users.ts:921 — signup provisioning creates a team when the
--       chosen tier is "team". It runs on the SERVICE client, so RLS never
--       applied to it and the narrowing could not have broken it.
--   The conclusion holds; the evidence for it did not. Neither writer was
--   broken by this migration, but only one of them was checked.
--
-- SELECT is deliberately untouched — an agent must see
-- their own team, and lib/kernel/resolve-user-team.ts and
-- app/dashboard/team/members depend on that read.
drop policy if exists teams_tenant_insert on public.teams;
drop policy if exists teams_tenant_update on public.teams;
drop policy if exists teams_tenant_delete on public.teams;

-- Creating or removing a team is an administrative act, never a lead's.
create policy teams_tenant_insert on public.teams
  for insert to authenticated
  with check (brokerage_id = public.current_user_brokerage_id() and public.is_brokerage_admin());

create policy teams_tenant_delete on public.teams
  for delete to authenticated
  using (brokerage_id = public.current_user_brokerage_id() and public.is_brokerage_admin());

-- A lead may edit their OWN team; a brokerage admin may edit any team in the
-- brokerage. The tenant anchor is repeated in WITH CHECK so neither of them can
-- move a team into another brokerage — the m448 lesson: a USING that proves only
-- ownership does not stop the owner rewriting the tenant column.
create policy teams_tenant_update on public.teams
  for update to authenticated
  using (
    brokerage_id = public.current_user_brokerage_id()
    and (public.is_brokerage_admin() or team_lead_id = auth.uid())
  )
  with check (
    brokerage_id = public.current_user_brokerage_id()
    and (public.is_brokerage_admin() or team_lead_id = auth.uid())
  );

do $$
begin
  raise notice 'm457: global_settings and teams no longer carry a tenant-free user_type test. A team lead may brand their own team; only a brokerage admin may create, delete or re-split one.';
end $$;
