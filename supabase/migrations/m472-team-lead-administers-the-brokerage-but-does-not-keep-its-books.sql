-- m472 — A TEAM LEAD ADMINISTERS THE BROKERAGE BUT DOES NOT KEEP ITS BOOKS
--
-- OWNER RULING (this migration exists to execute it), verbatim:
--
--   "Admin surfaces, but NOT brokerage-wide money. team_lead joins the roster for
--    operational admin gates (support, onboarding, assignment rules, roster,
--    marketing). Hold it OUT of the ~18 brokerage-wide financial gates —
--    financial-kernel, brokerage-fees, accounting-sync, income-engine, billing,
--    revenue-share, CDA storage, net-sheet overrides — which stay
--    broker/broker_owner/admin. Also add team_lead to is_brokerage_admin() so app
--    and DB agree on the non-money gates."
--
-- ── WHY THE OBVIOUS EDIT IS THE WRONG EDIT ──────────────────────────────────
-- The last sentence of the ruling, taken alone, is one word: add 'team_lead' to
-- is_brokerage_admin(). Doing only that would have executed the OPPOSITE of the
-- first sentence.
--
-- MEASURED on the live catalogue before writing a line:
--   public.is_brokerage_admin() is composed by 226 POLICIES OVER 113 TABLES.
--   (225/112 when m466 measured it; m471 added tenant_transition_log.)
--   0 of the 226 use it NEGATED — re-checked, because widening a term under a
--     NOT inverts its meaning, and a widening that silently REVOKES is the worst
--     outcome available here.
--
-- Those 113 tables are NOT one population. They include commission_splits,
-- agent_cap_tracking, brokerage_p_l, billing_invoices, vendor_payouts,
-- closing_disclosure and accounting_sync_log — the brokerage's books, which the
-- ruling's FIRST sentence holds team_lead out of. One function cannot answer two
-- questions, so the single predicate had to become two:
--
--   public.is_brokerage_admin()          WIDENED, +team_lead. OPERATIONAL admin.
--   public.is_brokerage_finance_admin()  NEW, and narrower: the CURRENT three
--                                        roles. BROKERAGE-WIDE MONEY.
--
-- This is the m466 shape run a second time and in the other direction. m466
-- argued against forking a second helper because "two definitions of admin is
-- precisely the drift this repo keeps paying to close." That argument still
-- holds for two definitions of the SAME question. This is a fork of the
-- QUESTION, not of the answer: the two predicates govern disjoint table sets,
-- every table belongs to exactly one, and the split is asserted below so it
-- cannot silently stop being a partition.
--
-- ── THE SPLIT, AND THE RULE THAT DECIDED IT ─────────────────────────────────
-- A table is FINANCE if a team lead reading or writing it would EXPOSE OR ALTER
-- MONEY BEYOND THEIR OWN TEAM. Judged by the COLUMNS the table holds, not by the
-- word in its name — which changed the answer in both directions:
--
--   tier_distributions LOOKS like revenue-share tiers. Its FK is
--     tier_id → listing_marketing_tiers, and its columns are asset_type /
--     channel_type / is_required. It is MARKETING asset configuration and holds
--     no amount at all. → OPERATIONAL.
--   transaction_agent_roles LOOKS like a roster table. It holds
--     split_override_percent and flat_override_amount — a per-transaction
--     commission override on ANY transaction in the tenant. → FINANCE.
--   recruiting_analytics LOOKS like a report. It holds
--     brokerage_net_from_agent and gross_commission_generated. → FINANCE.
--   vendor_usage_tracking LOOKS like telemetry. It holds cost_per_unit and
--     total_cost. → FINANCE.
--
-- MEASURED PARTITION: 49 FINANCE tables / 138 policies.
--                     64 OPERATIONAL tables / 88 policies.
--                     49 + 64 = 113 and 138 + 88 = 226. Nothing is in both, and
--                     nothing is in neither. Asserted at the end of this file.
--
-- ── THE THREE TABLES THAT ARE NOT ABOUT MONEY AND ARE STILL IN THE FINANCE SET
-- These are the load-bearing ones, so the reasoning is written out rather than
-- asserted:
--
--   user_role_assignments, user_brokerage_roles
--     These do not hold a single currency column. They are in the narrow set
--     because THE NARROW PREDICATE READS user_role_assignments. Its second
--     branch admits anyone holding an 'admin' / 'broker' / 'broker_owner' grant
--     on their own brokerage — m466 made a grant an administering fact. Their
--     write policies are `brokerage_id = current_user_brokerage_id() AND
--     is_brokerage_admin()`. Had those stayed on the WIDE predicate, a team lead
--     could INSERT themselves a 'broker' grant on their own brokerage and be a
--     finance admin one round-trip later. The separation this migration exists
--     to create would have been self-serve. A gate that can mint its own key is
--     not a gate.
--
--   brokerages
--     The tenant row. Its UPDATE policy is
--     `is_platform_admin() OR (is_brokerage_admin() AND id = current_user_brokerage_id())`
--     and the row carries plan_tier, billing_metadata, revenue_share_enabled,
--     default_cap_amount, default_cap_anniversary_basis, non_cda_payout_default,
--     offers_cda, recruiting_split_to_agent and recruiting_monthly_fee. That is
--     the revenue-share master switch and the brokerage-wide default cap — two
--     of the gates the ruling names by name. It also carries name, logo_url,
--     about_text and recruiting_pitch, which are marketing and therefore
--     operational. RLS is a ROW gate; there is no column-level split available
--     here without a column-guard trigger, which is a different migration with a
--     different blast radius. FAILED CLOSED, and FLAGGED at the foot of this
--     file as the one place the ruling's two halves genuinely collide.
--
--   teams
--     Holds cap_amount, team_split_type, team_split_value, team_split_percent,
--     team_fees_json and member_overrides_json, and the policies are
--     tenant-wide, not own-team — so on the wide predicate a team lead could
--     rewrite ANOTHER team's cap and splits. That is money beyond their own
--     team, which is the test verbatim. → FINANCE.
--     THIS COSTS THE TEAM LEAD NOTHING THEY HAVE TODAY, and that is measured,
--     not assumed: teams_tenant_update already reads
--     `(brokerage_id = current_user_brokerage_id()) AND (is_brokerage_admin()
--     OR team_lead_id = auth.uid())`, so a lead keeps their own team through the
--     SECOND disjunct, which this migration does not touch. And team ROSTER
--     lives in public.team_members, which does not compose is_brokerage_admin()
--     at all — so "roster", which the ruling calls operational, is unaffected.
--
-- ── CLOSE CALLS, RESOLVED FAIL-CLOSED AND NAMED SO THEY CAN BE REOPENED ─────
--   budgets                  income_goal per agent. The policy already carries
--                            `agent_id = current_user_agent_id()`, so a team
--                            lead keeps their OWN budget either way; only
--                            "manage anyone's" goes narrow.
--   business_expenses        amount + receipt_url, and it carries team_id, so
--                            tenant-wide read IS cross-team.
--   credit_accounts          consumer credit scores and credit_amount.
--   buyer_financial_profiles pre_approval_amount, proof_of_funds_doc_id.
--   client_documents         is_financial_verification, verification_amount,
--                            verification_lender. MEASURED: 0 rows, so this
--                            blanks no live read. Its other disjunct is the
--                            caller's OWN transactions and has no team term, so
--                            a team lead reads exactly what they read today.
--   recruiting_costs/_roi    amount, roi_pct, lifetime_brokerage_net.
--   referrals/referral_partners  commission_amount, referral_fee_pct,
--                            commission_split_percentage.
-- The last four are unambiguous once the columns are read. The first five are
-- consumer- or agent-level rather than brokerage-wide, and are held narrow on
-- the fail-closed rule: an ambiguous money table goes to the tighter gate.
--
-- ── WHAT DOES NOT CHANGE, AND WHY THAT IS THE POINT ─────────────────────────
-- MEASURED: the only three FUNCTIONS besides policies that compose
-- is_brokerage_admin() are
--   can_access_support_ticket                      → support
--   agent_licenses_verification_is_not_self_service → onboarding / compliance
--   can_write_service_area (m465)                  → assignment rules
-- The ruling names support, onboarding and assignment rules as OPERATIONAL, so
-- all three are meant to widen and all three are left alone. There is no
-- finance-side function consumer to repoint. That is a measurement, not luck —
-- it is why the split can be done entirely in policies.
--
-- public.can_read_brokerage_books() (m467) is NOT TOUCHED and needs no change.
-- It is the finance READ gate over 24 policies, it admits
-- admin/broker/broker_owner/broker_admin/compliance_officer, and team_lead is
-- not among them and is not being added. The books were already unreadable to a
-- team lead; this migration makes them unwritable too, which is the pair m467
-- itself argued must not come apart ("a gate that admits a write and refuses the
-- corresponding read is not a narrower policy, it is a broken one").
--
-- ── WHY THE REPOINT IS A LOOP AND NOT 138 HAND-WRITTEN POLICIES ─────────────
-- m466 rewrote its five policies longhand because there were five and each one
-- also gained a NEW tenant term. Here there are 138 and NOTHING ELSE ABOUT THEM
-- CHANGES: every other disjunct — the agent's own row, the transaction they own,
-- the compliance-officer term, has_brokerage_access, is_platform_admin — must
-- survive byte for byte. Re-typing 138 expressions to alter one call in each is
-- the shape that loses a disjunct nobody remembers was load-bearing. The loop
-- reads the CURRENT expression out of the catalogue, substitutes the one
-- function call, and puts it back, so every other term is preserved by
-- construction rather than by proofreading. It asserts its own coverage
-- afterwards.
--
-- Substring safety, checked rather than assumed: 'is_brokerage_finance_admin()'
-- does NOT contain 'is_brokerage_admin()' as a substring — the '_finance' sits
-- between the two halves — so re-running the loop matches nothing and the
-- migration is idempotent on the policy side as well as the function side.
--
-- IDEMPOTENT. Safe to re-run.

begin;

set local search_path to 'public', 'pg_temp';

-- ── THE WIDENED PREDICATE — OPERATIONAL ADMIN ───────────────────────────────
-- team_lead is added to BOTH branches. One branch would have been a bug that
-- reads as a rule: user_type='team_lead' and a 'team_lead' GRANT are two live
-- spellings of the same seat on this database (MEASURED: 1 row of each), and
-- admitting one while refusing the other is the app/DB disagreement in
-- miniature.
--
-- Everything else about this function is carried through from m466 verbatim —
-- the tenant pin on the grant, the EXISTS rather than a LIMIT 1, the SECURITY
-- DEFINER, the pinned search_path, and the coalesce placement. The comments
-- explaining those decisions are kept because the reasoning is what stops the
-- next edit from undoing them.
create or replace function public.is_brokerage_admin()
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  -- coalesce(..., false) WRAPS THE WHOLE OR, and that placement is the point.
  -- `x = auth.uid()` is NULL when auth.uid() is NULL, and SQL three-valued logic
  -- carries that NULL out through OR and AND. RLS treats NULL as unsatisfied so
  -- it fails closed and exposes nothing — but a boolean function that answers
  -- NULL is a trap for anything that composes it (a NOT, a coalesce with a
  -- different default, a join), and this one is composed by 226 policies and
  -- three functions. The first branch is a scalar subquery that is NULL when the
  -- caller has no users row, so `NULL or false` would be NULL without this.
  select coalesce(
    -- BRANCH 1 — user_type.
    (select u.user_type in ('admin', 'broker', 'broker_owner', 'team_lead')
     from public.users u
     where u.id = auth.uid()
     limit 1)

    -- BRANCH 2 — a TENANT ROLE GRANT. A grant is an administering fact (m466).
    --
    -- PINNED to current_user_brokerage_id(): the grant must administer the
    -- caller's OWN brokerage. A grant on another brokerage matches nothing here,
    -- so it authorises nothing in any of the 226 policies.
    --
    -- No LIMIT 1 and no .single(): user_role_assignments is UNIQUE on
    -- (user_id, role), NOT on user_id, so holding several grants at once is
    -- legal AND LIVE — one account holds three (admin + agent + isa). EXISTS is
    -- the right shape precisely because it is indifferent to how many match.
    or exists (
      select 1
      from public.user_role_assignments ura
      where ura.user_id      = auth.uid()
        and ura.role         in ('admin', 'broker', 'broker_owner', 'team_lead')
        and ura.brokerage_id is not null
        and ura.brokerage_id = public.current_user_brokerage_id()
    ),
    false  -- could-not-establish = no.
  );
$$;

comment on function public.is_brokerage_admin() is
  'OPERATIONAL tenant admin. TRUE when the caller administers their own brokerage, by users.user_type IN (admin,broker,broker_owner,team_lead) OR by a role grant in user_role_assignments on their OWN brokerage_id. Mirrors isAdminOrBroker/resolveTenantAdmin in lib/auth/resolve-user-role.ts. NOT the gate for brokerage-wide money — that is public.is_brokerage_finance_admin(), which excludes team_lead. A grant on another brokerage authorises nothing. Takes no argument and therefore cannot see the row: the policies that pair it with has_brokerage_access(brokerage_id) get row-pinned semantics from that composition. Returns a strict boolean, never NULL. See m466, m472.';

-- ── THE NARROW PREDICATE — BROKERAGE-WIDE MONEY ─────────────────────────────
-- The role list here is is_brokerage_admin()'s list AS IT STOOD BEFORE THIS
-- MIGRATION, unchanged. That is deliberate and it is what makes the finance side
-- of this migration a NO-OP for every account that exists today: every caller
-- the finance tables admitted an hour ago is admitted by this function, and the
-- only role that gains nothing is the one the ruling holds out.
--
-- BOTH branches carry the three-role list, for the same reason the widened one
-- carries team_lead in both: m466 established that a grant administers, and a
-- finance predicate that honoured user_type but not the grant would refuse the
-- ruling's SECOND SEAT — the grant-only admin (user_type 'agent' holding an
-- 'admin' grant, live on this database) — at exactly the tables m467 already
-- taught to let them READ. Write-refused-while-read-allowed is the same broken
-- pair m467 closed, inverted.
create or replace function public.is_brokerage_finance_admin()
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  -- Same coalesce placement, same reason, same strict-boolean contract as
  -- is_brokerage_admin(). This function is composed by 138 policies; a NULL
  -- escaping it would be a trap in every one of them.
  select coalesce(
    (select u.user_type in ('admin', 'broker', 'broker_owner')
     from public.users u
     where u.id = auth.uid()
     limit 1)
    or exists (
      select 1
      from public.user_role_assignments ura
      where ura.user_id      = auth.uid()
        and ura.role         in ('admin', 'broker', 'broker_owner')
        and ura.brokerage_id is not null
        and ura.brokerage_id = public.current_user_brokerage_id()
    ),
    false
  );
