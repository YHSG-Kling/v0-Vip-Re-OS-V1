-- m427 — THE OWNER'S TWO COMMISSION RULINGS, PLUS THE OFFICE STAMP THEY REST ON.
--
--   "the clsoed commission needs to stay on the office that closed the deal.
--    agent's commission earned is located in their accounts. …
--    1. admin, superadmin, support can read tenant financilas of platform.
--    2. a brokerage can only have access to their own commission."
--
-- Four things, in the order they depend on each other:
--
--   A. `commission_splits.location_id` — the office is STAMPED at close, not
--      derived at read time.
--   B. `can_read_tenant_financials()` — the platform's financial readers, which
--      is a THIRD roster: not is_platform_admin() (superadmin alone) and not
--      is_platform_staff() (which includes marketing).
--   C. `agent_commissions` policies — the two access rulings applied.
--   D. `commission_splits` SELECT — the same two rulings, so the two commission
--      tables stop disagreeing about who may read a number.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- A. THE OFFICE IS STAMPED, NOT DERIVED
-- ─────────────────────────────────────────────────────────────────────────────
--
-- lib/intelligence/brokerage-pnl.ts built its per-office breakdown by joining the
-- producing agent to `agents.location_id` — the agent's CURRENT office. That was
-- a deliberate, documented trade (the doc comment on OfficeProduction said so out
-- loud) whose stated cost was: "an agent who TRANSFERS offices retroactively
-- moves their whole commission history with them, because the join asks where
-- they are NOW, not where they were when the deal closed."
--
-- The owner has ruled that cost unacceptable. A closed commission belongs to the
-- office that closed the deal, permanently. A derived office cannot express that,
-- because the only thing it can ever report is the present. So the office becomes
-- a fact recorded ON the split row at the moment the split is written, and the
-- P&L reads the stamp instead of re-deriving it.
--
-- NULLABLE, and that is the design. `commission_splits` has 0 rows on this
-- database, so there is no history to backfill — but nullable is still correct
-- going forward, because an agent genuinely may not be pinned to an office (a
-- single-office brokerage has no `locations` rows at all). The P&L folds NULL
-- into a NAMED bucket ("No office assigned") rather than dropping it, so the
-- office rows still sum to the brokerage total. A NOT NULL here would instead
-- make the split insert FAIL for every unpinned agent and take the commission
-- ledger down with it.
--
-- ON DELETE SET NULL, matching m423's rule for `users.location_id`: deleting an
-- office must not delete the money. The closing falls back into the named null
-- bucket, which is visible, rather than vanishing from the books.
--
-- The office is resolved through lib/kernel/resolve-user-office.ts
-- (users.location_id wins over agents.location_id) — the ONE precedence rule for
-- a person's office. This migration deliberately adds no second one: there is no
-- trigger and no DEFAULT computing `location_id` from the agent, because a
-- database-side derivation would be exactly the second rule, and it would drift
-- from the resolver the moment m423's precedence changed.

alter table public.commission_splits
  add column if not exists location_id uuid
  references public.locations(id) on delete set null;

comment on column public.commission_splits.location_id is
  'Office that closed this deal, STAMPED at write time by both writers (app/actions/agents.ts addAgentCommission, lib/kernel/financial.ts createCommissionRecord) from lib/kernel/resolve-user-office.ts. Owner ruling: the closed commission stays on the office that closed the deal — so this is never re-derived from agents.location_id at read time, which would move an agent''s whole history with them when they transfer. NULL = the producing agent was not pinned to an office; lib/intelligence/brokerage-pnl.ts folds NULL into a named "No office assigned" bucket so the office rows still sum to the brokerage total.';

create index if not exists commission_splits_location_id_idx
  on public.commission_splits(location_id) where location_id is not null;

-- ─────────────────────────────────────────────────────────────────────────────
-- B. THE PLATFORM'S FINANCIAL READERS — A THIRD ROSTER, NOT A WIDENED HELPER
-- ─────────────────────────────────────────────────────────────────────────────
--
-- Ruling 1 names three roles: admin, superadmin, support. Neither existing helper
-- is that set:
--
--   is_platform_admin()  = superadmin only. 522 policies across 179 tables depend
--                          on it meaning exactly that (measured in m408), so it
--                          is not touched here either — TOO NARROW for this
--                          ruling, and un-widenable without handing every one of
--                          those policies away.
--   is_platform_staff()  = superadmin, admin, marketing, support. TOO BROAD: the
--                          standing platform-staff roster (#169) has four roles,
--                          and the owner's financial ruling named three of them.
--                          Marketing is excluded, and that exclusion is the whole
--                          point of ruling 1 — using is_platform_staff() here
--                          would hand a marketing account every tenant's
--                          commission ledger.
--
-- So a third helper, named for what it GRANTS rather than for who holds it. It is
-- is_platform_staff() minus 'marketing', reproduced otherwise byte-for-byte:
-- same SECURITY DEFINER (reads `users` without tripping users' own RLS and
-- without recursing into a policy that calls it), same STABLE volatility (the
-- planner may cache it per statement instead of re-querying per row), same
-- COALESCE(..., FALSE) so an unauthenticated caller is FALSE and not NULL, same
-- pinned search_path, and the same legacy `user_type IN ('superadmin',
-- 'super_admin')` marker so a superadmin who predates the platform_role column
-- never loses access through this file.

create or replace function public.can_read_tenant_financials()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select platform_role in ('superadmin', 'admin', 'support')
         or user_type      in ('superadmin', 'super_admin')
     from public.users where id = auth.uid() limit 1),
    false
  );
