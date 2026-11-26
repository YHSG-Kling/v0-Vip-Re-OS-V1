-- m433 — "contacts, lenders and vendors do not see commission or any financials
--         but only their own."
--
-- THE DEFECT, MEASURED. Every table rewritten below carried a SELECT policy whose
-- entire predicate was `brokerage_id = current_user_brokerage_id()` — or the
-- NULL-escape variant `(brokerage_id IS NULL) OR (brokerage_id = ...)`. There is
-- no role test in either. `users.brokerage_id` is stamped on a `contact`, a
-- `lender` and a `vendor` account exactly as it is on a broker's, so those three
-- portal roles satisfied the predicate on EVERY row. A buyer signed into the
-- client portal could read the brokerage's gross commission income, its agents'
-- caps and splits, its P&L, its subscription invoices and its recruiting spend.
--
-- m427 fixed this on `agent_commissions` and `commission_splits` by replacing the
-- unconditional brokerage branch with named disjuncts. This file applies the same
-- ruling to the rest of the money, and it does NOT reuse m427's transitional
-- spelling `(NOT is_agent_role()) AND has_brokerage_access(...)`. "Not an agent"
-- is TRUE for a contact, a lender and a vendor — it is the very shape that let
-- them in, and it silently admits every role invented later. Every branch below
-- is a POSITIVE roster.
--
-- FIVE TIERS, FIVE NAMED HELPERS, ONE PLACE EACH. The next money table added to
-- this schema inherits a definition instead of copying a predicate:
--
--   can_read_tenant_financials()          — m427. Platform: superadmin/admin/
--                                           support, ALL tenants, READ ONLY.
--   can_read_brokerage_books()            — NEW. The tenant roles that may see
--                                           the whole book.
--   can_read_agent_books(agent_id)        — NEW. One agent's money: the books
--                                           roles, the agent themself, and that
--                                           agent's team lead.
--   can_read_team_books(team_id)          — NEW. One team's money.
--   is_tenant_staff()                     — NEW. The internal roster, i.e. every
--                                           role that is NOT a portal role. For
--                                           operational money an ordinary agent
--                                           genuinely needs tenant-wide.
--   is_current_user_vendor(vendor_id)     — NEW. A vendor's own invoice/payout.
--
-- HARD DEPENDENCY: `can_read_team_books()` calls `public.current_user_team_id()`,
-- the canonical team resolver created in m431 by the agent who owns the team
-- model. It is deliberately NOT defined here — two definitions of "which team am
-- I on" is the same disease as two definitions of "which office closed this deal"
-- that m427 spent a section removing. m433 MUST be applied after m431; if it is
-- not, this file aborts at CREATE FUNCTION time and leaves nothing half-applied.

-- ═════════════════════════════════════════════════════════════════════════════
-- A. THE TIER HELPERS
-- ═════════════════════════════════════════════════════════════════════════════

-- A1. THE BROKERAGE'S BOOK.
--
-- `is_brokerage_admin()` (admin, broker, broker_owner) is the roster the owner's
-- ruling names for "own tenant, whole book". It is NOT reused verbatim here, for
-- one measured reason: `compliance_officer`.
--
-- The owner did not name compliance_officer either way, so this is worked out
-- from the REAL SCREEN, as the brief requires. app/actions/cda-portal-list.ts
-- holds `COMPLIANCE_ROLES = {compliance_officer, admin, broker, broker_admin,
-- superadmin}` and, through the SESSION client, reads brokerage-wide across four
-- tables in this migration — `closing_disclosure_agreement` (gross_commission,
-- agent_net, brokerage_net), `agent_commission_profiles` (split_percent,
-- cap_amount), `agent_cap_tracking` and `agent_fee_charges` — to build the
-- compliance review queue. A compliance officer whose whole job is auditing the
-- disbursement authorisation cannot do it through a keyhole, and the existing
-- `compliance_officer_crud_cda` policy on that table already grants them the
-- table outright. Excluding them here would break a working screen, which the
-- brief calls a defect in the policy and not in the screen.
--
-- `tc` is deliberately NOT in this roster. The owner did not name it either, and
-- the repository's own rosters are consistent: a tc is transaction staff, not
-- book staff (app/actions/communications.ts BROKERAGE_STAFF_TYPES,
-- app/actions/compliance-bridge-actions.ts STAFF_ROLES, app/actions/overdue.ts).
-- The one place a tc is trusted with money is `transaction_commissions`, which is
-- scoped to A TRANSACTION and is not touched by this file. So a tc keeps every
-- per-deal number they have today and loses the brokerage-wide ledger they never
-- had a screen for. REPORTED FOR CORRECTION: if the owner intends a tc to see the
-- brokerage's book, add 'tc' to this one function and every table follows.
--
-- 'broker_admin' is included because the app's role constants emit it and
-- COMPLIANCE_ROLES names it; it is absent from live `users.user_type` today but
-- an invite can create it tomorrow.

