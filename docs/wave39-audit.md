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

---

# Wave 40 — the settlement record gets a tenant

Follow-on, from what W39's verification surfaced (#200). Same class m438 closed on
`closing_disclosure_agreement`, still open on its two sibling tables.

## Two defects, stacked

**Six policies, `FOR ALL`, TO PUBLIC, whose entire predicate was one bare
`user_type` comparison** — plus `agent_select_closing_disclosure`, a read with
neither a tenant *nor* an ownership term. A broker at one brokerage could read,
alter and **DELETE** another brokerage's settlement figures; every agent on the
platform could read every closing disclosure. `FOR ALL` is what makes that
include DELETE — USING alone governs it, with no WITH CHECK to stop it (m437).

The correctly-scoped `closing_disclosure_tenant` beside them protected nothing:
**permissive policies OR together**, so adding a good policy next to a bad one
changes nothing at all.

**And that "good" policy carried the NULL escape:**
`(brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())`. It reads
as "untenanted rows are hidden" and means the reverse — an unstamped row satisfies
the first disjunct for **every** caller of **every** tenant, so it is *published
platform-wide*, on all four commands, and anyone could create one.

## The fix inherits the parent's tier rather than authoring a second answer

`closing_disclosure_agreement` is already correctly tiered, so both tables adopt
its predicate. `cda_comparison_results` has **no `brokerage_id` at all** — its
tenant is reached through `cda_id` → the parent, which is exactly what its own
surviving agent policy already did. No column was added to carry a copy of the
parent's tenant; a copied tenant is immediately a second place the truth lives.

All twelve new policies are **per-command**, so the m437 failure mode cannot recur
on these tables by construction.

## A capability restored, not just a predicate deleted

m440 dropped two `title_agent` policies as dead — correctly, since m307 removed
that `user_type`. But the schema turns out to make the title party **mandatory**:
`closing_disclosure.title_agent_id` is **NOT NULL**, with a real FK to `users`.
Discovered while building the fixture, not assumed. So every closing disclosure
has a title party, and dropping the dead predicate without restoring the
capability would have left a required party with no route at all.

It comes back through the column that actually carries it — `title_agent_id =
auth.uid()` — which is **strictly better than what was dropped**: per-row rather
than per-role, so it cannot leak one title company's closing to another's. The
existing `vendor_has_transaction_access()` is reused for the vendor route rather
than reinvented. m443 claim 5 asserts all three preserved capabilities, because
claims 1–4 would pass just as happily if someone deleted every policy.

## Proof — rolled-back live fixture, three tenancies

| principal | reads | |
|---|---|---|
| broker@vip.demo (VIP) | **1** | only VIP's |
| admin@yourbrokerage | **1** | only Your Brokerage's |
| compliance@vip.demo | **1** | only VIP's |
| title@vip.demo (named on B) | **1** | the row naming it — **cross-tenant, per-row** |
| vendor@vip.demo (named on A) | **1** | the row naming it |
| agent@vip.demo | **1** | owns the transaction |
| seller@vip.demo (contact) | **0** | owner ruling |
| lender@vip.demo | **0** | owner ruling |

The **unstamped row reached none of the eight.** Under the old NULL escape it
reached all of them. And:

- VIP broker DELETEs Your Brokerage's settlement record → **0 rows**
- VIP broker CREATEs another unstamped row → **0** (refused)

## The number that matters most in this wave

m443's claims are **scoped to the settlement family on purpose**, and the
measurement is why: the NULL-escape construct is on **464 policies across ~180
tables** right now. That is the true remaining size of #156's tail. A schema-wide
hard claim would have gone red the day it applied, on someone else's table —
which is how a guard gets commented out. So it is HARD where the work was done
and a **counted warning** everywhere else, printed with its number so a green run
is never read as "the class is gone".

The sibling construct — a bare `user_type` policy with no tenant or ownership
term — is nearly closed: **6 policies**, on `contacts`, `cron_health_snapshot`,
`tenant_safety_findings`, `transactions` and `vendor_bookings`. Some are
legitimately platform-scoped tables with no tenant to anchor to, which is a
per-table judgement rather than a sweep.