$$;

comment on function public.can_read_tenant_financials() is
  'TRUE for the platform roles the owner authorised to READ tenant financials — superadmin, admin, support — plus the legacy users.user_type superadmin marker. Deliberately NOT is_platform_staff(), which also includes marketing: the standing staff roster is four roles but the financial ruling named three. Deliberately NOT is_platform_admin(), which is superadmin-only and is depended on by hundreds of policies for destructive and cross-tenant rights. READ ONLY by intent — the ruling says "can read", so this helper appears in SELECT policies and must not be added to an INSERT/UPDATE/DELETE clause.';

revoke all on function public.can_read_tenant_financials() from public;
grant execute on function public.can_read_tenant_financials() to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────────────────────
-- C. `agent_commissions` — BOTH ACCESS RULINGS
-- ─────────────────────────────────────────────────────────────────────────────
--
-- WHAT THE FOUR POLICIES SAY TODAY. All four are the identical expression,
-- `brokerage_id = current_user_brokerage_id()`, TO authenticated. Two consequences
-- were verified against the live database before this was written:
--
--   (1) Platform staff can read NOTHING. A superadmin's `users.brokerage_id` is
--       their own tenant or NULL, so the equality is false or NULL for every
--       other brokerage's rows. is_platform_admin() appears nowhere on this
--       table. Ruling 1 is therefore not merely unimplemented — it is inverted.
--
--   (2) EVERY authenticated user in a brokerage reads EVERY colleague's
--       earnings. There is no per-agent clause at all, so the ordinary agent,
--       and equally the `contact`, `lender` and `vendor` portal accounts that
--       carry a brokerage_id, all satisfy the same equality on all of it. Ruling
--       "agent's commission earned is located in their accounts" says an agent's
--       account is where their OWN earnings live — not a window onto the
--       brokerage's payroll.
--
-- THE NEW SELECT, three disjuncts, each traceable to a ruling:
--
--   can_read_tenant_financials()                       ← ruling 1
--   (is_agent_role() and agent_id = current_user_agent_id())
--                                                      ← "in their accounts"
--   ((not is_agent_role()) and has_brokerage_access(brokerage_id))
--                                                      ← ruling 2, unchanged for
--                                                        everyone who is not an
--                                                        ordinary agent
--
-- The agent disjunct is spelled EXACTLY as `commission_splits` already spells it,
-- so the two commission tables answer "may I see this agent's money" the same
-- way. `is_agent_role()` is `user_type = 'agent'` — broker, broker_owner, admin,
-- team_lead, tc and compliance_officer are all NOT agent-role and keep the whole
-- brokerage through the third disjunct, which is byte-equivalent to today's rule
-- for them. That is deliberate: the brokerage-wide screens (the team leaderboard
-- at app/dashboard/team/page.tsx, getBrokerageStats at app/actions/agents.ts,
-- getBrokerageDashboard at app/actions/multi-persona.ts) are read by exactly
-- those roles and must not break.
--
-- `has_brokerage_access(x)` replaces the inlined equality for the same reason
-- m419/m420 gave: it is the ONE place a multi-location relationship would ever be
-- taught, and it rejects a NULL tenant explicitly. `agent_commissions.brokerage_id`
-- is NOT NULL so the NULL branch is unreachable here — it is used for the
-- inheritance, not for the null check.
--
-- THE WRITES, AND WHY THEY MOVE TOO. Postgres evaluates the SELECT policy to
-- LOCATE rows for an UPDATE or DELETE carrying a WHERE that reads the table's
-- columns. Narrowing SELECT alone would therefore have left an agent able to see
-- exactly one row — their own commission — and still able to UPDATE it, which is
-- the worst possible residue: an agent who can rewrite their own `gross_commission`.
-- So the three write commands take the write-side rule `commission_splits`
-- already uses, verbatim:
--
--   is_platform_admin() or (is_brokerage_admin() and has_brokerage_access(brokerage_id))
--
-- can_read_tenant_financials() is deliberately ABSENT from all three. The ruling
-- says "read". A support operator gets the ledger, not a pen.
--
-- WHICH WRITERS THIS AFFECTS — every session-client writer was read first:
--   app/actions/financials.ts:503  updateCommissionStatus — already gated in code
--       to broker/admin/superadmin, all of which satisfy is_brokerage_admin() or
--       is_platform_admin(). Keeps working.
--   app/actions/agents.ts:649      updateCommissionStatus — no in-app caller; it
--       is a bare "use server" export, i.e. an open HTTP endpoint that today lets
--       ANY authenticated tenant user flip ANY commission in their brokerage to
--       'paid'. This migration is what closes it.
--   app/actions/agents.ts:582      addAgentCommission — likewise no in-app caller
--       and likewise an open endpoint; now brokerage-admin only.
--   lib/kernel/financial.ts        createCommissionRecord and every status
--       transition use createServiceClient(), which is not subject to RLS. They
--       are unaffected either way.
-- With `agent_commissions` at 0 rows there is nothing in flight to break.