create or replace function public.can_read_brokerage_books()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select user_type in ('admin', 'broker', 'broker_owner', 'broker_admin', 'compliance_officer')
     from public.users where id = auth.uid() limit 1),
    false
  );
$$;

comment on function public.can_read_brokerage_books() is
  'TRUE for the TENANT roles allowed to read their own brokerage''s whole financial book: admin, broker, broker_owner, broker_admin, compliance_officer. A POSITIVE roster — never spell this as NOT is_agent_role(), which is TRUE for contact/lender/vendor and is the defect m433 exists to remove. Carries NO tenant test: always compose it as has_brokerage_access(brokerage_id) AND can_read_brokerage_books(). compliance_officer is included because app/actions/cda-portal-list.ts reads brokerage-wide commission numbers through the session client to build the compliance review queue; tc is excluded because every tc-trusted money surface in this codebase is scoped to a transaction, not to the book.';

revoke all on function public.can_read_brokerage_books() from public;
grant execute on function public.can_read_brokerage_books() to authenticated, service_role;

-- A2. THE INTERNAL ROSTER.
--
-- Not every table in this wave is "the brokerage's book". Three of them are
-- OPERATIONAL money an ordinary agent must be able to read to do the job:
--
--   deposits          — escrow on the agent's own deal. Read by the transaction
--                       detail screen (app/dashboard/transactions/[id]/
--                       transaction-detail-client.tsx) through the browser
--                       session client, filtered by transaction_id.
--   tier_budgets      — the marketing-tier budget table lib/listings/
--                       tier-assigner.ts reads (session client) every time a
--                       listing is assigned a tier.
--   transaction_cost_breakdown — the per-deal cost sheet.
--
-- Locking those to the books roster would break the agent's day. Locking them to
-- "not an agent" would leave the portal hole open. So they get the third thing:
-- a POSITIVE list of every role that is INTERNAL to the tenant, which is exactly
-- the live `users.user_type` domain minus the three portal roles the owner named.
--
-- Live measured values: admin, agent, broker, compliance_officer, contact,
-- lender, system, tc, team_lead, vendor. The extras below (broker_owner,
-- broker_admin, team_leader, transaction_coordinator, isa, coordinator) are the
-- spellings the app's own invite and role constants can produce
-- (app/actions/admin/invite-user.ts, app/constants/auth.ts); listing them keeps
-- the roster positive without needing a migration the day one is first used.
-- 'title_agent' is NOT here — a title agent is external, and its access to a CDA
-- comes from its own dedicated policy.

create or replace function public.is_tenant_staff()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select user_type in (
       'admin', 'broker', 'broker_owner', 'broker_admin',
       'agent', 'team_lead', 'team_leader',
       'tc', 'transaction_coordinator', 'coordinator', 'isa',
       'compliance_officer', 'system'
     )
     from public.users where id = auth.uid() limit 1),
    false
  );
$$;

comment on function public.is_tenant_staff() is
  'TRUE for a user INTERNAL to the tenant — every user_type except the portal roles contact, lender and vendor (and except title_agent, which is external). A POSITIVE roster, so a role invented later is excluded until someone adds it here on purpose. Use for operational money an ordinary agent genuinely needs tenant-wide (escrow deposits on a deal, marketing tier budgets, per-deal cost sheets); use can_read_brokerage_books() instead for anything that is the brokerage''s BOOK. Carries no tenant test — compose with has_brokerage_access(brokerage_id).';

