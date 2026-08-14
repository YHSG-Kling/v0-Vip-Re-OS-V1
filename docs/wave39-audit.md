# Wave 39 — a policy that names a role nobody can hold

Two defects, one family: **a predicate that reads like protection and decides
nothing.** Both were measured live before a line was written.

## 1. Seven policies gated on a `user_type` the CHECK cannot store

`users_user_type_check` admits exactly: admin, agent, broker, broker_owner,
compliance_officer, contact, isa, lender, superadmin, support, system, tc,
team_lead, vendor. Seven live policies named something else, so their predicate
was **FALSE for every user who will ever exist**:

| policy | named | verdict |
|---|---|---|
| `closing_disclosure.title_agent_select_closing_disclosure` | `title_agent` | DROPPED |
| `closing_disclosure.title_agent_create_closing_disclosure` | `title_agent` | DROPPED |
| `cda_comparison_results.title_agent_select_cda_comparison` | `title_agent` | DROPPED |
| `listings.compliance_read_brokerage_listings` | `compliance_manager` | REPAIRED |
| `listings.tc_read_brokerage_listings` | `transaction_coordinator` | REPAIRED |
| `listings.team_leader_read_team_listings` | `team_leader` | REPAIRED + NARROWED |
| `transactions.team_leader_read_team_transactions` | `team_leader` | REPAIRED |

**This is not a typo seven times — it is one unbuilt vocabulary, copied.**
`supabase/rls-governance/000-helper-functions.sql` declares an `auth.*` family
(`auth.is_team_leader()` = `'team_leader'`, `auth.is_tc()` =
`'transaction_coordinator'`, …). **None of those functions exists on this
database** — that file needs a dashboard superuser connection and was never run.
What *was* run is `scripts/111-fix-agent-id-rls-policies.sql`, which **inlines
those helper bodies verbatim** into policies, in a file that does execute.

So repair-vs-delete was decided per policy against the repository's own mapping
(`lib/security/types.ts`, `LEGACY_ROLE_MAP`). Three legacy spellings fold onto a
**real, live** role (one account each). `title_agent` folds onto nothing: m307
removed it from the CHECK, a title company is a `vendors.category = 'title'`, and
the live `title@vip.demo` account is `user_type = 'vendor'` — the route that works
already exists. Three repaired, one deleted, each with the reason on the record.

### The team ruling, and the disjunct that contradicted it

`team_leader_read_team_listings` was, in full:

```
user_type = 'team_leader'
AND ( brokerage_id = <the caller's brokerage>          ← the WHOLE brokerage
      OR agent_id IN (…users.team_id…) )               ← the team board
```

Repairing only the spelling would have turned **a policy that grants nothing into
a policy that grants everything**, one table away from the ruling it contradicts
("teams should only see their own board"). The brokerage disjunct is gone and the
team equality is what the policy now *is*. Both policies also resolved the team
through `users.team_id` — one of four places a team is recorded, and the one that
is NULL for all 23 live users. They now use m431's `current_user_team_id()` /
`agent_team_id()`, so the reader's team and the row's team cannot be decided
differently. NULL is fail-closed, made explicit with `IS NOT NULL`.

## 2. `vendor_subscriptions` reached its tenant with no role test at all

After m438 dropped its two tenant-free `user_type` policies, all four remaining
policies were the bare `brokerage_id = current_user_brokerage_id()` — on SELECT,
INSERT, UPDATE **and DELETE**. The four contact, two lender and two vendor
accounts all carry a brokerage_id, so each could read the brokerage's
subscription book (which vendors it pays, `stripe_customer_id`,
`stripe_subscription_id`, the credit burn), insert one, **move** one across
tenants (same bare test as WITH CHECK), and delete it.

**Why both money guards missed it, on the record so it is not rediscovered:**
m434 claim 3 and m439 claim 1 discover their tables from a family of settled
**amount** column names. This table has no amount column — a metered product's
unit of account is a **credit**. m439's own header named it as a known exclusion,
and was right, and the shape was already there in another form. m441 claim 5
widens the family by the credit-ledger names, which admits exactly two tables
(`vendor_subscriptions`, `vendor_transactions`) — both already on a tier — so the
widening is enforceable today rather than aspirational.

## A dead capability I shipped in m433, found by reading the foreign key

