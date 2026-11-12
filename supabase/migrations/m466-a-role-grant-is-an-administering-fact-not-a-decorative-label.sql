-- m466 — A ROLE GRANT IS AN ADMINISTERING FACT, NOT A DECORATIVE LABEL
--
-- OWNER RULING (this migration exists to execute it): a solo-agent tenant has
-- TWO seats — the producing agent, and a second person who carries EVERYTHING
-- ELSE the business needs: transactions, compliance, support, admin, marketing.
-- Business roles are ASSIGNED to a user through public.user_role_assignments.
-- So a grant is an ADMINISTERING FACT, and ONE USER LEGITIMATELY HOLDING
-- SEVERAL ROLES IS THE DESIGNED CASE, not a data smell.
--
-- ── THE DISAGREEMENT, MEASURED BEFORE WRITING ───────────────────────────────
-- public.is_brokerage_admin() was, verbatim:
--     SELECT COALESCE((SELECT user_type IN ('admin','broker','broker_owner')
--                      FROM public.users WHERE id = auth.uid() LIMIT 1), FALSE)
-- It reads users.user_type ONLY. It has never looked at user_role_assignments.
--
-- The app's gate, lib/auth/require-brokerage-admin.ts, admits that SAME
-- user_type set AND a tenant role grant (the fallback whose comment reads
-- "Merged forward rather than dropped"). So the app and the database disagreed
-- about who administers a brokerage, and the database was the NARROWER of the
-- two — which is the dangerous direction: the app says yes, RLS returns zero
-- rows, error null, and the surface reports success over a write that never
-- happened.
--
-- LIVE PROOF OF THE DISAGREEMENT, re-measured for this migration:
--   agent1@yourbrokerage.com  (users.id 779eb048-7356-43bf-87a0-7fc9370f12f1)
--   users.user_type = 'agent'      → is_brokerage_admin() said FALSE
--   users.brokerage_id            = 231f4e64-5022-4752-8047-696886551c35
--   grants: admin + agent + isa, ALL on 231f4e64…  → the app said TRUE
-- That is the ruling's second seat, refused by every one of 225 policies.
--
-- m465 solved exactly this INLINE for one table (can_write_service_area tests
-- the grant with an EXISTS pinned to the row's brokerage_id) and explicitly
-- deferred the platform-wide fix: "Correcting it is a platform-wide act with a
-- platform-wide blast radius, not a side effect of a territory migration. It is
-- named so it can be decided on its own terms." That decision has now been made.
-- This is that correction, and it stays consistent with m465's shape.
--
-- ── THE AUDIT THAT DECIDED THE SHAPE ────────────────────────────────────────
-- MEASURED: is_brokerage_admin() is referenced by 225 policies over 112 tables
-- (211 write-side, 14 read-side). I classified all 225 rather than assuming they
-- are uniform, because they are not:
--
--   220  compose it with a ROW-TENANT test in the same expression — overwhelmingly
--        `has_brokerage_access(brokerage_id) AND is_brokerage_admin()`, plus 25
--        spelling it `brokerage_id = current_user_brokerage_id() AND …`.
--     5  carry NO tenant test at all (handled below).
--     0  use it NEGATED — checked, because widening a term under a NOT inverts
--        its meaning, and a widening that silently REVOKES is the worst outcome
--        available here.
--     0  already read user_role_assignments.
--
-- has_brokerage_access(t) is, verbatim:
--     is_platform_admin() OR (t IS NOT NULL AND t = current_user_brokerage_id())
--
-- THAT IS WHY THE ZERO-ARGUMENT FUNCTION IS ENOUGH — and the reasoning matters
-- more than the result, so it is written out rather than asserted:
--
--   is_brokerage_admin() takes no arguments, so it CANNOT SEE THE ROW and cannot,
--   by itself, pin a grant to the ROW's brokerage. That much is simply true and
--   is not worked around here. What it CAN do is pin the grant to the CALLER'S
--   OWN tenant (users.brokerage_id). And for the 220 policies that already
--   require row.brokerage_id = current_user_brokerage_id() beside it, the
--   composition is exactly the row-pinned test:
--
--       row.brokerage_id = caller.brokerage_id      (has_brokerage_access)
--     AND caller holds an admin grant ON caller.brokerage_id   (this function)
--     ⟹ caller holds an admin grant ON row.brokerage_id
--
--   So changing the ONE function gets tenant-pinned row semantics for 220 of the
--   225 without forking a second helper. Two definitions of "admin" is precisely
--   the drift this repo keeps paying to close, so a second helper was rejected.
--
-- A grant administering a DIFFERENT brokerage authorises NOTHING: the EXISTS is
-- pinned with `ura.brokerage_id = current_user_brokerage_id()`, so a grant whose
-- brokerage is not the caller's own never matches, on any table, in any policy.
-- Grants with a NULL brokerage_id are not tenant grants at all — MEASURED, the
-- live `lender` and `contact` grants both carry NULL — and `NULL = x` is NULL,
-- never true, so they are excluded by construction. The explicit IS NOT NULL is
-- kept anyway because a reader should not have to derive that.
--
-- ── WHAT THE user_type BRANCH DOES NOT DO ───────────────────────────────────
-- The user_type branch is copied through UNCHANGED and is deliberately NOT
-- pinned to the caller's tenant. It was not pinned before, 220 policies pin it
-- from the outside, and MEASURED there is no user_type-admin on this database
-- with a NULL brokerage_id. Pinning it here would be a second, independent
-- behaviour change riding along inside a migration about grants — and a widening
-- migration that quietly narrows something else is how a "safe" change takes an
-- account offline. It is left exactly as it was.
--
-- ── THE 5 POLICIES WITH NO TENANT TEST, AND WHY THEY ARE FIXED HERE ─────────
-- These five read policies test the role and NOTHING else, so a brokerage admin
-- of ANY tenant can read the whole table:
--   agent_certifications  "Agent certifications viewable by owner or admin"
--   compliance_alerts     "Compliance alerts viewable by transaction access"
--   compliance_checklists "Compliance checklists viewable by transaction access"
--   trid_timeline         "TRID timeline viewable by transaction access"
--   fair_housing_logs     "Fair housing logs viewable by compliance"
--
-- That cross-tenant read hole PREDATES this migration and I did not create it.
-- But widening the admin test without pinning them would ENLARGE the population
-- walking through it — closing one hole by opening another, which is the exact
-- failure mode m465 was written to avoid. So the tenant pin every other policy
-- already carries is added to these five, in the shape prohibited_phrases
-- already uses. is_platform_admin() survives as its own disjunct AND inside
-- has_brokerage_access, so platform staff lose nothing.
--
-- MEASURED FIRST: all five tables hold 0 rows, so this blanks no existing read.
-- The other disjuncts (the agent's own certification, the transaction the agent
-- owns, the compliance-officer role) are preserved verbatim — narrowing THOSE
-- is not what this migration is for.
--
-- ── REPORTED, NOT CHANGED ───────────────────────────────────────────────────
-- public.agent_licenses_verification_is_not_self_service() is the only trigger
-- calling this function, as a POSITIVE exemption
-- (`if is_platform_admin() or is_brokerage_admin() then return new`), not a
-- negative guard — so widening EXTENDS licence verification to the grant-admin
-- rather than weakening the self-service bar. Under the ruling that is correct:
-- the second seat carries compliance. It stays tenant-safe because the
-- agent_licenses policy already requires brokerage_id = current_user_brokerage_id()
-- before the trigger can ever fire. Proved live, both directions.
--
-- public.can_write_service_area() (m465) tests the grant itself with its own
-- EXISTS. After this change that clause is redundant — it is NOT removed. It is
-- pinned to the ROW's brokerage_id, which is strictly tighter than this
-- function's caller-tenant pin, it documents the rule at its own call site, and
-- deleting correct code to avoid duplication is how a gate loses a guard nobody
-- remembers was load-bearing.
--
-- IDEMPOTENT. Safe to re-run.

begin;

-- ── THE FUNCTION ────────────────────────────────────────────────────────────
-- SECURITY DEFINER is retained from the original and is load-bearing for the new
-- branch: user_role_assignments has RLS enabled with 5 policies of its own, and
-- under the caller's own RLS this authorisation read could itself be refused —
-- a refused authorisation read returns false and would fail the gate CLOSED
-- against a legitimate admin. Owner is `postgres` (rolbypassrls = true), so the
-- read inside this function bypasses those policies and cannot recurse through
-- them. It returns nothing but a boolean about the caller, so it leaks no rows.
--
-- `set search_path` is ADDED (the original had none). A SECURITY DEFINER function
-- without a pinned search_path resolves its table references against whatever the
-- caller's path happens to be, which is a privilege-escalation shape, and this
-- one now reads a second table.
create or replace function public.is_brokerage_admin()
returns boolean
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $$
  -- coalesce(..., false) WRAPS THE WHOLE OR, and that placement is the point.
  -- m465 shipped a first version that answered NULL because `x = auth.uid()` is
  -- NULL when auth.uid() is NULL, and SQL three-valued logic carries that NULL
  -- out through OR and AND. RLS treats NULL as unsatisfied so it fails closed and
  -- exposes nothing — but a boolean function that answers NULL is a trap for
  -- anything that ever composes it (a NOT, a coalesce with a different default,
  -- a join), and this function is composed by 225 policies and a trigger.
  -- Here the first branch is a scalar subquery that is NULL when the caller has
  -- no users row, so `NULL or false` would be NULL without this. It answers a
  -- strict boolean: could-not-establish = no.
  select coalesce(
    -- BRANCH 1 — user_type. Carried through UNCHANGED, values and all. Every
    -- account admitted before this migration is still admitted after it.
    (select u.user_type in ('admin', 'broker', 'broker_owner')
     from public.users u
     where u.id = auth.uid()
     limit 1)

    -- BRANCH 2 — a TENANT ROLE GRANT, which is what the ruling makes real.
    -- Mirrors lib/auth/require-brokerage-admin.ts, which admits the same three
    -- role values from user_role_assignments.
    --
    -- PINNED to current_user_brokerage_id(): the grant must administer the
    -- caller's OWN brokerage. A grant on another brokerage matches nothing here,
    -- so it authorises nothing in any of the 225 policies.
    --
    -- No LIMIT 1 and no .single(): user_role_assignments is UNIQUE on
    -- (user_id, role), NOT on user_id, so holding several grants at once is legal
    -- AND LIVE — one account holds three (admin + agent + isa). EXISTS is the
    -- right shape precisely because it is indifferent to how many rows match;
    -- the app-side copy of this rule was written with .maybeSingle() and threw
    -- for exactly the multi-grant users it existed to admit.
    or exists (
      select 1
      from public.user_role_assignments ura
      where ura.user_id      = auth.uid()
        and ura.role         in ('admin', 'broker', 'broker_owner')
        and ura.brokerage_id is not null
        and ura.brokerage_id = public.current_user_brokerage_id()
    ),
    false  -- could-not-establish = no. See the note above.
  );
$$;

comment on function public.is_brokerage_admin() is
  'TRUE when the caller administers their own brokerage, by users.user_type IN (admin,broker,broker_owner) OR by a role grant in user_role_assignments on their OWN brokerage_id. Mirrors requireBrokerageAdmin in lib/auth/require-brokerage-admin.ts. A grant on another brokerage authorises nothing. Takes no argument and therefore cannot see the row: the 220 policies that pair it with has_brokerage_access(brokerage_id) get row-pinned semantics from that composition. Returns a strict boolean, never NULL. See m466.';

-- ── THE 5 POLICIES THAT HAD NO TENANT TEST ──────────────────────────────────
-- Each keeps every other disjunct exactly as it was; only the bare
-- is_brokerage_admin() term gains the tenant pin the other 220 already carry.

drop policy if exists "Agent certifications viewable by owner or admin" on public.agent_certifications;
create policy "Agent certifications viewable by owner or admin"
  on public.agent_certifications
  for select
  using (
    public.is_platform_admin()
    or agent_id = public.current_user_agent_id()
    or (public.is_brokerage_admin() and public.has_brokerage_access(brokerage_id))
  );

drop policy if exists "Compliance alerts viewable by transaction access" on public.compliance_alerts;
create policy "Compliance alerts viewable by transaction access"
  on public.compliance_alerts
  for select
  using (
    public.is_platform_admin()
    or exists (
      select 1 from public.transactions t
      where t.id = compliance_alerts.transaction_id
        and t.agent_id = public.current_user_agent_id()
    )
    or (public.is_brokerage_admin() and public.has_brokerage_access(brokerage_id))
  );

drop policy if exists "Compliance checklists viewable by transaction access" on public.compliance_checklists;
create policy "Compliance checklists viewable by transaction access"
  on public.compliance_checklists
  for select
  using (
    public.is_platform_admin()
    or exists (
      select 1 from public.transactions t
      where t.id = compliance_checklists.transaction_id
        and t.agent_id = public.current_user_agent_id()
    )
    or (public.is_brokerage_admin() and public.has_brokerage_access(brokerage_id))
  );

drop policy if exists "TRID timeline viewable by transaction access" on public.trid_timeline;
create policy "TRID timeline viewable by transaction access"
  on public.trid_timeline
  for select
  using (
    public.is_platform_admin()
    or exists (
      select 1 from public.transactions t
      where t.id = trid_timeline.transaction_id
        and t.agent_id = public.current_user_agent_id()
    )
    or (public.is_brokerage_admin() and public.has_brokerage_access(brokerage_id))
  );

-- fair_housing_logs pins the COMPLIANCE-OFFICER term too. It is the same
-- untenanted-role-test defect in the same policy, and leaving it pinned on one
-- role and open on the other would read as a deliberate distinction that nobody
-- intended.
drop policy if exists "Fair housing logs viewable by compliance" on public.fair_housing_logs;
create policy "Fair housing logs viewable by compliance"
  on public.fair_housing_logs
  for select
  using (
    public.is_platform_admin()
    or (
      public.has_brokerage_access(brokerage_id)
      and (public.is_brokerage_admin() or public.is_compliance_officer_role())
    )
  );

commit;

-- ── MEASURED AFTER APPLYING, ON THE LIVE DATABASE ───────────────────────────
-- Each case run as the real account by setting the request JWT subject inside a
-- plpgsql DO block, results collected into a table, every seeded row removed
-- afterwards. RESIDUE: 0 (and user_role_assignments back to its original 7 rows).
-- Re-runnable: scripts/brokerage-admin-grant-simulator.ts (npm run test:brokerage-admin-grant).
--
-- WRITE GATE — INSERT accounting_sync_log, the dominant policy shape
-- `is_platform_admin() OR (has_brokerage_access(brokerage_id) AND is_brokerage_admin())`:
--
--   actor                                          is_brokerage_admin()  outcome
--   A grant-only admin agent1 → OWN tenant .......... TRUE (was FALSE)  ALLOWED 1 row
--   B grant-only admin agent1 → ANOTHER brokerage ... TRUE              REFUSED 42501
--   C plain agent (no grants) → own tenant .......... FALSE             REFUSED 42501
--   D team_lead grant (not an admin role) → own ..... FALSE             REFUSED 42501
--   E FOREIGN grant → own tenant .................... FALSE             REFUSED 42501
--   F FOREIGN grant → the GRANTED brokerage ......... FALSE             REFUSED 42501
--   G user_type admin → OWN tenant .................. TRUE              ALLOWED 1 row
--   H user_type admin → ANOTHER brokerage ........... TRUE              REFUSED 42501
--
-- E and F are the tenant pin: an 'admin' grant on a brokerage that is NOT the
-- holder's own authorises nothing — not in the granted brokerage, not anywhere.
-- A is the whole point, and G proves the pre-existing population did not regress.
--
-- UPDATE / DELETE — agent_licenses, whose DELETE policy is
-- `brokerage_id = current_user_brokerage_id() AND is_brokerage_admin()` and whose
-- SELECT policy is tenant-wide, so a zero row-count there isolates the ADMIN gate:
--
--   agent1 UPDATE verification_status, own tenant ... 1 row  (agent1 is NOT the
--       licence holder, so is_own_agent_id() is false and the ONLY route through
--       both the policy and the self-service TRIGGER is the widened admin test)
--   buyer@ (team_lead grant) same UPDATE ............ 0 rows, error NULL
--   agent1 DELETE, own tenant ....................... 1 row
--   agent1 DELETE, ANOTHER brokerage ................ 0 rows
--   buyer@ DELETE, own tenant ....................... 0 rows
--
-- READ PIN (the five policies above) — fair_housing_logs seeded with one row per
-- brokerage:
--   agent1 (tenant 231f4e64) sees .... 1 of 2 — its own tenant's row only
--   admin@vip.demo (tenant b0000000) . 1 of 2 — its own tenant's row only
-- Before this migration the second account matched the bare is_brokerage_admin()
-- term and would have seen BOTH.
--
-- STRICT BOOLEAN — with no identity at all, is_brokerage_admin() returns FALSE,
-- not NULL. Asserted directly, because RLS hiding a NULL behind fail-closed is
-- exactly how the m465 defect survived its first apply.
--
-- ── TWO MEASUREMENT TRAPS THIS PROOF HIT, RECORDED SO THE NEXT ONE DOES NOT ──
-- Both made a PASSING write read as a refusal, which would have been reported as
-- "the fix does not work" if the first result had been believed:
--
--  (1) `INSERT … RETURNING` applies the table's SELECT policy to the returned
--      row. On accounting_sync_log that policy is a DIFFERENT gate
--      (can_read_brokerage_books()), so the insert SUCCEEDED and the RETURNING
--      raised 42501. Dropping RETURNING showed `ALLOWED rows=1`. This is the SQL
--      twin of the supabase-js rule: measure the write with a row COUNT, never
--      through a read that carries its own gate.
--  (2) `UPDATE/DELETE … WHERE` must READ the row first, so SELECT policies apply
--      there too. agent1 cannot read accounting_sync_log (same financial gate),
--      so both returned 0 rows for a reason that had nothing to do with the admin
--      test. Re-run on agent_licenses, whose SELECT is tenant-wide, they behave
--      as designed. A probe pinned to the wrong gate measures the wrong claim.
--
-- ── A THIRD DEFINITION OF "ADMIN", FOUND AND DELIBERATELY NOT CHANGED ───────
-- public.can_read_brokerage_books() is
--   user_type IN ('admin','broker','broker_owner','broker_admin','compliance_officer')
-- — user_type ONLY, no grant, no tenant argument. It gates READS of the financial
-- tables (accounting_sync_log and siblings). So the grant-holding second seat can
-- now WRITE those tables but still cannot READ them, which is very likely also
-- wrong under the same ruling.
--
-- It is NOT changed here. It is a different question (who may read the books)
-- with a different blast radius and a different risk profile from who may
-- administer the tenant, it admits a different role set (broker_admin,
-- compliance_officer), and quietly widening a financial READ gate inside a
-- migration about administering grants is precisely the drive-by this migration's
-- own reasoning argues against. It is named here so it can be decided on its own
-- terms — the same way m465 named this one.
