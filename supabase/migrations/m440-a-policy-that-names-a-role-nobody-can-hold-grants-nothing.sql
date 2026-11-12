-- m440 — A POLICY THAT NAMES A ROLE NOBODY CAN HOLD GRANTS NOTHING.
--        And a tenant test with no role test grants everything inside the tenant.
--
-- Two defects, both measured live before a line of this was written, both of the
-- same family: a predicate that READS like protection and does not decide
-- anything.
--
--   (1) SEVEN policies gate on a `user_type` literal that
--       `users_user_type_check` cannot store. Measured: the constraint admits
--       exactly admin, agent, broker, broker_owner, compliance_officer, contact,
--       isa, lender, superadmin, support, system, tc, team_lead, vendor. These
--       seven name something else, so their predicate is FALSE for every user who
--       will ever exist:
--
--         closing_disclosure.title_agent_select_closing_disclosure   'title_agent'
--         closing_disclosure.title_agent_create_closing_disclosure   'title_agent'
--         cda_comparison_results.title_agent_select_cda_comparison   'title_agent'
--         listings.compliance_read_brokerage_listings                'compliance_manager'
--         listings.tc_read_brokerage_listings                        'transaction_coordinator'
--         listings.team_leader_read_team_listings                    'team_leader'
--         transactions.team_leader_read_team_transactions            'team_leader'
--
--       m439 claim 4 raised these as a NOTICE census and said turning it into a
--       hard failure was "the follow-up wave's job, after each of those four
--       surfaces has been traced the way this one was". This is that wave. Each
--       one is decided SEPARATELY below — a role that cannot exist is not
--       automatically deletable, because it may be the INTENT for a real role
--       that was renamed, and three of these are exactly that.
--
--   (2) `vendor_subscriptions` reaches its tenant with NO role test at all. After
--       m438 dropped its two tenant-free `user_type` policies, all four remaining
--       policies are the bare `brokerage_id = current_user_brokerage_id()` — on
--       SELECT, INSERT, UPDATE and DELETE. `users.brokerage_id` is stamped on a
--       contact, a lender and a vendor account exactly as it is on a broker's, so
--       a client-portal account can read AND WRITE its brokerage's subscription
--       book: which marketplace vendors it pays, the Stripe customer and
--       subscription ids, the billing period and the metered credit burn.
--
--       It escaped m434 and m439 because BOTH guards discover their tables from a
--       family of settled-money COLUMN NAMES, and this table has no amount column
--       at all — its only numeric column is `credits_used_this_period`. Section E
--       fixes the table; m441 widens the family so the next metered product is
--       policed the day it exists.
--
-- WHERE THE DEAD VOCABULARY CAME FROM, since that decides repair-vs-delete.
-- `supabase/rls-governance/000-helper-functions.sql` declares an `auth.*` helper
-- family — auth.is_team_leader() = 'team_leader', auth.is_tc() =
-- 'transaction_coordinator', auth.is_compliance_manager() = 'compliance_manager',
-- auth.is_title_agent() = 'title_agent'. Measured on this database: NONE of those
-- functions exists. Its own header says they need a Supabase-dashboard superuser
-- connection, and they were never installed. What WAS installed is
-- `scripts/111-fix-agent-id-rls-policies.sql`, which inlines those helper BODIES
-- into the policies verbatim — carrying the spellings, in a file that does run.
-- So this is not a typo seven times; it is one unbuilt vocabulary, copied.
--
-- The repository's own canonical mapping table names the survivors, and it is the
-- authority used here (lib/security/types.ts, LEGACY_ROLE_MAP):
--
--     transaction_coordinator → tc
--     compliance_manager      → compliance_officer
--     team_leader             → team_lead
--     title                   → title_agent
--
-- Three of the four legacy spellings map onto a REAL, LIVE user_type (one account
-- each on this database). `title_agent` maps onto nothing storable: m307 removed
-- it from the CHECK and a title company is a `vendors.category = 'title'` — the
-- live `title@vip.demo` account is `user_type = 'vendor'`, which is the route that
-- actually works. So three are REPAIRED and one is DELETED, and section C and
-- section D say so one policy at a time.