do $$
begin
  alter policy agent_commissions_tenant_select on public.agent_commissions
    using (
      can_read_tenant_financials()
      or (is_agent_role() and agent_id = current_user_agent_id())
      or ((not is_agent_role()) and has_brokerage_access(brokerage_id))
    );

  alter policy agent_commissions_tenant_insert on public.agent_commissions
    with check (
      is_platform_admin()
      or (is_brokerage_admin() and has_brokerage_access(brokerage_id))
    );

  alter policy agent_commissions_tenant_update on public.agent_commissions
    using (
      is_platform_admin()
      or (is_brokerage_admin() and has_brokerage_access(brokerage_id))
    )
    with check (
      is_platform_admin()
      or (is_brokerage_admin() and has_brokerage_access(brokerage_id))
    );

  alter policy agent_commissions_tenant_delete on public.agent_commissions
    using (
      is_platform_admin()
      or (is_brokerage_admin() and has_brokerage_access(brokerage_id))
    );

  raise notice 'm427: agent_commissions — platform financial readers may READ; an ordinary agent sees only their own rows; brokerage-wide read is unchanged for every non-agent role; writes are brokerage-admin only.';
end $$;

-- ─────────────────────────────────────────────────────────────────────────────
-- D. `commission_splits` SELECT — THE SAME TWO RULINGS ON THE OTHER LEDGER
-- ─────────────────────────────────────────────────────────────────────────────
--
-- It would be incoherent to lock an agent out of a colleague's row in
-- `agent_commissions` and leave the identical number readable one table over. The
-- split ledger carries `agent_amount` and `brokerage_amount` for the SAME
-- commission — m419's own comment records that both writers create the twin rows
-- together. So the same two rulings land here:
--
--   · can_read_tenant_financials() is ADDED alongside is_platform_admin(). Today
--     only the superadmin can read a split; ruling 1 extends that to admin and
--     support. is_platform_admin() is kept explicitly rather than absorbed,
--     because has_brokerage_access() carries it and removing it would make this
--     expression depend on that inheritance being noticed by the next reader.
--   · The unconditional `has_brokerage_access(brokerage_id)` disjunct becomes
--     `(not is_agent_role()) and has_brokerage_access(brokerage_id)`. Before this,
--     the agent-own disjunct m419 documented was DEAD CODE: an ordinary agent
--     already matched every row in their brokerage through the third disjunct, so
--     the narrower clause never decided anything. Now it does.
--
-- m420's invariant is preserved and must stay preserved: every non-empty USING
-- and WITH CHECK expression on this table still names
-- `has_brokerage_access(brokerage_id)`. The three write policies are NOT touched
-- by this file — m419 set them correctly and they already exclude agents.
--
-- The only session-client reader of this table, app/dashboard/financials/page.tsx,
-- filters `.eq("agent_id", agentId)` on the caller's own agent id, so it returns
-- the same rows before and after. lib/intelligence/brokerage-pnl.ts reads it
-- through createServiceClient() and is not subject to RLS.

do $$
begin
  alter policy commission_splits_select on public.commission_splits
    using (
      is_platform_admin()
      or can_read_tenant_financials()
      or (is_agent_role() and agent_id = current_user_agent_id())
      or ((not is_agent_role()) and has_brokerage_access(brokerage_id))
    );

  raise notice 'm427: commission_splits SELECT — platform financial readers added; the agent-own disjunct is no longer dead code.';
end $$;