---

# Wave 41 — leading a team is a fact, not a role

Two owner rulings. **The first one corrects m440**, which this wave shipped
earlier today.

> "a team lead is an agent that runs their own team"
> "the consumer credit data should only be exposed to their lender who is a type
> of vendor"

## m440 gated on a test uncorrelated with the fact it claimed to check

m440 put the team board behind `is_team_lead_role()` — `user_type IN
('team_lead','team_leader')`. W37 then recorded that the ruling was "inert on
live data until `users.user_type` is corrected". **That note was wrong.** There
was nothing to correct in the data; the policy was wrong. Measured live, it was
inverted on both accounts that exist:

| account | `user_type` | teams run | m440's gate |
|---|---|---|---|
| `teamlead@vip.demo` | **agent** | **1** | **FALSE** — the real lead locked out |
| `buyer@yourbrokerage.com` | team_lead | **0** | **TRUE** — runs nothing, let in |

Both halves fail *silently*: an empty board reads as "no deals", and the account
that passed the gate had no team to expose yet. Nothing would have surfaced this
except the ruling.

**Leading is recorded in `teams.team_lead_id` — a real FK.** A role column is a
label; the FK is the fact. `current_user_led_team_id()` reads the fact, and the
two team policies now carry **no role test at all**.

It is deliberately **not** `current_user_team_id()`. That one answers "which team
am I *on*" (lead **or** member **or** agent row) and would hand every
rank-and-file member the whole team's board — the opposite of "teams should only
see their own board". Two questions, two functions; m445 claim 2 stops them being
collapsed.

`can_read_agent_books()` carried the same defect **plus** a second one — it read
`agents.team_id` directly, a fifth answer to a question m431 made single. It
decides the agent tier on **45 money tables**, so a stale copy of the rule there
outranks every policy that calls it.

### Proof

`transactions` is the discriminating table, because an agent sees only their own
deals there — so the team board is the only thing that can widen a lead:

- **`teamlead@vip.demo` (runs team A, owns no deal himself): transactions = 2** —
  team A's two, **not** team B's. Under m440 this was **0**.
- `buyer@yourbrokerage.com` (`user_type='team_lead'`, runs nothing): **0**.

On `listings` the lead reads all 4, and that is now correct rather than a leak:
a team lead **is an agent**, and `agent_read_own_listings` is deliberately
brokerage-wide for MLS/co-op. The team policy adds nothing there and does the
real work on transactions.

## Consumer credit reaches the contact's own lender, and nobody else

`credit_accounts` carried the **NULL escape** on all four commands, so every
contact, lender and vendor account in the brokerage read every contact's
`current_credit_score`, `credit_amount`, stage history and notes — and an
unstamped row was published to every tenant on the platform.

The ruling maps exactly onto the schema as already built — nothing invented:
`vendors.category` admits `'lender'` and `'refinance_lender'`, and
`vendor_has_contact_access()` already resolves the per-contact grant in
`vendor_contact_assignments`. "Their lender" is both halves: **a lender-category
vendor holding a live assignment to that contact.** Drop the category test and
every assigned inspector reads the credit file; drop the assignment test and
every lender reads *every* contact's file — wider than the defect being fixed.
m445 claim 5 asserts both.

**How the ruling was read, stated so it can be corrected:** read strictly, "only
their lender" would also exclude the brokerage's own agents and brokers. It is
not implemented that way, because `app/actions/credit-copilot.ts` is a live
**session-client** surface that states its own tier in a comment — *"An agent sees
only their own book; broker/admin roles see the brokerage."* Cutting the
brokerage out would blank the credit pipeline for the people who run it. So the
ruling was applied to the **outside** parties. If it was meant stricter — the
lender and the named agent only — it is a one-line change.