-- ═════════════════════════════════════════════════════════════════════════════
-- A. THE ONE ROLE HELPER THIS SCHEMA IS MISSING
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Two of the three repairs need no new function, because the helper that folds
-- the legacy spelling into the live one ALREADY EXISTS and is already the house
-- answer to that question:
--
--   is_team_lead_role()          user_type in ('team_lead', 'team_leader')
--   is_compliance_officer_role() user_type in ('compliance_officer', 'compliance_manager')
--
-- That is the whole point of a named helper: the dead spelling lives in ONE
-- positive roster where it widens the roster to nobody, instead of in a policy
-- where it IS the roster and narrows it to nobody. m441 therefore checks policy
-- predicates and not function bodies — a dead literal beside a live one in a
-- helper is inert; a dead literal alone in a policy is the defect.
--
-- The transaction coordinator has no such helper. `is_tenant_staff()` (m433)
-- includes a tc but also includes every other internal role, so it cannot express
-- "this policy is the TC's". Written here rather than inlined, for the reason
-- brief §3 gives: a named helper is inherited by the next table, an inlined
-- `user_type IN (...)` is copied — and copying is how the spelling drifted in the
-- first place.
--
-- 'coordinator' is included alongside 'tc' and 'transaction_coordinator' because
-- is_tenant_staff() already names it and lib/kernel/users.ts provisions a
-- transaction_coordinators row for that spelling too. All three are a POSITIVE
-- roster; only one of them is storable today, and that is the correct direction —
-- the roster widens to nobody rather than narrowing to nobody.
--
-- STABLE so the planner may cache it per statement instead of reading `users`
-- once per listing; SECURITY DEFINER so it reads `users` without tripping users'
-- own RLS; pinned search_path so a caller cannot shadow public.users. Same three
-- properties m434 claim 1 requires of every tier helper, for the same reasons.

create or replace function public.is_tc_role()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select user_type in ('tc', 'transaction_coordinator', 'coordinator')
     from public.users where id = auth.uid() limit 1),
    false
  );
$$;

comment on function public.is_tc_role() is
  'TRUE for a transaction coordinator. A POSITIVE roster naming the live user_type (''tc'') and the legacy spellings lib/security/types.ts LEGACY_ROLE_MAP folds onto it (''transaction_coordinator'', and ''coordinator'' which is_tenant_staff() already names). The counterpart of is_agent_role()/is_team_lead_role()/is_compliance_officer_role(): use it, never an inlined user_type comparison, so the next table inherits the definition instead of copying a spelling — copying a spelling is exactly how listings.tc_read_brokerage_listings came to gate on ''transaction_coordinator'', a value users_user_type_check cannot store. Carries NO tenant test: compose as has_brokerage_access(brokerage_id) AND is_tc_role().';