$$;

comment on function public.is_brokerage_finance_admin() is
  'BROKERAGE-WIDE MONEY gate. TRUE when the caller may alter the brokerage''s books: users.user_type IN (admin,broker,broker_owner) OR a role grant in those roles on their OWN brokerage_id. Deliberately EXCLUDES team_lead, which public.is_brokerage_admin() admits — owner ruling: admin surfaces yes, brokerage-wide money no. Mirrors isBrokerageFinanceAdmin in lib/auth/resolve-user-role.ts. Governs the 49 finance tables; the operational tables stay on is_brokerage_admin(). The READ side of the same books is public.can_read_brokerage_books() (m467), which is a wider circle again because a compliance officer reads them without administering. Returns a strict boolean, never NULL. See m472.';

-- ── THE REPOINT ─────────────────────────────────────────────────────────────
-- The 49 FINANCE tables. Named once, here, and reused by both the loop and the
-- assertions below so the list cannot drift between deciding and checking.
create temporary table m472_finance_tables (tablename text primary key) on commit drop;
insert into m472_finance_tables (tablename) values
  ('accounting_sync_log'),        ('agent_cap_tracking'),      ('agent_commission_profiles'),
  ('agent_commissions'),          ('agent_earnings'),          ('agent_fee_assignments'),
  ('agent_fee_charges'),          ('agent_monthly_earnings'),  ('billing_invoices'),
  ('billing_usage'),              ('brokerage_earnings'),      ('brokerage_fee_types'),
  ('brokerage_p_l'),              ('brokerages'),              ('budgets'),
  ('business_expenses'),          ('buyer_financial_profiles'),('cda_comparison_results'),
  ('client_documents'),           ('closing_disclosure'),      ('closing_disclosure_agreement'),
  ('commission_adjustments'),     ('commission_calculations'), ('commission_rules'),
  ('commission_splits'),          ('commission_structures'),   ('credit_accounts'),
  ('earnings_history'),           ('financial_reports'),       ('net_sheet_calculations'),
  ('recruiting_analytics'),       ('recruiting_costs'),        ('recruiting_roi'),
  ('referral_partners'),          ('referrals'),               ('subscriptions'),
  ('team_cap_tracking'),          ('team_commission_profiles'),('team_earnings'),
  ('teams'),                      ('transaction_agent_roles'), ('user_brokerage_roles'),
  ('user_role_assignments'),      ('vendor_earnings'),         ('vendor_invoices'),
  ('vendor_payouts'),             ('vendor_subscriptions'),    ('vendor_transactions'),
  ('vendor_usage_tracking');