Deliberately **no platform branch**: `can_read_tenant_financials()` is for a
*tenant's* financials, and a private individual's credit file is not the
brokerage's money. Fail closed, and reported.

| principal | credit files read | |
|---|---|---|
| lender assigned to contact 1 | **1** | only their own contact |
| a vendor who is not a lender | **0** | was 2 |
| a contact | **0** | was 2 |
| the title vendor | **0** | was 2 |
| broker | 2 | the credit pipeline screen still works |
| the agent named on both | 2 | own book |

## The id-class trap, again

`credit_accounts.agent_id` FKs **users**; `contacts.agent_id` holds an
**agents.id**. Both appear in one predicate. Verified in `pg_constraint` before
writing — swap the two comparisons and both branches are false for every row that
will ever exist, granting nothing while reading as though the owning agent can
see the file. Same class as m390 and m441 claim 6.

## Sources repaired, not annotated

`scripts/111` and `rls-governance/004`, `/005`, `/014` carried the old team
predicate in runnable `CREATE POLICY` text — **7 predicates** repointed to
`current_user_led_team_id()`, and the surrounding prose corrected so the comments
no longer describe a rule the SQL beneath them stopped following.

---

# Wave 42 — the deal table

Found by **measuring the outcome of m440 rather than reading a policy**: the
fixture that proved the team board reported, as a side effect, that a **broker
read 0 of 3 transactions in their own brokerage**. That was not the thing under
test, and it was the most broken thing on the table.

Every defect below was then **proved live in a rolled-back fixture before a line
was written**.

## Three defects on one table

**1. Nobody who runs the brokerage could see its deals.** The live SELECT
policies were exactly four — agent (own rows), platform admin, team lead, and a
scoped vendor. No broker, no admin, no tc, no compliance clause.
`rls-governance/004` *declares* all four in words and in `CREATE POLICY` blocks —
but that file has never run here (it depends on the `auth.*` family m440 showed
was never installed). Declared, believed, absent. It fails closed, so it was a
dead screen rather than a leak — but `transactions` is read by a **session
client** from dozens of surfaces, so RLS is the real gate.

The obvious helper, `is_tenant_staff()`, is **wrong** here: it includes `agent`,
which would hand every agent the whole brokerage's deal book. The roster matching
004's declared intent exactly is `can_read_brokerage_books() OR is_tc_role()` —
composed from two existing helpers rather than minted as a third near-duplicate.

**2. A contact could create a deal.** `users_insert_transactions` was `TO PUBLIC`
with a bare tenant test and **no role test**. `users.brokerage_id` is stamped on a
contact exactly as on a broker's. *Proved:* `seller@vip.demo`, `user_type =
'contact'`, created a transaction in VIP Premier.

**3. An agent could move a deal into another brokerage.**
`agent_update_own_transactions` had a USING and **no WITH CHECK**. When WITH CHECK
is absent Postgres reuses USING — and that USING contained **no brokerage term at
all**, so an agent could set `brokerage_id` to any brokerage on the platform and
still pass, because they were still the agent on it. *Proved:* one live deal moved
into Your Brokerage. The deal leaves the brokerage's book entirely, taking its
commission with it.

## Proof

| | before | after |
|---|---|---|
| broker / tc / compliance read own deals | **0** | **2** |
| agent moves a deal to another brokerage | **1 row moved** | **refused** |
| a contact creates a deal | **1 row created** | **refused** |
| other tenant / agent / contact / lender / vendor | — | unchanged |

## The two numbers this wave corrected

m447's hard claims are scoped to `transactions` on purpose, and the measurements
are why:

- **10** UPDATE policies schema-wide have a USING and no WITH CHECK, on 9 tables.
  **6** of them have no tenant term in USING at all — so on six more tables a row
  can still be moved into another tenant.
- **195** INSERT policies reach a tenant with no role or ownership test, across
  195 tables. **#180 records this class as "72". That number is wrong.** The task
  has been corrected, and m447 claim 5 prints the real count on every run so a
  green guard is never read as "the class is gone".