revoke all on function public.is_tc_role() from public;
grant execute on function public.is_tc_role() to authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- B. A MARKETPLACE VENDOR IS NOT THE SAME ID AS A DIRECTORY VENDOR
-- ═════════════════════════════════════════════════════════════════════════════
--
-- The assignment for section E said to reuse `is_current_user_vendor(vendor_id)`
-- for a vendor's own row, and not to redefine it. Auditing before writing found
-- that it CANNOT be reused here, and the reason is worth stating precisely
-- because it is a live defect on a table m433 already rewrote.
--
-- There are TWO vendor identities on this schema and they are different tables:
--
--   vendors                       — the brokerage's vendor directory. This is
--                                   what vendor_earnings.vendor_id,
--                                   vendor_invoices.vendor_id and
--                                   vendor_payouts.vendor_id reference (verified
--                                   in pg_constraint), and it is what
--                                   user_role_assignments.vendor_id holds —
--                                   app/vendor/invoices/page.tsx resolves that
--                                   column and then queries vendor_invoices with
--                                   it.
--
--   vendor_marketplace_profiles   — the PLATFORM marketplace seller: an app
--                                   vendor with a Stripe account, an API key and
--                                   subscription plans. vendor_subscriptions
--                                   .vendor_id and vendor_transactions.vendor_id
--                                   both reference THIS table, not `vendors`.
--
-- `is_current_user_vendor()` resolves through user_role_assignments.vendor_id,
-- i.e. it answers "is the caller this DIRECTORY vendor". m433 applied it to
-- `vendor_transactions`, whose vendor_id is a MARKETPLACE PROFILE id. Those two
-- id spaces never overlap, so that disjunct is false for every row that will ever
-- exist — the same dead-capability shape section C and D are removing, arrived at
-- through an id class rather than a spelling. It is invisible today only because
-- 0 of 7 user_role_assignments rows carry a vendor_id, so the branch grants
-- nothing either way; the moment a vendor is linked it would still grant nothing,
-- while reading as though a vendor can see their own marketplace revenue.
--
-- So this is NOT a second answer to "is this my vendor row". It is the answer to
-- a DIFFERENT question about a different table, and it resolves through the
-- linkage that table already declares: vendor_marketplace_profiles.user_id, which
-- is exactly what the table's own live policy "Vendors can view their own
-- profile" uses. Nothing is invented.
--
-- Deliberately unscoped by tenant, for m433's reason: a marketplace seller's own
-- subscription row is theirs whichever brokerage bought it. An unlinked profile
-- resolves FALSE and therefore sees nothing, which is the right failure direction.