-- Every named table must actually exist and actually compose is_brokerage_admin().
-- A typo in the list above would otherwise leave a finance table on the WIDE gate
-- silently — the exact failure this migration exists to prevent, reintroduced by
-- a keystroke. Fails the transaction rather than reporting success.
do $$
declare missing text;
begin
  select string_agg(f.tablename, ', ' order by f.tablename) into missing
  from m472_finance_tables f
  where not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = f.tablename
      and (coalesce(p.qual,'') like '%is_brokerage_admin%'
           or coalesce(p.with_check,'') like '%is_brokerage_admin%'
           or coalesce(p.qual,'') like '%is_brokerage_finance_admin%'
           or coalesce(p.with_check,'') like '%is_brokerage_finance_admin%')
  );
  if missing is not null then
    raise exception 'm472: named finance table(s) compose neither predicate: %', missing;
  end if;
end $$;

-- Substitute the call, preserving every other term by construction.
-- ALTER POLICY rather than DROP+CREATE: the policy keeps its name, its command,
-- and its role list, and there is no window inside this transaction where the
-- table is unguarded.
do $$
declare
  r         record;
  new_qual  text;
  new_check text;
  touched   int := 0;
begin
  for r in
    select p.tablename, p.policyname, p.qual, p.with_check
    from pg_policies p
    join m472_finance_tables f on f.tablename = p.tablename
    where p.schemaname = 'public'
      and (coalesce(p.qual,'') like '%is_brokerage_admin(%'
           or coalesce(p.with_check,'') like '%is_brokerage_admin(%')
    order by p.tablename, p.policyname
  loop
    new_qual  := replace(coalesce(r.qual,''),       'is_brokerage_admin()', 'public.is_brokerage_finance_admin()');
    new_check := replace(coalesce(r.with_check,''), 'is_brokerage_admin()', 'public.is_brokerage_finance_admin()');

    -- USING and WITH CHECK are set independently: an INSERT policy has no USING
    -- and a SELECT/DELETE policy has no WITH CHECK, and inventing the missing
    -- one would change what the policy means.
    if r.qual is not null and r.with_check is not null then
      execute format('alter policy %I on public.%I using (%s) with check (%s)',
                     r.policyname, r.tablename, new_qual, new_check);
    elsif r.qual is not null then
      execute format('alter policy %I on public.%I using (%s)',
                     r.policyname, r.tablename, new_qual);
    else
      execute format('alter policy %I on public.%I with check (%s)',
                     r.policyname, r.tablename, new_check);
    end if;

    touched := touched + 1;
  end loop;

  raise notice 'm472: repointed % finance polic(ies) onto is_brokerage_finance_admin()', touched;