There are **two vendor identities** on this schema and they are different tables:
`vendors` (the brokerage's directory, reached via `user_role_assignments
.vendor_id`) and `vendor_marketplace_profiles` (the platform seller).
`vendor_transactions.vendor_id` and `vendor_subscriptions.vendor_id` both FK
**`vendor_marketplace_profiles`** — verified in `pg_constraint` — while m433 put
`is_current_user_vendor(vendor_id)` on `vendor_transactions`, which resolves a
`vendors.id`. **Two disjoint uuid spaces: false for every row that will ever
exist.** Invisible only because 0 of 7 role assignments carry a vendor_id — the
exact condition under which a right branch and a wrong one look identical.

`is_current_user_marketplace_vendor()` is the answer to the *other* question, and
m441 claim 6 asserts the pairing **from the foreign key** rather than from a list
of table names.

## The source that recreates the defect was repaired, not annotated

`scripts/111`, and `rls-governance/004`, `/005`, `/014` all carry
`CREATE POLICY` blocks in the pre-m440 shape — including the whole-brokerage team
disjunct. A warning header does not stop a bootstrap script; **the file's own
`CREATE POLICY` text is what decides what exists after it runs.** All four now
match what m440 installed, so a re-run reinstalls the repair. `000-helper
-functions.sql`'s rosters were made positive (naming both spellings) and
`auth.is_title_agent()` carries a warning that it is false for everybody.

`014`'s `team_leader_read_team_contacts` needed more than a spelling fix: the live
database already carries this capability under a **different name**
(`contacts.team_lead_read_team_contacts`), so creating 014's copy would have added
a second, wider policy beside it — and permissive policies OR together, so the
looser one would have decided access.

## Proof — a rolled-back live fixture

Two teams, so the proof covers both halves of the ruling. The live team lead is
`user_type = 'agent'` (W37 recorded this, and it is why ruling 1 is inert on live
data), so the fixture corrects it *inside a transaction that cannot commit* —
what is proved is the policy, not the data defect.

| principal | listings | transactions | |
|---|---|---|---|
| **team_lead** (leads team A) | **3 of 4** | **2 of 3** | team A only — team B's listing and deal are invisible |
| agent (on team A) | 4 | 2 | own rows; brokerage-wide listings is the documented MLS/co-op rule |
| **tc** | **4** | 0 | **was 0** — the repair landed |
| **compliance_officer** | **4** | 0 | **was 0** — the repair landed |
| broker | 4 | 0 | |
| contact / lender / vendor | 0 / 0 / 0 | 0 / 0 / 0 | owner ruling holds |

Class-A census schema-wide: **7 before m440, 0 after.** The extractor resolved
130 of 130 policies mentioning `user_type` — zero blind spots. Class B (a dead
literal *beside* a live one, which widens a roster to nobody) is **48 policies /
55 literals** in five spellings; recorded as a warning with the count named, so a
green run cannot be read as "no dead role spellings remain".

## Found while verifying, deliberately not fixed

- **#199, and it is a live dead screen.** `transactions` has **no SELECT policy
  for broker, admin, tc or compliance**. A broker reads **0** of their own
  brokerage's deals. `rls-governance/004` declares all four in words and in
  `CREATE POLICY` blocks — but that file has never run here. Declared and absent.
- **#200, the sharpest.** `closing_disclosure` and `cda_comparison_results` carry
  m438's exact class: `FOR ALL` **to PUBLIC**, predicate is a bare `user_type`
  test with **no tenant term** — any broker may read, alter or DELETE another
  brokerage's settlement figures. Stacked with the **NULL escape** on
  `closing_disclosure_tenant`: `(brokerage_id IS NULL) OR (…)` means an unstamped
  row is **published to every tenant**, not hidden — on all four commands.
- **#201.** `vendor_marketplace_profiles` has a tenant-free `FOR ALL` over
  `api_key_encrypted` and `stripe_account_id`. It has no `brokerage_id` to anchor
  to, so it needs a ruling, not a sweep. Widening m441 claim 5 to text billing ids
  was measured and rejected: it would make the guard red on someone else's table
  on the day it applied, which is how a guard gets disabled.

## Verification

Typecheck EXIT=0 cold. Guard chain both halves. m440 and m441 applied via
`apply_migration` and confirmed in `supabase_migrations.schema_migrations` —
**a migration file is not a migration**, and this branch has now been bitten by
that rule in both directions (applied-but-uncommitted, and committed-but-
unapplied, which is why m440/m441 were untracked until they were live). Every
assertion was negative-controlled **before** its change: m441's control named
exactly the seven class-A policies and nothing else schema-wide. m440's outcome
was verified by querying the catalogue afterwards rather than by trusting a clean
apply — the discipline that caught the DELETE hole m433 opened.
