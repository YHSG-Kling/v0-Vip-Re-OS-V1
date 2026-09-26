# Wave 37 — who may see which money

Owner rulings, verbatim:

> "teams should only see their own board. contacts, lenders and vendors do not see
> commission or any financials but only their own. platform needs to see all
> tenants and their users. agents should only see their own commission splits."

## The defect was one clause, and it was schema-wide

Every brokerage-wide financial read was written as
**`(NOT is_agent_role()) AND has_brokerage_access(brokerage_id)`**.
`is_agent_role()` is exactly `user_type = 'agent'`, so "not an agent" is TRUE for
a contact, a lender and a vendor. That single clause is how a client read the
brokerage's commission book.

Every fix in this wave is a **positive role list**. A negative test admits every
role invented later — which is how the defect arrived in the first place.

## My census was wrong twice, and an agent corrected it both times

I searched for policies mentioning `current_user_brokerage_id`. That missed a
second spelling: a policy can be role-free while still naming `is_agent_role`,
when an **unconditional `has_brokerage_access(brokerage_id)`** sits as a third
disjunct beside it (`agent_monthly_earnings`, `agent_credit_budgets`). The true
construct is *any brokerage-reaching disjunct not guarded by a positive role
test*, in four spellings. Re-derived from the catalogue intersected with tables
carrying a **settled money-amount column** — amounts, not rates, so deal terms an
agent works from do not drag operational tables in.

**25 tables became 45.** Genuinely new and confirmed leaking to portal roles:
the **closing disclosure** (`gross_commission`, `agent_net`, `brokerage_net`),
`agent_monthly_earnings`, `agent_credit_budgets`, `agent_fee_charges`,
`recruiting_*`, `referrals`, `net_sheet_calculations`, `transaction_cost_breakdown`,
`subscriptions`, `accounting_sync_log`, and more.

`agent_monthly_earnings` was worse than a read leak: `ame_insert WITH CHECK (true)`
and `ame_update WITH CHECK (true)`. Any authenticated user — a contact included —
could create an earnings row naming any agent of any brokerage, and a legitimate
update could **move** the row to another tenant.

## Five tiers, one helper each

| tier | helper | visibility |
|---|---|---|
| Platform | `can_read_tenant_financials()` | all tenants, **read only** |
| Brokerage | `can_read_brokerage_books()` | own tenant's whole book |
| Team | `can_read_team_books()` | **own team only** |
| Agent | `can_read_agent_books()` | own rows |
| Vendor | `is_current_user_vendor()` | **their own invoice/payout, nothing else** |

45 tables, 51 clauses, applied by a driven loop so no table can drift from its
tier. Writes moved too — Postgres consults SELECT to locate rows for a filtered
UPDATE/DELETE, so leaving writes at `brokerage_id = current_user_brokerage_id()`
would have left a contact able to INSERT money it could not read.

**Vendors are the "but only their own" half.** The linkage already existed and is
already canonical — `user_role_assignments.vendor_id`, which the vendor invoices
page calls "Canonical vendor linkage" and which `vendor_has_transaction_access()`
already uses. Nothing invented. **0 of 7 role assignments carry a vendor_id
today**, so an unlinked vendor account fails closed.

## The team model was four-way, and the live data contradicts all of it

Team membership can be recorded in **four** places: `teams.team_lead_id`,
`users.team_id`, `team_members`, `agents.team_id`. `users.team_id` is NULL for all
23 users; `team_members` is empty; `agents.team_id` has one row. The only
populated fact is `teams.team_lead_id`.

The existing precedent — `team_leader_read_team_contacts` in `scripts/111` — is
**dead code on live data**: it gates on `user_type = 'team_leader'`, a spelling
absent from the live CHECK constraint, and resolves through `users.team_id`, which
is NULL for everyone.