end $$;

-- ── THE PARTITION, ASSERTED ─────────────────────────────────────────────────
-- Three separate claims, because each can fail on its own and a single count
-- would hide two of them:
--   (1) no finance table still composes the WIDE predicate — the whole point;
--   (2) no OPERATIONAL table composes the NARROW one — a stray repoint would
--       silently REVOKE a team lead's operational admin, which is the failure
--       mode m466 called "the worst outcome available here";
--   (3) the two sets still cover every table the wide predicate had, so no
--       policy fell out of both while the loop ran.
do $$
declare
  leaked_wide     int;
  leaked_narrow   int;
  fin_tables      int;
  fin_policies    int;
  ops_tables      int;
  ops_policies    int;
begin
  select count(*) into leaked_wide
  from pg_policies p join m472_finance_tables f on f.tablename = p.tablename
  where p.schemaname='public'
    and (coalesce(p.qual,'') like '%is_brokerage_admin(%'
         or coalesce(p.with_check,'') like '%is_brokerage_admin(%');
  if leaked_wide <> 0 then
    raise exception 'm472: % finance polic(ies) still compose the WIDE is_brokerage_admin()', leaked_wide;
  end if;

  select count(*) into leaked_narrow
  from pg_policies p
  where p.schemaname='public'
    and p.tablename not in (select tablename from m472_finance_tables)
    and (coalesce(p.qual,'') like '%is_brokerage_finance_admin%'
         or coalesce(p.with_check,'') like '%is_brokerage_finance_admin%');
  if leaked_narrow <> 0 then
    raise exception 'm472: % OPERATIONAL polic(ies) were repointed onto the NARROW predicate', leaked_narrow;
  end if;

  select count(distinct tablename), count(*) into fin_tables, fin_policies
  from pg_policies where schemaname='public'
    and (coalesce(qual,'') like '%is_brokerage_finance_admin%'
         or coalesce(with_check,'') like '%is_brokerage_finance_admin%');

  select count(distinct tablename), count(*) into ops_tables, ops_policies
  from pg_policies where schemaname='public'
    and (coalesce(qual,'') like '%is_brokerage_admin(%'
         or coalesce(with_check,'') like '%is_brokerage_admin(%');

  raise notice 'm472: FINANCE % tables / % policies · OPERATIONAL % tables / % policies',
    fin_tables, fin_policies, ops_tables, ops_policies;

  if fin_tables + ops_tables <> 113 then
    raise exception 'm472: partition covers % tables, expected 113', fin_tables + ops_tables;
  end if;
  if fin_policies + ops_policies <> 226 then
    raise exception 'm472: partition covers % policies, expected 226', fin_policies + ops_policies;
  end if;