revoke all on function public.is_tenant_staff() from public;
grant execute on function public.is_tenant_staff() to authenticated, service_role;

-- A3. ONE AGENT'S MONEY.
--
-- The owner's ruling 4 — "agents should only see their own commission splits" —
-- and ruling 1 — "teams should only see their own board" — meet on the same row.
-- Four disjuncts, each traceable:
--
--   can_read_tenant_financials()   ruling: platform reads all tenants
--   can_read_brokerage_books()     ruling: a brokerage sees its own book
--   agent_id = current_user_agent_id()
--                                  ruling 4, spelled EXACTLY as m427 spells it on
--                                  agent_commissions and commission_splits, so
--                                  the ledgers cannot disagree about whose money
--                                  a row is
--   team lead of THAT agent        ruling 1
--
-- The team branch resolves through `agents.team_id`, which is where an agent's
-- team is recorded, and compares it to the caller's own team from m431's
-- resolver. `is_team_lead_role()` gates it so an ordinary agent cannot read a
-- team-mate's earnings by virtue of sharing a team.
--
-- NULL SAFETY: current_user_agent_id() is NULL for anyone without an agents row,
-- and `agent_id = NULL` is NULL, never true — so the own-row branch cannot open
-- accidentally. The explicit `target_agent_id is not null` guard makes that
-- visible rather than incidental, and also handles the tables where agent_id is
-- nullable (a brokerage-level snapshot row) — those fall through to the books
-- roster, which is correct: a row belonging to no agent belongs to the book.