`resolve_team_id()` is now the one rule, with `current_user_team_id()` and
`agent_team_id()` as thin entry points so the reader's team and the row's team
cannot be decided differently. **NULL means not on a team and is fail-closed** —
deliberately the opposite of `resolve-user-office.ts`, where NULL means "not
pinned, see everything". An unpinned office correctly widens an admin; an
unresolved team must never widen a team lead, because the ruling *is* the narrowing.

## Ruling 4 already held

An agent already saw only their own splits after m427, because `is_agent_role()`
being true made the brokerage branch false. No change was invented; m432 claim 3
is what stops it coming back.

## A hole I opened, found by verifying my own work

m433's loop set `using (sel_expr)` on `FOR ALL` policies. That is right for SELECT
and INSERT — and **wrong for DELETE**, because on a `FOR ALL` policy USING alone
governs DELETE with no WITH CHECK to stop it. So the read expression became a
delete grant for the read-only platform tier on four tables. Caught by querying
the outcome rather than trusting the migration.

m437 subtracts it with **RESTRICTIVE** DELETE policies, which can only ever narrow
— rather than splitting each `FOR ALL` into per-command policies, which needs
DROP/CREATE and would change names that guards pin. m434's claim 4 therefore
measures the **effect**: the helper may sit on a `FOR ALL` USING only where a
restrictive DELETE guard subtracts it back.

## The platform could not see its own tenants — in two layers

`brokerages_select` gated on `is_platform_admin()`, which is superadmin alone;
`users` had **no platform clause at all**. Measured: a support operator saw 1
brokerage and 5 of 23 users. After: 23 and 2, with an ordinary agent unchanged.

And the console gated on `users.user_type !== 'superadmin'` — a value **no live
row has**, because the roster is carried on `platform_role`. Both pages returned
"Failed: Forbidden" to every caller including the owner. Eleven more sites carry
the same dead gate (#192).

**A correction to my own guidance:** I said a pinned `search_path` prevents a
`users` policy recursing into helpers that read `users`. It does not —
`public.users` is owned by `postgres` without force-RLS, and a table owner is
exempt from its own RLS. **Ownership** is the guard. m436(4) asserts it and goes
red on `FORCE ROW LEVEL SECURITY`.

## Reported, deliberately not fixed

- **#193, the sharpest.** `closing_disclosure_agreement` carries four `FOR ALL`
  policies whose entire predicate is a `user_type` check with **no tenant test**.
  A broker at one brokerage can read, alter or delete another's settlement
  records. Permissive policies OR together, so the correctly-scoped tenant
  policies beside them protect nothing. Same class on `commission_structures` and
  `vendor_transactions`.
- **Ruling 1 is inert on live data.** The live team lead has `user_type = 'agent'`,
  so `is_team_lead_role()` is false for them; the only `team_lead` account leads
  no team. Fail-closed, not a leak — but the ruling does nothing until
  `users.user_type` is corrected.
- `credit_accounts` — a *contact's* consumer credit data, readable brokerage-wide
  including by lender and vendor accounts. Not the brokerage's financials, and
  whether a lender should see a buyer's credit is a ruling not yet made.
- The four-way team split still exists in application code; `resolve-user-team.ts`
  is now available as the one rule but routing the call sites through it is a
  separate sweep.

## Verification

Typecheck EXIT=0 cold. Guard chain both halves — 28/28 and 457/457 with
`test:sweep` last. m431–m437 applied and confirmed in the ledger, each assertion
negative-controlled **before** its change (m432's control named exactly the two
ledger policies carrying the negated probe, and nothing else schema-wide; m436's
named both missing platform clauses and 8 PUBLIC grants). Every live proof ran
inside a transaction ended by a `raise`; zero leftovers re-verified.

`test:orphan-exports` went red on a new export with no caller and was right:
`pickUserTeam` was exported to mirror its office twin, but no caller holds all four
team sources. Made module-private — it is still called three times by
`resolveUserTeam`, which is wired. The baseline was not raised.