create or replace function public.is_current_user_marketplace_vendor(target_profile_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select target_profile_id is not null
     and exists (
       select 1 from public.vendor_marketplace_profiles vmp
       where vmp.id = target_profile_id
         and vmp.user_id = auth.uid()
     );
$$;

comment on function public.is_current_user_marketplace_vendor(uuid) is
  'Is the caller the MARKETPLACE SELLER identified by vendor_marketplace_profiles.id = target_profile_id? This is NOT a duplicate of is_current_user_vendor(): that one answers "is the caller this DIRECTORY vendor" through user_role_assignments.vendor_id → vendors.id, and the two id spaces are disjoint. vendor_subscriptions.vendor_id and vendor_transactions.vendor_id both FK vendor_marketplace_profiles(id) (pg_constraint, verified), so is_current_user_vendor() on those columns compares a vendors.id to a profile id and is false for every row that will ever exist. Resolves through vendor_marketplace_profiles.user_id, the linkage that table''s own "Vendors can view their own profile" policy already uses. Deliberately unscoped by tenant — a seller''s own subscription is theirs whichever brokerage bought it. Never substitute one vendor id class for the other; m441 asserts the pairing from the foreign key.';

revoke all on function public.is_current_user_marketplace_vendor(uuid) from public;
grant execute on function public.is_current_user_marketplace_vendor(uuid) to authenticated, service_role;

-- ═════════════════════════════════════════════════════════════════════════════
-- C. `title_agent` — PERMANENTLY DEAD. DROPPED, WITH THE REASON ON THE RECORD.
-- ═════════════════════════════════════════════════════════════════════════════
--
-- Not "absent from today's census" — UNREACHABLE, and it will stay unreachable,
-- which is what makes deletion the right answer rather than repair:
--
--   · m307 removed 'title_agent' from users.user_type and the live CHECK. No row
--     can hold it. The predicate is false for every user who will ever exist.
--   · A title company is a VENDOR in this schema. `vendors.category` includes
--     'title'; scripts/seat-display-simulator.ts asserts exactly that; and the
--     live `title@vip.demo` account carries `user_type = 'vendor'`. The route
--     that works already exists, so nothing is lost by removing the route that
--     does not.
--   · m438 made this same call for `closing_disclosure_agreement
--     .title_agent_select_cda`. These three are its siblings on the two tables
--     m438 did not reach, and are dropped for the identical stated reason rather
--     than being carefully preserved as a capability the schema advertises and
--     does not grant.
--
-- WHAT THE TITLE COMPANY ACTUALLY USES, checked before deleting: the title portal
-- is app/portal/title/[transactionId], and it moves documents through
-- app/actions/title-portal.ts (transaction_documents, doc_type
-- 'final_closing_disclosure' / 'settlement_statement' / 'wire_instructions' /
-- 'title_commitment'). Neither `closing_disclosure` nor `cda_comparison_results`
-- has ANY reader in app/ or lib/ — every grep hit on those names is a doc_type
-- string, not a table read — and both hold zero rows. No surface changes.
--
-- The loop refuses to drop a policy whose predicate has since acquired a live
-- role: if someone repaired one of these differently between the audit and the
-- apply, this migration stops rather than deleting their work. That is m438's
-- guard, transplanted, with the test changed from "has it acquired a tenant" to
-- "has it acquired a storable role", because that is the defect being removed.

do $$
declare
  targets text[][] := array[
    ['closing_disclosure',      'title_agent_select_closing_disclosure'],
    ['closing_disclosure',      'title_agent_create_closing_disclosure'],
    ['cda_comparison_results',  'title_agent_select_cda_comparison']
  ];
  admitted text[];
  i    int;
  pred text;
  lit  text;
  n    int := 0;
  live int;
begin
  -- The storable vocabulary, read FROM the constraint. Never a hardcoded list:
  -- the whole point is that this follows the vocabulary rather than a copy of it.
  select array_agg(btrim(replace(x, '::text', ''), ''''))
    into admitted
  from   pg_constraint,
         lateral unnest(regexp_split_to_array(
                   (regexp_match(pg_get_constraintdef(oid), 'ARRAY\[(.*)\]'))[1], ',\s*')) as x
  where  conrelid = 'public.users'::regclass and conname = 'users_user_type_check';

  if admitted is null then
    raise exception 'm440: could not read users_user_type_check. The storable user_type vocabulary is what decides whether these policies are dead.';
  end if;

  for i in 1 .. array_length(targets, 1) loop
    select regexp_replace(
             coalesce(pg_get_expr(p.polqual, p.polrelid), '') || ' ' ||
             coalesce(pg_get_expr(p.polwithcheck, p.polrelid), ''), '\s+', ' ', 'g')
      into pred
      from pg_policy p
      join pg_class     c  on c.oid = p.polrelid
      join pg_namespace ns on ns.oid = c.relnamespace
     where ns.nspname = 'public' and c.relname = targets[i][1] and p.polname = targets[i][2];

    if pred is null then
      raise notice 'm440: %.% is already gone — nothing to drop.', targets[i][1], targets[i][2];
      continue;
    end if;

    live := 0;
    for lit in
      select (regexp_matches(pred, 'user_type[^;]{0,80}?''([a-z_]+)''::text', 'g'))[1]
    loop
      if lit = any (admitted) then live := live + 1; end if;
    end loop;

    if live > 0 then
      raise exception
        'm440: %.% now names a user_type that users_user_type_check CAN store (%). It named only ''title_agent'' when this migration was written, so somebody has repaired it another way — refusing to delete their work. Re-audit before dropping.',
        targets[i][1], targets[i][2], pred;
    end if;

    execute format('drop policy %I on public.%I', targets[i][2], targets[i][1]);
    n := n + 1;
  end loop;

  raise notice 'm440: dropped % unreachable title_agent policy/policies. A title company reaches this platform as a vendor (vendors.category = ''title''), not as a user_type m307 removed.', n;
end $$;

-- ═════════════════════════════════════════════════════════════════════════════
-- D. THE THREE RENAMED ROLES — REPAIRED, AND GIVEN THE RULE THEY LACKED
-- ═════════════════════════════════════════════════════════════════════════════
--
-- These are not typos to be deleted. Each names a role that EXISTS, is live on
-- this database, and has a declared intent in the repository:
--
--   compliance_manager → compliance_officer.  supabase/rls-governance/
--       005-listings-policies.sql states the intent in words on the line above
--       the policy: "Compliance Manager: Read all listings in their brokerage
--       (audit)". LEGACY_ROLE_MAP folds the spelling. One live account
--       (compliance@vip.demo). REPAIRED.
--
--   transaction_coordinator → tc.  Same file: "TC: Read listings tied to their
--       brokerage's transactions". lib/security/permission-matrix.ts grants the
--       tc role `listings:view_all` at `canViewData: 'brokerage'` — the
--       repository's own declaration that a coordinator sees the brokerage's
--       inventory. One live account (tc@vip.demo). REPAIRED.
--
--   team_leader → team_lead.  Two policies, and this is the one that bears on an
--       owner ruling. REPAIRED, AND NARROWED — see below.
--
-- ── WHY THE TENANT ANCHOR CHANGES TOO ────────────────────────────────────────
--
-- The compliance and tc policies already carried a tenant term, written as the
-- raw subselect `brokerage_id = (select brokerage_id from users where id =
-- auth.uid())`. That is not wrong — a NULL brokerage_id makes it NULL, never TRUE,
-- so it does not carry the `IS NULL` escape m434 claim 4 hunts. It is replaced by
-- `has_brokerage_access(brokerage_id)` anyway, for one reason: it is the house
-- anchor every policy written since m427 uses, it is FALSE for a NULL target by
-- construction, and it ORs in is_platform_admin() so the platform tier does not
-- need a fourth copy of itself on this table. One anchor, inherited.
--
-- ── THE TEAM RULING, AND THE DISJUNCT THAT CONTRADICTED IT ───────────────────
--
--   "teams should only see their own board."
--
-- `team_leader_read_team_listings` was, in full:
--
--     user_type = 'team_leader'
--     AND (   brokerage_id = <the caller's brokerage>
--          OR agent_id IN (agents joined to users with the caller's users.team_id))
--
-- The second disjunct is the team board. The FIRST disjunct is the WHOLE
-- BROKERAGE — so had the spelling ever been storable, a team lead would have read
-- every listing in the brokerage and the team clause would have been decoration.
-- Repairing the spelling and keeping that shape would have taken a policy that
-- grants nothing and turned it into a policy that grants everything, one table
-- away from the ruling it contradicts. It is dropped, and the team equality is
-- what the policy now IS.
--
-- Both policies also resolved the team through `users.team_id` — one of the FOUR
-- places a team membership can be recorded on this schema, and the one that is
-- NULL for all 23 live users. m431 settled that question: `resolve_team_id()` is
-- THE ONE RULE (you lead it > your own user record > an active team_members row >
-- the producing agent row), with `current_user_team_id()` for the reader's side
-- and `agent_team_id(agents.id)` for the row's side, so the reader's team and the
-- row's team are decided by identical logic. This adopts it rather than inventing
-- a second resolution, which is the brief's instruction and m431's whole purpose.
--
-- NULL IS FAIL-CLOSED, and the explicit `current_user_team_id() IS NOT NULL` guard
-- makes that visible rather than incidental. `agent_team_id(NULL)` is NULL and
-- `NULL = NULL` is NULL, never TRUE, so an unassigned listing and a team lead with
-- no resolvable team both resolve to "no rows" — never to the brokerage. That is
-- m431's stated direction: an unresolved team must not widen a team lead, because
-- the ruling IS the narrowing.
--
-- ── THE SCREENS ──────────────────────────────────────────────────────────────
--
-- Measured on a live rolled-back fixture, not inferred. BEFORE this migration a
-- team_lead, a tc and a compliance_officer each read ZERO rows of `listings` and
-- ZERO rows of `transactions` through the session client, because the only
-- surviving SELECT policies on those tables admit `agent`, `broker`/`broker_owner`
-- (listings only), `is_platform_admin()` and a scoped `vendor`. Every one of these
-- is a session-client surface, so RLS is the real gate:
--
--   app/dashboard/team/page.tsx — the team board. Already carries the tier model
--       (`boardScopeFor` returns "team" for team_lead/team_leader) and already
--       resolves the viewer's team through lib/kernel/resolve-user-team.ts, the
--       app-side twin of resolve_team_id(). Its Active Transactions card queries
--       `transactions` filtered by brokerage only and leaves the team narrowing to
--       RLS — so today it renders EMPTY for the very role it was built for. After
--       this it renders that lead's team's open deals, and no other team's.
--   app/actions/multi-persona.ts getTeamDashboard — session client, reads
--       `transactions` by the team's agent ids; called from the team page for each
--       team's roll-up. Same before/after.
--   app/actions/multi-persona.ts getCoordinatorDashboard — session client, the
--       coordinator dashboard's ONE workload read. Unchanged by this migration and
--       still empty for a tc: see RISK, below.
--
-- WHO GAINS NOTHING, deliberately: contact, lender and vendor accounts read zero
-- listings and zero transactions before and after. Nothing here touches them, and
-- the owner's ruling that they see only their own is untouched.
--
-- WHO LOSES NOTHING: no policy is narrowed for a role that could hold it, because
-- no role could hold any of these four. The team-board narrowing removes a
-- brokerage-wide disjunct from a predicate that was already false for everybody.
--
-- ── AND THE WRITES (brief §4(e)) ─────────────────────────────────────────────
--
-- Postgres evaluates the SELECT policy to LOCATE rows for an UPDATE or DELETE
-- carrying a WHERE, so a SELECT change can arm or disarm a write. Checked in both
-- directions here. Nothing is narrowed, so no write is disarmed. And the three
-- roles that GAIN a read arm no write: every UPDATE/DELETE policy on `listings`
-- requires user_type = 'agent' with row ownership, 'broker'/'broker_owner' with
-- the tenant, or is_platform_admin(); `transactions` has one UPDATE policy
-- (agent, own rows) and no DELETE policy at all. A team lead, a tc and a
-- compliance officer get a read and no pen.
--
-- ── THE POLICIES ARE MOVED OFF `public` ──────────────────────────────────────
--
-- All four are granted TO PUBLIC (polroles = {0}), so they are evaluated for the
-- `anon` role too. That is harmless today only because every helper bottoms out in
-- `select ... from users where id = auth.uid()` wrapped in COALESCE(..., false)
-- and auth.uid() is NULL for anon — i.e. the table's safety depends on the
-- internals of five functions rather than on the grant. m431 §C narrowed
-- commission_splits for exactly this reason; the same reasoning, and only the four
-- policies this migration rewrites, so no other policy on these tables changes.

do $$
declare
  team_listing_expr constant text :=
    'public.is_team_lead_role()
     and public.has_brokerage_access(brokerage_id)
     and public.current_user_team_id() is not null
     and public.agent_team_id(agent_id) = public.current_user_team_id()';

  team_txn_expr constant text :=
    'public.is_team_lead_role()
     and public.has_brokerage_access(brokerage_id)
     and public.current_user_team_id() is not null
     and (   public.agent_team_id(agent_id)        = public.current_user_team_id()
          or public.agent_team_id(seller_agent_id) = public.current_user_team_id()
          or public.agent_team_id(buyer_agent_id)  = public.current_user_team_id())';
begin
  alter policy compliance_read_brokerage_listings on public.listings
    using (public.is_compliance_officer_role() and public.has_brokerage_access(brokerage_id));
  alter policy compliance_read_brokerage_listings on public.listings to authenticated;

  alter policy tc_read_brokerage_listings on public.listings
    using (public.is_tc_role() and public.has_brokerage_access(brokerage_id));
  alter policy tc_read_brokerage_listings on public.listings to authenticated;

  execute format('alter policy team_leader_read_team_listings on public.listings using (%s)', team_listing_expr);
  alter policy team_leader_read_team_listings on public.listings to authenticated;

  execute format('alter policy team_leader_read_team_transactions on public.transactions using (%s)', team_txn_expr);
  alter policy team_leader_read_team_transactions on public.transactions to authenticated;

  raise notice 'm440: listings/transactions — compliance_manager→compliance_officer, transaction_coordinator→tc, team_leader→team_lead, each through its named helper; the team branch now resolves through m431 resolve_team_id() and the brokerage-wide disjunct that contradicted "teams should only see their own board" is gone.';
end $$;

-- The policy NAMES still say `team_leader`. They are deliberately NOT renamed:
-- m433 established that policy names are left alone because half of this schema's
-- guards key on them, and a name is not a predicate — it decides nothing. m441
-- reads pg_policy.polqual, never polname, for exactly that reason.

-- ═════════════════════════════════════════════════════════════════════════════
-- E. `vendor_subscriptions` — A TENANT TEST IS NOT A POLICY
-- ═════════════════════════════════════════════════════════════════════════════
--
-- WHAT IS THERE, measured (all four TO authenticated, all four the same
-- predicate):
--
--   vendor_subscriptions_tenant_select  USING      brokerage_id = current_user_brokerage_id()
--   vendor_subscriptions_tenant_insert  WITH CHECK brokerage_id = current_user_brokerage_id()
--   vendor_subscriptions_tenant_update  USING+CHK  brokerage_id = current_user_brokerage_id()
--   vendor_subscriptions_tenant_delete  USING      brokerage_id = current_user_brokerage_id()
--
-- No role test anywhere. The four `contact` accounts, the two `lender` accounts
-- and the two `vendor` accounts on this database all carry a brokerage_id, so
-- every one of them satisfies all four predicates on every row: read the
-- brokerage's subscription book, INSERT a subscription, UPDATE one — and, because
-- the WITH CHECK is the same bare tenant test, move it — and DELETE it.
--
-- WHAT IS IN THE ROW: which marketplace vendors the brokerage pays and on which
-- plan, `stripe_subscription_id` and `stripe_customer_id`, the billing period, and
-- `credits_used_this_period`. That is the brokerage's spend and its billing
-- identity. Owner ruling, verbatim: "contacts, lenders and vendors do not see
-- commission or any financials but only their own."
--
-- WHY THE TWO MONEY GUARDS BOTH MISSED IT, stated so the gap is on the record and
-- not rediscovered: m434 claim 3 and m439 claim 1 both discover their tables from
-- a family of settled-amount COLUMN NAMES. This table has no amount column.
-- m439's own header names it as a known exclusion — "the table has NO money column
-- at all… so it is not in the money family and claim 1 would not catch the shape
-- coming back there" — and it was right, and the shape was already there in a
-- different form. m441 widens the family by the metered-credit names, so
-- vendor_subscriptions and vendor_transactions are inside it and the next
-- credits/quota table is policed the day it exists.
--
-- THE TIER, straight from m433 — this is its 'vendor' tier, unchanged, so this
-- table stops being the one exception:
--
--   can_read_tenant_financials()                       Platform: all tenants,
--                                                      READ ONLY. Never in a write
--                                                      clause (m434 claim 5).
--   has_brokerage_access(brokerage_id)
--     AND can_read_brokerage_books()                   The brokerage's own book:
--                                                      admin, broker, broker_owner,
--                                                      broker_admin,
--                                                      compliance_officer.
--   is_current_user_marketplace_vendor(vendor_id)      "but only their own": the
--                                                      seller sees their own
--                                                      subscriptions. See section B
--                                                      for why this is NOT
--                                                      is_current_user_vendor().
--
-- WRITES get the books roster and nothing else — m433's `wri_books`:
-- is_platform_admin() OR (has_brokerage_access AND is_brokerage_admin()). Buying,
-- pausing and cancelling a subscription is a brokerage-admin act. A marketplace
-- seller is deliberately NOT given a write: they may see that a brokerage
-- subscribes to them, not change the terms. WITH CHECK carries the same tenant
-- test as USING so an UPDATE cannot move a subscription into another brokerage
-- (brief §4(f)).
--
-- NOTHING BREAKS. The table holds 0 rows and has NO application reader or writer:
-- the only mention of it anywhere in app/ is a comment in
-- app/actions/vendor-contact-access.ts calling the marketplace "a future paid
-- add-on", which m438 verified independently. Narrowing SELECT here disarms no
-- write, because the writes are narrowed in the same statement to a strict subset
-- of the readers (brief §4(e)).
--
-- `vendor_transactions` was checked for the same residue, as instructed. Its four
-- policies already carry m433's vendor tier — the bare tenant tests are gone. What
-- it does still carry is the id-class defect from section B: its SELECT names
-- `is_current_user_vendor(vendor_id)` while its vendor_id FKs
-- vendor_marketplace_profiles. That one disjunct is swapped for the helper that
-- matches the column's id class; the rest of its predicate is untouched.

do $$
declare
  sel_expr constant text :=
    'public.can_read_tenant_financials()
     or (public.has_brokerage_access(brokerage_id) and public.can_read_brokerage_books())
     or public.is_current_user_marketplace_vendor(vendor_id)';
  wri_expr constant text :=
    'public.is_platform_admin()
     or (public.has_brokerage_access(brokerage_id) and public.is_brokerage_admin())';
  pol record;
  n_sel int := 0;
  n_wri int := 0;
begin
  for pol in
    select p.policyname, p.cmd
    from   pg_policies p
    where  p.schemaname = 'public'
      and  p.tablename  = 'vendor_subscriptions'
      and  'service_role' <> all (p.roles)
  loop
    if pol.cmd = 'SELECT' then
      execute format('alter policy %I on public.vendor_subscriptions using (%s)', pol.policyname, sel_expr);
      n_sel := n_sel + 1;
    elsif pol.cmd = 'INSERT' then
      execute format('alter policy %I on public.vendor_subscriptions with check (%s)', pol.policyname, wri_expr);
      n_wri := n_wri + 1;
    elsif pol.cmd = 'UPDATE' then
      execute format('alter policy %I on public.vendor_subscriptions using (%s) with check (%s)', pol.policyname, wri_expr, wri_expr);
      n_wri := n_wri + 1;
    elsif pol.cmd = 'DELETE' then
      execute format('alter policy %I on public.vendor_subscriptions using (%s)', pol.policyname, wri_expr);
      n_wri := n_wri + 1;
    elsif pol.cmd = 'ALL' then
      -- USING decides the read AND which rows may be acted on; WITH CHECK decides
      -- what a row may BECOME. They must not be the same expression: read gets the
      -- tier, write gets the write roster, and Postgres ANDs the two on an UPDATE.
      execute format('alter policy %I on public.vendor_subscriptions using (%s) with check (%s)', pol.policyname, sel_expr, wri_expr);
      n_sel := n_sel + 1;
      n_wri := n_wri + 1;
    end if;
  end loop;

  if n_sel = 0 then
    raise exception 'm440: vendor_subscriptions has no non-service_role SELECT/ALL policy to rewrite. It had one when this was written; re-audit before assuming the table is closed.';
  end if;

  raise notice 'm440: vendor_subscriptions — % read clause(s) and % write clause(s) moved onto the m433 vendor tier; a contact, a lender and a vendor no longer reach the brokerage''s subscription book, and no longer hold a pen over it.', n_sel, n_wri;
end $$;

do $$
declare cur text;
begin
  select pg_get_expr(p.polqual, p.polrelid) into cur
  from   pg_policy p join pg_class c on c.oid = p.polrelid
  join   pg_namespace ns on ns.oid = c.relnamespace
  where  ns.nspname = 'public' and c.relname = 'vendor_transactions'
    and  p.polname = 'vendor_transactions_tenant_select';

  if cur is null then
    raise notice 'm440: vendor_transactions_tenant_select is absent — nothing to re-point.';
  elsif cur !~ 'is_current_user_vendor' then
    raise notice 'm440: vendor_transactions_tenant_select no longer names is_current_user_vendor() — leaving it alone.';
  else
    alter policy vendor_transactions_tenant_select on public.vendor_transactions
      using (
        public.can_read_tenant_financials()
        or (public.has_brokerage_access(brokerage_id) and public.can_read_brokerage_books())
        or public.is_current_user_marketplace_vendor(vendor_id)
      );
    raise notice 'm440: vendor_transactions — the vendor-own-row branch now tests the id class its vendor_id column actually holds (vendor_marketplace_profiles.id). It named is_current_user_vendor(), which resolves a vendors.id, so that disjunct could never have matched a row.';
  end if;
end $$;