create or replace function public.can_read_agent_books(target_agent_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    public.can_read_tenant_financials()
    or public.can_read_brokerage_books()
    or (target_agent_id is not null
        and target_agent_id = public.current_user_agent_id())
    or (target_agent_id is not null
        and public.is_team_lead_role()
        and public.current_user_team_id() is not null
        and exists (
          select 1 from public.agents a
          where a.id = target_agent_id
            and a.team_id = public.current_user_team_id()
        ));
$$;

comment on function public.can_read_agent_books(uuid) is
  'May the caller read money that belongs to agents.id = target_agent_id? Platform financial readers, the tenant''s book roles, the agent themself, and that agent''s team lead — and nobody else, which is how contact/lender/vendor are refused. A NULL target (a brokerage-level snapshot row on a table that also carries per-agent rows) resolves to the book roles only. Carries NO tenant test: compose as has_brokerage_access(brokerage_id) AND can_read_agent_books(agent_id). Team branch depends on public.current_user_team_id() from m431.';

revoke all on function public.can_read_agent_books(uuid) from public;
grant execute on function public.can_read_agent_books(uuid) to authenticated, service_role;

-- A4. ONE TEAM'S MONEY. Ruling 1, on the tables that are keyed by team.

create or replace function public.can_read_team_books(target_team_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    public.can_read_tenant_financials()
    or public.can_read_brokerage_books()
    or (target_team_id is not null
        and public.is_team_lead_role()
        and public.current_user_team_id() is not null
        and target_team_id = public.current_user_team_id());
$$;

comment on function public.can_read_team_books(uuid) is
  'May the caller read money that belongs to teams.id = target_team_id? Owner ruling "teams should only see their own board": a team_lead gets their OWN team and no other, the brokerage''s book roles get every team, platform financial readers get every tenant. Carries NO tenant test — compose with has_brokerage_access(brokerage_id). Depends on public.current_user_team_id() from m431, deliberately not defined here.';

revoke all on function public.can_read_team_books(uuid) from public;
grant execute on function public.can_read_team_books(uuid) to authenticated, service_role;

-- A5. A VENDOR'S OWN MONEY.
--
-- This is the "but only their own" half of the ruling, and it is the half that
-- would be silently lost if `vendor_earnings` / `vendor_invoices` /
-- `vendor_payouts` / `vendor_transactions` were simply locked to the books roles.
-- A vendor SHOULD see their own payout. They must not see the brokerage's book
-- or another vendor's invoice.
--
-- THE LINKAGE ALREADY EXISTS and is named as canonical in two places, so nothing
-- is invented here:
--   · app/vendor/invoices/page.tsx — "Canonical vendor linkage:
--     user_role_assignments.vendor_id", verbatim, and it resolves the signed-in
--     vendor exactly this way.
--   · the live policy `vendor reads own tax doc` on vendor_tax_documents already
--     joins user_role_assignments the same way, as does the shipped
--     public.vendor_has_transaction_access() helper.
--
-- There are 7 user_role_assignments rows and 0 of them carry a vendor_id today,
-- so this branch grants nothing at this instant. That is the correct outcome for
-- an unlinked vendor account: it FAILS CLOSED — the vendor sees nothing rather
-- than everything, which is what it saw before this migration.

create or replace function public.is_current_user_vendor(target_vendor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select target_vendor_id is not null
     and exists (
       select 1 from public.user_role_assignments ura
       where ura.user_id = auth.uid()
         and ura.vendor_id = target_vendor_id
     );
$$;

comment on function public.is_current_user_vendor(uuid) is
  'Is the caller the vendor identified by vendors.id = target_vendor_id? Resolved through user_role_assignments.vendor_id — the linkage app/vendor/invoices/page.tsx calls "Canonical vendor linkage" and the one public.vendor_has_transaction_access() and the vendor_tax_documents policies already use. Deliberately unscoped by tenant: a vendor''s own invoice is theirs whichever brokerage raised it. An unlinked vendor account resolves FALSE and therefore sees nothing, which is the right failure direction.';

revoke all on function public.is_current_user_vendor(uuid) from public;
grant execute on function public.is_current_user_vendor(uuid) to authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- B. THE POLICIES
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Driven from an explicit (table, policy, cmd, tier) roster rather than written
-- out 140 times, so every table in a tier is provably identical and no table
-- silently drifts. `alter policy` is used throughout: policy NAMES and their
-- granted roles are left exactly as they are, because half of this schema's
-- guards key on those names.
--
-- WHY THE WRITES MOVE TOO (brief §4(e)/(f)). Postgres evaluates the SELECT policy
-- to LOCATE rows for an UPDATE or DELETE whose WHERE reads a column — which every
-- supabase-js write does. Narrowing SELECT alone would therefore leave writes
-- that appear locked but are decided by a policy nobody reviewed, and leaving the
-- write clauses at `brokerage_id = current_user_brokerage_id()` would leave a
-- contact able to INSERT a commission row they cannot read. So each tier gets a
-- write roster too, and every WITH CHECK is scoped, so a row cannot be MOVED to
-- another tenant by an UPDATE.
--
-- can_read_tenant_financials() appears in NO write clause. The owner's ruling
-- says "can read". A platform support operator gets the ledger, not a pen. That
-- is m427's rule and it is preserved here.
--
-- THE NULL ESCAPE (brief §4(c)) DIES HERE. Twelve of these tables carried
-- `(brokerage_id IS NULL) OR (...)`, which PUBLISHES an unstamped row to every
-- tenant on the platform. has_brokerage_access(x) returns FALSE for a NULL x, so
-- adopting it removes the escape as a side effect of adopting the tier.
-- VERIFIED BEFORE REMOVAL, per table: every one of budgets, business_expenses,
-- commission_calculations, deposits, financial_reports, vendor_earnings,
-- vendor_invoices, vendor_payouts, referral_partners, net_sheet_calculations,
-- closing_disclosure_agreement and credit-free `tax_categories` (excluded, see
-- below) holds ZERO rows on this database, so no row is orphaned. And every
-- writer already stamps the tenant — app/actions/ai-financial-management.ts
-- (budgets, financial_reports, deposits), app/actions/agents.ts and
-- lib/kernel/financial.ts (business_expenses) all set brokerage_id explicitly,
-- with comments from waves 33-35 saying why.
--
-- DELIBERATELY NOT TOUCHED, and why:
--   agent_commissions, commission_splits  — m427/another agent in this wave.
--   teams, team_members, team_performance, team_heatmap_snapshots — the team
--       model, owned by the agent writing m431/m432.
--   users, brokerages                     — a third agent.
--   tax_categories, ai_subscription_tier  — their `brokerage_id IS NULL` rows are
--       PLATFORM DEFAULTS (a shared category list, a default tier), i.e. the
--       platform-catalogue pattern m406/m421 established, not the m433 defect.
--       Removing the NULL branch there would delete the catalogue, not close a
--       hole. They carry no ledger amount. Reported, not changed.
--   credit_accounts                       — consumer credit-repair data on a
--       CONTACT, not brokerage financials. Genuinely leaky (see the report) but
--       the right answer depends on whether a lender account should see a
--       buyer's credit, which the owner has not ruled on. Reported, not changed.
--   listing_agreements, offers            — commission RATES on a live deal
--       document that ordinary agents work from all day. Not the book.

do $$
declare
  -- tier → (select_expr, write_expr). Written once.
  sel_agent  constant text :=
    'public.can_read_tenant_financials() or (public.has_brokerage_access(brokerage_id) and public.can_read_agent_books(agent_id))';
  wri_agent  constant text :=
    'public.is_platform_admin() or (public.has_brokerage_access(brokerage_id) and (public.is_brokerage_admin() or (agent_id is not null and agent_id = public.current_user_agent_id())))';

  sel_team   constant text :=
    'public.can_read_tenant_financials() or (public.has_brokerage_access(brokerage_id) and public.can_read_team_books(team_id))';
  wri_books  constant text :=
    'public.is_platform_admin() or (public.has_brokerage_access(brokerage_id) and public.is_brokerage_admin())';

  sel_books  constant text :=
    'public.can_read_tenant_financials() or (public.has_brokerage_access(brokerage_id) and public.can_read_brokerage_books())';

  sel_staff  constant text :=
    'public.can_read_tenant_financials() or (public.has_brokerage_access(brokerage_id) and public.is_tenant_staff())';
  wri_staff  constant text :=
    'public.is_platform_admin() or (public.has_brokerage_access(brokerage_id) and public.is_tenant_staff())';

  sel_vendor constant text :=
    'public.can_read_tenant_financials() or (public.has_brokerage_access(brokerage_id) and public.can_read_brokerage_books()) or public.is_current_user_vendor(vendor_id)';

  -- A commission DISTRIBUTION line either names an agent (their split — ruling 4)
  -- or names none, in which case it is the brokerage's own share, a referral fee
  -- or a team override on the deal. The agent's own CDA screen
  -- (app/actions/cda-template-field-actions.ts, session client) sums BOTH kinds
  -- for one transaction, so an agent-own-only predicate would render a CDA whose
  -- lines do not add up to its own total. The unnamed lines therefore go to the
  -- internal roster — never to a contact, lender or vendor, which is the ruling.
  sel_distrib constant text :=
    'public.can_read_tenant_financials() or (public.has_brokerage_access(brokerage_id) and (public.can_read_agent_books(agent_id) or (agent_id is null and public.is_tenant_staff())))';

  tgt        record;   -- one (table, tier)
  pol        record;   -- one policy on that table
  sel_expr   text;
  wri_expr   text;
  n_sel      int := 0;
  n_wri      int := 0;
begin
  for tgt in
    select * from (values
      -- ── TIER: ONE AGENT'S MONEY ────────────────────────────────────────────
      ('agent_earnings',              'agent'),
      ('agent_cap_tracking',          'agent'),
      ('agent_commission_profiles',   'agent'),
      ('agent_monthly_earnings',      'agent'),
      ('agent_fee_charges',           'agent'),
      ('agent_fee_assignments',       'agent'),
      ('agent_credit_budgets',        'agent'),
      ('earnings_history',            'agent'),
      ('commission_calculations',     'agent'),
      ('financial_reports',           'agent'),
      ('budgets',                     'agent'),
      ('business_expenses',           'agent'),
      ('revenue_protection_snapshots','agent'),
      ('income_forecast_snapshots',   'agent'),
      ('income_forecast_gap_analysis','agent'),
      ('referrals',                   'agent'),
      ('referral_partners',           'agent'),
      ('net_sheet_calculations',      'agent'),
      ('closing_disclosure_agreement','agent'),
      ('transaction_agent_roles',     'agent'),
      -- ── TIER: ONE TEAM'S MONEY ─────────────────────────────────────────────
      ('team_earnings',               'team'),
      ('team_commission_profiles',    'team'),
      -- ── TIER: THE BROKERAGE'S BOOK ─────────────────────────────────────────
      ('brokerage_earnings',          'books'),
      ('brokerage_p_l',               'books'),
      ('brokerage_fee_types',         'books'),
      ('billing_invoices',            'books'),
      ('billing_usage',               'books'),
      ('subscriptions',               'books'),
      ('commission_structures',       'books'),
      ('commission_adjustments',      'books'),
      ('commission_rules',            'books'),
      ('recruiting_analytics',        'books'),
      ('recruiting_costs',            'books'),
      ('recruiting_roi',              'books'),
      ('accounting_sync_log',         'books'),
      ('tier_distributions',          'books'),
      ('marketing_attribution_credits','books'),
      -- ── TIER: INTERNAL STAFF, TENANT-WIDE ──────────────────────────────────
      ('deposits',                    'staff'),
      ('tier_budgets',                'staff'),
      ('transaction_cost_breakdown',  'staff'),
      ('commission_distributions',    'distrib'),
      -- ── TIER: A VENDOR'S OWN MONEY ─────────────────────────────────────────
      ('vendor_earnings',             'vendor'),
      ('vendor_invoices',             'vendor'),
      ('vendor_payouts',              'vendor'),
      ('vendor_transactions',         'vendor')
    ) as t(tbl, tier)
  loop
    sel_expr := case tgt.tier
      when 'agent'   then sel_agent
      when 'team'    then sel_team
      when 'books'   then sel_books
      when 'staff'   then sel_staff
      when 'distrib' then sel_distrib
      when 'vendor'  then sel_vendor
    end;
    wri_expr := case tgt.tier
      when 'agent'   then wri_agent
      when 'staff'   then wri_staff
      when 'distrib' then wri_staff
      else                wri_books
    end;

    -- Only the policies that ALREADY reach the tenant without a role test — or
    -- that are literally `true` — are rewritten. A table's OTHER policies (the
    -- role-gated ALL policies on commission_structures and
    -- closing_disclosure_agreement, the title-agent CDA read, the
    -- platform-admin-only deletes, the already-agent-scoped
    -- agent_credit_budgets writes) are left exactly as they are: they are
    -- additive, they already name a role, and they are not this defect. Any
    -- policy already carrying one of the new tier helpers is skipped too, so
    -- re-running this file is a no-op rather than a double rewrite.
    for pol in
      select p.policyname, p.cmd, p.tablename
      from pg_policies p
      where p.schemaname = 'public'
        and p.tablename  = tgt.tbl
        and 'service_role' <> all (p.roles)
        and (
              coalesce(p.qual, '') || coalesce(p.with_check, '')
                ~ '(current_user_brokerage_id\(\)|has_brokerage_access\(|user_brokerage_ids\()'
           or btrim(coalesce(p.qual, '') || coalesce(p.with_check, '')) = 'true'
        )
        and coalesce(p.qual, '') || coalesce(p.with_check, '')
              !~ '(can_read_tenant_financials|can_read_brokerage_books|can_read_agent_books|can_read_team_books|is_tenant_staff|is_current_user_vendor)'
    loop
      if pol.cmd = 'SELECT' then
        execute format('alter policy %I on public.%I using (%s)', pol.policyname, pol.tablename, sel_expr);
        n_sel := n_sel + 1;
      elsif pol.cmd = 'INSERT' then
        execute format('alter policy %I on public.%I with check (%s)', pol.policyname, pol.tablename, wri_expr);
        n_wri := n_wri + 1;
      elsif pol.cmd = 'UPDATE' then
        execute format('alter policy %I on public.%I using (%s) with check (%s)', pol.policyname, pol.tablename, wri_expr, wri_expr);
        n_wri := n_wri + 1;
      elsif pol.cmd = 'DELETE' then
        execute format('alter policy %I on public.%I using (%s)', pol.policyname, pol.tablename, wri_expr);
        n_wri := n_wri + 1;
      elsif pol.cmd = 'ALL' then
        -- business_expenses, tier_budgets, tier_distributions and
        -- transaction_cost_breakdown carry a single FOR ALL policy. USING decides
        -- the read AND which rows may be acted on; WITH CHECK decides what a row
        -- may BECOME. They must NOT be the same expression here: the read is the
        -- tier, the write is the tier's write roster, and the strictest of the
        -- two has to hold for a write. Postgres ANDs USING with WITH CHECK on an
        -- UPDATE, so USING=read-tier + WITH CHECK=write-roster yields exactly
        -- "may see it AND may make it into that", which is what is wanted.
        execute format('alter policy %I on public.%I using (%s) with check (%s)', pol.policyname, pol.tablename, sel_expr, wri_expr);
        n_sel := n_sel + 1;
        n_wri := n_wri + 1;
      end if;
    end loop;
  end loop;

  raise notice 'm433: rewrote % read clause(s) and % write clause(s) across 45 financial tables.', n_sel, n_wri;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- C. affiliate_commission_events — THE ONE WITH NO POLICY AT ALL
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The census flagged it as having no SELECT policy. Measured on the live
-- database: `pg_class.relrowsecurity = true` and ZERO policies. RLS is ON, so it
-- is FAIL-CLOSED — no `anon` or `authenticated` session can read a row, and the
-- three readers (app/api/cron/affiliate-commissions/route.ts,
-- app/dashboard/superadmin/affiliates/actions.ts, lib/platform/affiliates.ts) all
-- go through createServiceClient(), which is not subject to RLS. Nothing is
-- leaking and nothing needs opening.
--
-- What IS worth pinning is that it stays that way. The table's grants are wide —
-- `anon` holds SELECT/INSERT/UPDATE/DELETE on it, as it does across this schema —
-- so the ONLY thing standing between the anon key and every affiliate's
-- commission_cents is the RLS flag. `alter table ... force row level security`
-- makes the protection survive even a table owner connection, and m434 asserts
-- the flag rather than asserting a policy that deliberately does not exist.

alter table public.affiliate_commission_events enable row level security;
alter table public.affiliate_commission_events force row level security;

comment on table public.affiliate_commission_events is
  'Platform affiliate commission ledger. INTENTIONALLY has zero RLS policies: RLS is enabled (and forced), so every session-key read is refused and the only readers are service-role. Do not "fix" this by adding a permissive policy — anon holds table-level SELECT here, so the RLS flag is the entire defence. m434 asserts the flag.';

-- ═════════════════════════════════════════════════════════════════════════════
-- D. THE ONE WRITE CLAUSE THAT WAS LITERALLY `true`
-- ═════════════════════════════════════════════════════════════════════════════
--
-- `agent_monthly_earnings` carried `ame_insert WITH CHECK (true)` and
-- `ame_update WITH CHECK (true)` — any authenticated user, including a contact,
-- could INSERT an earnings row for any agent of any brokerage, or UPDATE one
-- into another tenant. The loop above rewrote them along with the rest of the
-- tier; this comment exists so the reason is on the record and nobody restores
-- the `true` thinking it was load-bearing. The writer is
-- app/api/cron/earnings-rollup/route.ts, which uses the service client.

do $$
declare bad int;
begin
  select count(*) into bad
  from pg_policies
  where schemaname = 'public'
    and tablename in ('agent_monthly_earnings', 'agent_credit_budgets')
    and cmd in ('INSERT', 'UPDATE')
    and coalesce(with_check, '') ~ '^\s*true\s*$';
  if bad > 0 then
    raise exception 'm433: % write clause(s) on agent_monthly_earnings/agent_credit_budgets are still WITH CHECK (true).', bad;
  end if;
end $$;
