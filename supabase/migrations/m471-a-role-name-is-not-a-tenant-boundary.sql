-- m471 — A ROLE NAME IS NOT A TENANT BOUNDARY
--
-- Owner ruling, verbatim: "only platform staff and admin should read cross
-- tenant." So a read that spans MORE THAN ONE brokerage must be reachable only
-- by PLATFORM identities. A tenant's own broker, broker_owner, broker_admin,
-- team_lead and admin are confined to their own brokerage — `admin` is a TENANT
-- user_type (users_user_type_check admits it alongside agent/broker/contact),
-- not a platform one, and that is the whole confusion this migration removes.
--
-- ── THE CENSUS THIS MIGRATION ACTS ON ───────────────────────────────────────
-- MEASURED on the live catalogue: 2088 policies over 712 tables; 847 of them
-- are read-capable (547 SELECT + 300 ALL). Every table in `public` has RLS
-- ENABLED — there is no table sitting open.
--
-- 735 of the 847 sit on a table that HAS a brokerage_id, are reachable by a
-- tenant seat (role authenticated or public), and are not the one inert
-- `USING (false)` policy. Those 735 are the population the ruling governs.
-- After this migration: 725 carry a tenant test, 175 carry a platform gate,
-- and ZERO carry neither. Before it, NINE carried neither, and those nine are
-- what this migration repairs.
--
-- HELPER-MEDIATED TESTS COUNT AND WERE CHECKED. 91 policies reach the tenant
-- boundary only through a function BODY — can_access_support_ticket,
-- can_write_service_area, vendor_has_contact_access,
-- vendor_has_transaction_access — and every one of those bodies was read
-- (pg_get_functiondef) before the census classified the policy. Calling a
-- helper-mediated test "missing" is the easy way to manufacture a defect list.
--
-- The 112 policies that name NO tenant token at all decompose as: 34
-- service_role-only (the service key bypasses RLS; not a tenant surface), 1
-- inert `USING (false)`, 43 self-scoped strictly TIGHTER than tenant (the row
-- belongs to auth.uid()), 6 of the 9 defects, and 28 on tables that have NO
-- TENANT COLUMN AT ALL — plan_limits, subscription_tiers, user_roles,
-- achievements, compliance_rules, document_templates, required_disclosures,
-- state_protected_classes, state_compliance_requirements,
-- state_appraiser_adjustment_rates, journey_blueprints, journey_tools,
-- keywords, playbooks, video_templates, feature_flags and friends. A catalogue
-- is not a tenant's data; those are left alone. (The other 3 defects sat in the
-- brokerage_id-mentioning group — which is exactly shape (1) below: naming the
-- column is not the same as testing it.)
--
-- FOUR OF THOSE 28 ARE REPORTED, NOT CLASSIFIED AS REFERENCE DATA, because they
-- are platform-internal rather than catalogue: cron_health_snapshot and
-- tenant_safety_findings expose PLATFORM operations (cron health, the RLS
-- safety scanner's own findings ABOUT tenants) to any tenant broker or admin;
-- demo_persona_contacts and marketing_stats are readable by every authenticated
-- seat. None of them holds another BROKERAGE's rows, so none is a cross-tenant
-- read under the ruling as written — but whether a tenant admin should see the
-- platform's operational state is the owner's call, not this migration's.
--
-- ── THE THREE SHAPES THE DEFECT TAKES ───────────────────────────────────────
--
-- (1) THE PREDICATE THAT COMPARES THE ROW TO ITSELF.
--     client_gifts and thank_you_notes both carry
--
--         brokerage_id = (select a.brokerage_id from agents a
--                         where a.id = <table>.agent_id limit 1)
--
--     Both sides of that `=` come from the ROW. auth.uid() does not appear.
--     It is a denormalisation consistency check wearing a policy's clothes, and
--     it evaluates TRUE for every row whose brokerage_id agrees with its agent's
--     — i.e. for all of them. The policies are NAMED
--     `client_gifts_brokerage_isolation` and `tyn_notes_brokerage`; they
--     isolated nothing.
--
-- (2) THE ROLE NAME STANDING IN FOR A BOUNDARY.
--     Six policies admit a caller because of WHAT THEY ARE without asking WHERE
--     they are: `users.user_type in ('admin','broker','compliance_officer',…)`
--     with no brokerage predicate anywhere in the expression. A broker at
--     brokerage A therefore read brokerage B's rows. Four of the six tables
--     ALREADY carry a correctly tenant-scoped sibling policy
--     (lead_deduplication_log_tenant_select, vendor_access_logs_tenant_select,
--     conversation_logs_tenant, video_completion_tracking_brokerage_isolation)
--     — and because PERMISSIVE policies are OR'd, the sibling did not constrain
--     the broken one. The wider policy always wins. That is what makes the fix
--     unambiguous rather than a judgement call: the same table already states,
--     in its own catalogue, what the boundary is meant to be.
--
-- (3) THE PLATFORM ESCAPE THAT IS NOT ONE.
--     Three of those policies spell their platform exemption as a user_type
--     literal — 'superadmin' (video_completion_tracking, cda_revisions) or
--     'super_admin' (deal_team_members). MEASURED: the ONE live superadmin on
--     this database is (user_type='admin', platform_role='superadmin'), so the
--     'superadmin' user_type arm never fires for them; and 'super_admin' is not
--     even a legal user_type — users_user_type_check admits fourteen values and
--     that is not one of them, and the constraint is VALIDATED, so no row was
--     grandfathered either. Those arms are DEAD. Worse, in deal_team_members
--     the same array carries 'admin', which IS live and IS a tenant type — so
--     the arm that was supposed to be the platform's exemption was in practice
--     every tenant admin's cross-tenant key. Each dead arm is replaced with
--     public.is_platform_staff(), which reads BOTH identity columns exactly as
--     lib/auth/resolve-user-role.ts#isPlatformStaffIdentity does app-side.
--     This REPLACES a broken platform escape; it does not invent one where
--     there was none.
--
-- ── SCOPE DISCIPLINE ────────────────────────────────────────────────────────
-- Only read-capable policies (SELECT and ALL) are touched, because the ruling
-- is about reads. The write-side twins of two of these defects
-- (conversation_audit_flags.audit_flags_update_policy,
--  audit_flags_insert_policy with `with check (true)`) are REPORTED, not
-- changed — they need their own ruling. conversation_audit_flags' SELECT is
-- likewise left alone: its only path to a brokerage is
-- conversation_id -> conversation_logs, and that column is NULLABLE, so an
-- EXISTS join would silently drop every flag whose conversation was never
-- linked. Narrowing that is a judgement about orphaned compliance flags, not a
-- mechanical fix.
--
-- Every arm that scopes a row to the CALLER THEMSELF (agent_id in own agents,
-- user_id = auth.uid()) is carried through UNCHANGED. Those are strictly
-- tighter than the tenant boundary; ANDing a brokerage test onto them would
-- have revoked access from an agent whose users.brokerage_id is NULL while
-- their agents.brokerage_id is set, which is a live shape on this database.
--
-- WHICH TENANT TEST, PER TABLE. Each policy adopts the test its own table
-- already uses, so no table ends up with two spellings of one boundary:
--   · current_user_brokerage_id()  where a sibling policy already uses it
--     (lead_deduplication_log, vendor_access_logs, conversation_logs,
--      video_completion_tracking, deal_team_members)
--   · user_brokerage_ids()         where the row is AGENT-owned and the caller
--     may be anchored through public.agents rather than public.users
--     (client_gifts, thank_you_notes, market_pulse)
-- Neither is `current_user_led_team_id()`, which is never used here: its
-- LIMIT 1 refuses a lead of two teams.
--
-- coalesce(..., false) WRAPS THE WHOLE OR-CHAIN wherever a scalar subquery can
-- answer NULL. RLS reads NULL as unsatisfied so it fails closed either way, but
-- NULL propagates through OR and a predicate that answers NULL is a trap for
-- anything that later composes or negates it. Could-not-establish = no.
--
-- MEASURED before writing: all nine tables are currently EMPTY (0 rows) across
-- 2 live brokerages, so nothing leaked yet. These are latent, not live.
--
-- REPORTED, NOT CHANGED — needing their own ruling:
--   · conversation_audit_flags.audit_flags_view_policy (SELECT, same role-name
--     shape) plus its untenanted audit_flags_update_policy and its
--     audit_flags_insert_policy with `WITH CHECK (true)`. The table's only path
--     to a brokerage is conversation_id -> conversation_logs and that column is
--     NULLABLE, so an EXISTS join would silently drop every flag whose
--     conversation was never linked. Narrowing it is a judgement about orphaned
--     compliance flags, not a mechanical fix.
--   · The WRITE side generally: 1080 INSERT/UPDATE/DELETE policies sit on
--     tenant-column tables reachable by a tenant seat, and 52 of them are
--     untenanted AND ungated by the same classifier used above. The ruling as
--     given is about READS, so this pass did not touch them.
--
--
-- THE THREE `brokerage_id IS NULL` ARMS NAME THEIR ROLE. m394 ruled that a
-- policy admitting untenanted rows must say `TO authenticated`, because with no
-- TO clause the policy is granted to PUBLIC, and PUBLIC includes `anon` — so a
-- logged-out caller satisfies `brokerage_id IS NULL` and reads every untenanted
-- row on the table. scripts/rls-anon-tenant-escape-guard.ts holds that as a
-- frozen ratchet (43 statements, zero for new files) and went RED on the first
-- draft of this migration for exactly those three. The other six policies here
-- carry no such arm and keep the role they already had.
--
-- IDEMPOTENT. Safe to re-run.

begin;

-- ── (1) THE PREDICATE THAT COMPARED THE ROW TO ITSELF ───────────────────────

drop policy if exists client_gifts_brokerage_isolation on public.client_gifts;
create policy client_gifts_brokerage_isolation on public.client_gifts
  for all
  using (
    coalesce(
      brokerage_id is not null
      and brokerage_id in (select public.user_brokerage_ids()),
      false
    )
  );

drop policy if exists tyn_notes_brokerage on public.thank_you_notes;
create policy tyn_notes_brokerage on public.thank_you_notes
  for all
  using (
    coalesce(
      brokerage_id is not null
      and brokerage_id in (select public.user_brokerage_ids()),
      false
    )
  );

-- ── (2)+(3) THE ROLE NAME, AND THE ESCAPE THAT WAS NOT ONE ─────────────────

-- deal_team_members: the OR arm read `user_type in ('admin','super_admin')`.
-- 'super_admin' is not a legal user_type (dead); 'admin' is a TENANT type and
-- was the live cross-tenant key. Replaced with the real platform gate. The
-- sibling dtm_agent_insert already requires the tenant test on INSERT and is
-- untouched, so no write path narrows here that was not already narrow.
drop policy if exists dtm_brokerage_isolation on public.deal_team_members;
create policy dtm_brokerage_isolation on public.deal_team_members
  for all
  using (
    coalesce(
      (brokerage_id is not null and brokerage_id = public.current_user_brokerage_id())
      or public.is_platform_staff(),
      false
    )
  );

-- market_pulse: the USING read `auth.role() = 'authenticated' OR
-- is_platform_admin()`. The first arm is every signed-in user on the platform,
-- and the table carries brokerage_id. The `brokerage_id is null` arm preserves
-- the untenanted platform-wide pulse for everyone, which is the same idiom
-- chat_templates / seller_stage_coaching / knowledge_articles already use.
drop policy if exists market_pulse_select on public.market_pulse;
create policy market_pulse_select on public.market_pulse
  for select
  to authenticated
  using (
    coalesce(
      brokerage_id is null
      or brokerage_id in (select public.user_brokerage_ids())
      or public.is_platform_admin(),
      false
    )
  );

-- lead_deduplication_log: role-only gate beside an already-correct
-- lead_deduplication_log_tenant_select. The role test is carried through
-- UNCHANGED and merely pinned to the caller's own brokerage.
drop policy if exists "Brokers and admins can view dedup logs" on public.lead_deduplication_log;
create policy "Brokers and admins can view dedup logs" on public.lead_deduplication_log
  for select
  to authenticated
  using (
    coalesce(
      (brokerage_id is null or brokerage_id = public.current_user_brokerage_id())
      and exists (
        select 1 from public.users u
        where u.id = auth.uid()
          and u.user_type in ('broker', 'admin')
      ),
      false
    )
  );

-- vendor_access_logs: same shape, same fix. Sibling
-- vendor_access_logs_tenant_select already states the boundary.
drop policy if exists "Admins can view access logs" on public.vendor_access_logs;
create policy "Admins can view access logs" on public.vendor_access_logs
  for select
  using (
    coalesce(
      brokerage_id is not null
      and brokerage_id = public.current_user_brokerage_id()
      and exists (
        select 1 from public.users u
        where u.id = auth.uid()
          and u.user_type in ('admin', 'broker')
      ),
      false
    )
  );

-- conversation_logs: the agent-own arm is left EXACTLY as it was; only the
-- oversight arm is pinned. `brokerage_id is null` is carried through because
-- the sibling conversation_logs_tenant (ALL) already admits untenanted rows to
-- everyone and removing it here would make the two policies disagree.
drop policy if exists conversation_logs_agent_policy on public.conversation_logs;
create policy conversation_logs_agent_policy on public.conversation_logs
  for select
  to authenticated
  using (
    coalesce(
      (agent_id is not null and agent_id = public.current_user_agent_id())
      or (
        (brokerage_id is null or brokerage_id = public.current_user_brokerage_id())
        and exists (
          select 1 from public.users u
          where u.id = auth.uid()
            and u.user_type in ('admin', 'broker', 'compliance_officer')
        )
      ),
      false
    )
  );

-- video_completion_tracking: the agent-own arm untouched; the oversight arm
-- pinned; the dead 'superadmin' user_type literal replaced with the real gate.
drop policy if exists vct_select on public.video_completion_tracking;
create policy vct_select on public.video_completion_tracking
  for select
  using (
    coalesce(
      (agent_id in (select a.id from public.agents a where a.user_id = auth.uid()))
      or (
        brokerage_id is not null
        and brokerage_id = public.current_user_brokerage_id()
        and exists (
          select 1 from public.users u
          where u.id = auth.uid()
            and u.user_type in ('admin', 'broker')
        )
      )
      or public.is_platform_staff(),
      false
    )
  );

-- closing_disclosure_agreement_revisions: the policy ALREADY joins to
-- closing_disclosure_agreement — it just never asked which brokerage the
-- agreement belonged to. cda_id is NOT NULL and FK-constrained, so the join
-- cannot drop a row the way the conversation_audit_flags one would. The
-- agent-own arm (a.user_id = u.id) is carried through unchanged; the dead
-- 'superadmin' user_type literal becomes the real platform gate.
drop policy if exists cda_revisions_select on public.closing_disclosure_agreement_revisions;
create policy cda_revisions_select on public.closing_disclosure_agreement_revisions
  for select
  using (
    coalesce(
      public.is_platform_staff()
      or exists (
        select 1
        from public.closing_disclosure_agreement c
        join public.users u on u.id = auth.uid()
        where c.id = closing_disclosure_agreement_revisions.cda_id
          and (
            (
              c.brokerage_id is not null
              and c.brokerage_id = public.current_user_brokerage_id()
              and u.user_type in ('compliance_officer', 'admin', 'broker', 'broker_admin')
            )
            or exists (
              select 1 from public.agents a
              where a.id = c.agent_id and a.user_id = u.id
            )
          )
      ),
      false
    )
  );

commit;

-- ═══════════════════════════════════════════════════════════════════════════
-- SECOND HALF — THE PROBE THAT KEEPS THIS HONEST
--
-- scripts/cross-tenant-read-simulator.ts is a supabase-js client. It cannot
-- read pg_policies (PostgREST does not expose the catalogue) and it cannot
-- become a tenant seat (there is no way to set request.jwt.claims over the
-- wire). Both of those are exactly what a cross-tenant READ proof has to do, so
-- the probe lives HERE, where it can, and the simulator calls it.
--
-- Modelled on the existing public.assert_tenant_isolation(), including its
-- set_config('role', …) / set_config('request.jwt.claims', …) impersonation and
-- its seed-measure-clean shape. Not SECURITY DEFINER, for the same reason that
-- one is not: it must run AS the caller so the role switch is real.
--
-- IT ASSERTS BOTH DIRECTIONS. A policy that returns nothing to anybody is not a
-- fixed policy, it is a different bug — so `own_visible` is reported beside
-- `other_visible` and both are required.
--
-- THE CENSUS STATES ITS OWN LIMIT. A token classifier cannot see OR arms:
-- `tenant_test OR some_untenanted_role_check` contains a tenant token and is
-- still a hole. That is precisely what deal_team_members was, and it is why the
-- seat probe exists rather than the census alone. The census is the wide net
-- (735 read-capable policies across every tenant table); the seat probe is the
-- deep one (six tables, behaviourally, through real RLS).
--
-- WHY THE auth.uid() STRIP. `auth.uid()` appearing in an expression does not
-- make it a tenant test. In `exists (select 1 from users where users.id =
-- auth.uid() and users.user_type in ('broker','admin'))` the only thing
-- auth.uid() does is LOOK UP THE CALLER'S ROLE — no row column is constrained
-- by it, and that is the defect m471 removed from six policies. So the
-- caller-lookup form is stripped first and what survives is auth.uid() compared
-- to a ROW column (agents.user_id, contact_user_id, agent_user_id …), which IS
-- row scoping. The strip is `\m(users|u)\.id = auth.uid()` and NOT
-- `\w*\.?id = auth.uid()`: MEASURED both ways, the greedy form also swallowed
-- `agents.user_id = auth.uid()` and flagged 26 genuinely self-scoped policies
-- as holes.
--
-- AND IT SELF-TESTS. The same classifier is run over the four PRE-FIX
-- expressions, verbatim from pg_policies before this migration. All four must
-- come back as holes (classifier_selftest = 4) or the zero is meaningless and
-- `ok` is false. A census that has never gone red on anything is
-- indistinguishable from one that cannot.
--
-- APPLIED as catalogue versions m471b/m471c/m471d/m471e (FK seed, plpgsql 42702
-- variable shadowing, CHECK-constraint vocabulary, the `false`-qual false
-- positive, then this classifier). This file is the source of truth for the
-- final body.
-- ═══════════════════════════════════════════════════════════════════════════

begin;

create or replace function public.assert_cross_tenant_read_isolation()
returns jsonb language plpgsql as $function$
declare
  bA uuid; bB uuid; uA uuid := gen_random_uuid(); uB uuid := gen_random_uuid();
  aA uuid; aB uuid; cA uuid; cB uuid;
  own jsonb := '{}'::jsonb; other jsonb := '{}'::jsonb;
  n int; seat_err text := null;
  -- deliberately NOT named tenant_tested / platform_gated: the census CTE below
  -- projects columns with those names and plpgsql resolves the bare identifier
  -- to the VARIABLE, so `count(*) filter (where tenant_tested)` fails 42702.
  n_read int; n_tenant int; n_platform int; untenanted text[]; n_selftest int;
begin
  insert into public.brokerages (name,email,plan_tier,onboarding_status)
    values ('__xtenant_read_A','__xt_a@selftest.local','brokerage','pending') returning id into bA;
  insert into public.brokerages (name,email,plan_tier,onboarding_status)
    values ('__xtenant_read_B','__xt_b@selftest.local','brokerage','pending') returning id into bB;
  -- The identity the ruling CONFINES: a tenant broker. platform_role stays NULL,
  -- so is_platform_staff() is false for this seat.
  insert into public.users (id,email,first_name,last_name,user_type,brokerage_id,is_contact)
    values (uA,'__xt_a_user@selftest.local','XT','A','broker',bA,false);
  -- agents.user_id is FK-constrained to users, so tenant B needs a real seat too
  insert into public.users (id,email,first_name,last_name,user_type,brokerage_id,is_contact)
    values (uB,'__xt_b_user@selftest.local','XT','B','agent',bB,false);
  insert into public.agents (user_id, brokerage_id) values (uA, bA) returning id into aA;
  insert into public.agents (user_id, brokerage_id) values (uB, bB) returning id into aB;
  insert into public.contacts (brokerage_id, first_name, last_name) values (bA,'XT','A') returning id into cA;
  insert into public.contacts (brokerage_id, first_name, last_name) values (bB,'XT','B') returning id into cB;

  insert into public.client_gifts (brokerage_id, agent_id, contact_id, occasion, gift_name)
    values (bA,aA,cA,'__xt','__xt'), (bB,aB,cB,'__xt','__xt');
  insert into public.thank_you_notes (brokerage_id, agent_id, contact_id, occasion, body)
    values (bA,aA,cA,'__xt','__xt'), (bB,aB,cB,'__xt','__xt');
  -- market_pulse is UNIQUE (scope, pulse_week) — one row per scope per week for
  -- the WHOLE platform, itself evidence that its brokerage_id is vestigial.
  insert into public.market_pulse (brokerage_id, scope, pulse_week)
    values (bA,'__xtA',current_date), (bB,'__xtB',current_date);
  -- stage/action_taken carry CHECK constraints; use legal vocabulary values.
  insert into public.lead_deduplication_log (brokerage_id, stage, action_taken)
    values (bA,'lead_creation','skipped'), (bB,'lead_creation','skipped');
  insert into public.deal_team_members (brokerage_id, name) values (bA,'__xt'), (bB,'__xt');
  insert into public.conversation_logs (brokerage_id, start_time) values (bA, now()), (bB, now());

  begin
    perform set_config('role','authenticated', true);
    perform set_config('request.jwt.claims', json_build_object('sub', uA::text, 'role','authenticated')::text, true);
    select count(*) into n from public.client_gifts           where brokerage_id = bA; own   := own   || jsonb_build_object('client_gifts', n);
    select count(*) into n from public.client_gifts           where brokerage_id = bB; other := other || jsonb_build_object('client_gifts', n);
    select count(*) into n from public.thank_you_notes        where brokerage_id = bA; own   := own   || jsonb_build_object('thank_you_notes', n);
    select count(*) into n from public.thank_you_notes        where brokerage_id = bB; other := other || jsonb_build_object('thank_you_notes', n);
    select count(*) into n from public.market_pulse           where brokerage_id = bA; own   := own   || jsonb_build_object('market_pulse', n);
    select count(*) into n from public.market_pulse           where brokerage_id = bB; other := other || jsonb_build_object('market_pulse', n);
    select count(*) into n from public.lead_deduplication_log where brokerage_id = bA; own   := own   || jsonb_build_object('lead_deduplication_log', n);
    select count(*) into n from public.lead_deduplication_log where brokerage_id = bB; other := other || jsonb_build_object('lead_deduplication_log', n);
    select count(*) into n from public.deal_team_members      where brokerage_id = bA; own   := own   || jsonb_build_object('deal_team_members', n);
    select count(*) into n from public.deal_team_members      where brokerage_id = bB; other := other || jsonb_build_object('deal_team_members', n);
    select count(*) into n from public.conversation_logs      where brokerage_id = bA; own   := own   || jsonb_build_object('conversation_logs', n);
    select count(*) into n from public.conversation_logs      where brokerage_id = bB; other := other || jsonb_build_object('conversation_logs', n);
  exception when others then seat_err := sqlerrm; end;

  perform set_config('role','service_role', true);
  perform set_config('request.jwt.claims','', true);

  delete from public.client_gifts           where brokerage_id in (bA,bB);
  delete from public.thank_you_notes        where brokerage_id in (bA,bB);
  delete from public.market_pulse           where brokerage_id in (bA,bB) or scope in ('__xtA','__xtB');
  delete from public.lead_deduplication_log where brokerage_id in (bA,bB);
  delete from public.deal_team_members      where brokerage_id in (bA,bB);
  delete from public.conversation_logs      where brokerage_id in (bA,bB);
  delete from public.contacts               where brokerage_id in (bA,bB);
  delete from public.agents                 where brokerage_id in (bA,bB);
  delete from public.users                  where id in (uA,uB);
  delete from public.brokerages             where id in (bA,bB);

  with p as (
    select tablename, policyname, coalesce(qual,'')||' '||coalesce(with_check,'') as e,
           coalesce(qual,'') as qual_only, roles::text[] as r
    from pg_policies where schemaname='public' and cmd in ('SELECT','ALL')
  ), reachable as (
    select * from p where r && array['authenticated','public'] and e !~ 'service_role'
      -- A policy whose USING is literally `false` grants nothing to anyone. It is
      -- maximally restrictive, not untenanted — and it is the one row the first
      -- run of this census flagged (seller_stage_coaching_service_write), exactly
      -- the kind of vacuous red a classifier must not produce.
      and btrim(coalesce(qual_only,'')) not in ('false','(false)')
      and exists (select 1 from information_schema.columns c
                  where c.table_schema='public' and c.table_name=p.tablename and c.column_name='brokerage_id')
  ), classed as (
    select tablename, policyname,
      (e ~ 'current_user_brokerage_id|user_brokerage_ids|has_brokerage_access|can_access_support_ticket|can_write_service_area|vendor_has_contact_access|vendor_has_transaction_access'
       or (e ~ 'brokerage_id' and e ~ 'auth\.uid\(\)')
       or regexp_replace(e, '\m(users|u)\.id\s*=\s*auth\.uid\(\)', '', 'g') ~ 'auth\.uid\(\)'
       or e ~ 'current_user_agent_id|is_own_agent_id|is_self_contact|is_current_user_vendor|is_current_user_marketplace_vendor|portal_member_searches') as tenant_tested,
      (e ~ 'is_platform_staff|is_platform_admin|can_read_tenant_financials') as platform_gated
    from reachable )
  select count(*), count(*) filter (where tenant_tested), count(*) filter (where platform_gated),
         coalesce(array_agg(tablename||'.'||policyname) filter (where not tenant_tested and not platform_gated),'{}')
    into n_read, n_tenant, n_platform, untenanted from classed;

  -- SELF-TEST: the same classifier over the four PRE-FIX expressions, verbatim.
  -- All four must come back as holes, or the zero above proves nothing.
  select count(*) into n_selftest from (
    select unnest(array[
      '(brokerage_id = ( SELECT agents.brokerage_id FROM agents WHERE (agents.id = client_gifts.agent_id) LIMIT 1))',
      '(brokerage_id = ( SELECT agents.brokerage_id FROM agents WHERE (agents.id = thank_you_notes.agent_id) LIMIT 1))',
      '(EXISTS ( SELECT 1 FROM users WHERE ((users.id = auth.uid()) AND (users.user_type = ANY (ARRAY[''broker''::text, ''admin''::text])))))',
      '((auth.role() = ''authenticated''::text))'
    ]) as e) s
  where e !~ 'current_user_brokerage_id|user_brokerage_ids|has_brokerage_access|can_access_support_ticket|can_write_service_area|vendor_has_contact_access|vendor_has_transaction_access'
    and e !~ 'is_platform_staff|is_platform_admin|can_read_tenant_financials'
    and not (e ~ 'brokerage_id' and e ~ 'auth\.uid\(\)')
    and regexp_replace(e, '\m(users|u)\.id\s*=\s*auth\.uid\(\)', '', 'g') !~ 'auth\.uid\(\)'
    and e !~ 'current_user_agent_id|is_own_agent_id|is_self_contact|is_current_user_vendor|is_current_user_marketplace_vendor|portal_member_searches';

  return jsonb_build_object(
    'ok', (seat_err is null
           and (select bool_and(value::int = 0) from jsonb_each_text(other))
           and (select bool_and(value::int > 0) from jsonb_each_text(own))
           and n_selftest = 4
           and coalesce(array_length(untenanted,1),0) = 0),
    'seat_error', seat_err, 'own_visible', own, 'other_visible', other,
    'census', jsonb_build_object('read_capable_tenant_tables', n_read,
      'tenant_tested', n_tenant, 'platform_gated', n_platform,
      'classifier_selftest', n_selftest,
      'untenanted_and_ungated', to_jsonb(untenanted)));
end $function$;

commit;