end $$;

-- ── THE FACTS THE PROOF READS, RATHER THAN RESTATING ────────────────────────
-- scripts/finance-authority-simulator.ts must be able to check that the APP's two
-- role sets and the DATABASE's two role sets are the same sets. A proof that
-- retyped the roles on the test side would pass while both sides were wrong
-- together — it would assert its own assumption. So this function EXTRACTS the
-- role lists out of the live function bodies and hands them over, and the proof
-- compares them against lib/auth/resolve-user-role.ts. Same precedent as
-- public.tenant_scope_facts() and public.assert_cross_tenant_read_isolation():
-- pg_proc and pg_policies are not reachable through PostgREST, so a read-only
-- facts RPC is how a simulator gets at the catalogue at all.
--
-- branch_count is returned because it is the claim most likely to rot: BOTH the
-- user_type branch AND the grant branch must carry the role list. A predicate
-- that widened only one of them would still look right in a single role array,
-- and would refuse or admit the wrong half of a live seat — user_type='team_lead'
-- and a 'team_lead' GRANT are both live on this database.
--
-- Read-only, no arguments, no user data, no SECURITY DEFINER: it reports the
-- shape of the catalogue, so it needs no privilege the caller does not have.
create or replace function public.finance_authority_facts()
returns jsonb
language sql
stable
set search_path to 'public', 'pg_temp'
as $fn$
  with defs as (
    select p.proname,
           (select array_agg(distinct btrim(btrim(w), chr(39)))
              from regexp_matches(pg_get_functiondef(p.oid), 'in \(([^)]*)\)', 'g') m,
                   unnest(string_to_array(m[1], ',')) w) as roles,
           (select count(*)
              from regexp_matches(pg_get_functiondef(p.oid), 'in \(([^)]*)\)', 'g')) as branch_count
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('is_brokerage_admin', 'is_brokerage_finance_admin')
  )
  select jsonb_build_object(
    'wide_roles',      (select roles        from defs where proname = 'is_brokerage_admin'),
    'wide_branches',   (select branch_count from defs where proname = 'is_brokerage_admin'),
    'narrow_roles',    (select roles        from defs where proname = 'is_brokerage_finance_admin'),
    'narrow_branches', (select branch_count from defs where proname = 'is_brokerage_finance_admin'),
    'finance_tables',  (select count(distinct tablename) from pg_policies where schemaname='public'
                          and (coalesce(qual,'') like '%is_brokerage_finance_admin%'
                            or coalesce(with_check,'') like '%is_brokerage_finance_admin%')),
    'finance_policies',(select count(*) from pg_policies where schemaname='public'
                          and (coalesce(qual,'') like '%is_brokerage_finance_admin%'
                            or coalesce(with_check,'') like '%is_brokerage_finance_admin%')),
    'ops_tables',      (select count(distinct tablename) from pg_policies where schemaname='public'
                          and (coalesce(qual,'') like '%is_brokerage_admin(%'
                            or coalesce(with_check,'') like '%is_brokerage_admin(%')),
    'ops_policies',    (select count(*) from pg_policies where schemaname='public'
                          and (coalesce(qual,'') like '%is_brokerage_admin(%'
                            or coalesce(with_check,'') like '%is_brokerage_admin(%')),
    -- A table appearing under BOTH predicates would mean the partition is not one.
    'tables_in_both',  (select count(*) from (
                          select tablename from pg_policies where schemaname='public'
                            and (coalesce(qual,'') like '%is_brokerage_finance_admin%'
                              or coalesce(with_check,'') like '%is_brokerage_finance_admin%')
                          intersect
                          select tablename from pg_policies where schemaname='public'
                            and (coalesce(qual,'') like '%is_brokerage_admin(%'
                              or coalesce(with_check,'') like '%is_brokerage_admin(%')) x),
    -- Answered with NO identity established. Must be false, never null: a boolean
    -- function composed by 226 policies that can answer NULL is a trap.
    'wide_no_identity',   public.is_brokerage_admin(),
    'narrow_no_identity', public.is_brokerage_finance_admin()
  );
$fn$;

comment on function public.finance_authority_facts() is
  'Read-only introspection for scripts/finance-authority-simulator.ts (npm run test:finance-authority). Returns the role lists EXTRACTED from the live bodies of is_brokerage_admin() and is_brokerage_finance_admin(), how many branches of each carry that list, and the policy partition between them — so the proof can compare the database against lib/auth/resolve-user-role.ts instead of restating either. See m472.';

grant execute on function public.finance_authority_facts() to service_role;

commit;

-- ── MEASURED AFTER APPLYING, ON THE LIVE DATABASE ───────────────────────────
-- Re-runnable: scripts/finance-authority-simulator.ts (npm run test:finance-authority).
--
-- THE PARTITION, read back out of pg_policies:
--   FINANCE      49 tables / 138 policies   (all on is_brokerage_finance_admin())
--   OPERATIONAL  64 tables /  88 policies   (all on is_brokerage_admin())
--   tables under BOTH: 0.   49+64 = 113.   138+88 = 226.
--
-- ROLE LISTS, extracted from the live pg_proc bodies rather than restated:
--   is_brokerage_admin()          admin, broker, broker_owner, team_lead   (2 branches)
--   is_brokerage_finance_admin()  admin, broker, broker_owner              (2 branches)
-- Two branches each = the role list is carried by the user_type test AND by the
-- grant test. Both spellings of the seat are live on this database: one
-- users.user_type = 'team_lead' row and one user_role_assignments 'team_lead'
-- grant, and a list in only one branch would admit one and refuse the other.
--
-- ── BEHAVIOUR, PROVED BY IMPERSONATION ──────────────────────────────────────
-- Each actor run as the real account inside a plpgsql DO block: the JWT subject
-- set with set_config('request.jwt.claims', …, true) AND `set local role
-- authenticated`, because the migration role bypasses RLS and without the role
-- switch every policy would have been measured as "allowed" and believed.
--
-- The write is measured by ROW COUNT from GET DIAGNOSTICS, never through
-- RETURNING: on this very table m466 recorded that `INSERT … RETURNING` applies
-- the table's SELECT policy — a DIFFERENT gate (can_read_brokerage_books) — so a
-- successful insert raised 42501 on the read-back and read as a refusal.
--
--   OPERATIONAL probe: INSERT prohibited_phrases   (is_brokerage_admin())
--   FINANCE probe:     INSERT accounting_sync_log  (is_brokerage_finance_admin())
--
--   actor                          seat                        wide  narrow  OPS            FINANCE
--   buyer@yourbrokerage.com        user_type team_lead
--                                  + team_lead GRANT           TRUE  FALSE   ALLOWED 1 row  REFUSED 42501
--   agent1@yourbrokerage.com       user_type agent
--                                  + admin GRANT (2nd seat)    TRUE  TRUE    ALLOWED 1 row  ALLOWED 1 row
--   admin@yourbrokerage.com        user_type admin             TRUE  TRUE    ALLOWED 1 row  ALLOWED 1 row
--   broker@vip.demo                user_type broker            TRUE  TRUE    ALLOWED 1 row  ALLOWED 1 row
--   agent@vip.demo                 user_type agent, no grant   FALSE FALSE   REFUSED 42501  REFUSED 42501
--
-- Line 1 IS the ruling: the same seat administers and does not keep the books.
-- Lines 2-4 are the no-regression claim — every account that could write the
-- books an hour ago still can, INCLUDING the grant-only second seat, which is
-- what the narrow predicate's second branch exists for. Line 5 is the negative
-- control: without it, "REFUSED" on line 1 would not distinguish a working gate
-- from a broken table.
--
-- STRICT BOOLEAN — with NO identity established, both functions return FALSE, and
-- `IS NULL` is false for both. Asserted directly, because RLS hiding a NULL behind
-- fail-closed is exactly how the m465 defect survived its first apply.
--
-- RESIDUE: 0. Seeded 4 prohibited_phrases rows and 3 accounting_sync_log rows,
-- removed all 7, re-counted after: accounting_sync_log 0 rows,
-- prohibited_phrases probe rows 0. user_role_assignments unchanged at 7 rows and
-- users unchanged at 23 — nothing was granted or demoted to run this.
--
-- ── STILL OPEN, AND NAMED SO IT CAN BE DECIDED ON ITS OWN TERMS ─────────────
-- brokerages and teams each carry BRANDING and MONEY on the same row, and RLS
-- gates rows, not columns. Holding the money closed therefore also holds a team
-- lead out of brokerage branding (name, logo_url, about_text, recruiting_pitch)
-- and out of creating or deleting a team — while the ruling calls marketing and
-- roster OPERATIONAL. A team lead keeps their OWN team through the pre-existing
-- `team_lead_id = auth.uid()` disjunct, and team membership is unaffected because
-- it lives in team_members, so the practical cost is narrow. Closing the rest
-- needs a column-guard trigger or a branding table of its own — a different
-- migration with a different blast radius, and an owner's call, not a refactor.
--
-- A SECOND THING FOUND AND DELIBERATELY NOT CHANGED: teams_tenant_update's
-- `OR team_lead_id = auth.uid()` lets a lead set their OWN team's cap_amount and
-- team_split_percent with no admin test at all. That PREDATES this migration and
-- is not widened by it — this migration only ever narrows that policy's other
-- disjunct. Whether a lead may set their own team's economics is the same
-- question the owner just answered for the brokerage, one scope down, and it is
-- reported here rather than decided in passing.
