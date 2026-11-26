# Wave 35 — the ZERO stratum's SELECT half, and a write hole found on the way

#156's nullable half, final stratum: the 15 tables whose SELECT policy carries the
`brokerage_id IS NULL` escape and where **no writer ever stamped**. 17 writer sites
across 12 files.

## The framing I got wrong going in, corrected before anyone wrote code

I opened this wave describing these 15 as **hides rather than leaks** — lower
severity than W34's FOR-ALL half. Reading the live `pg_policy` rows before
dispatching showed that was wrong for half of them:

| stratum | shape | an unstamped row is… | tables |
|---|---|---|---|
| **A** | NULL escape on **all four** commands | readable **and updatable and deletable** by every tenant | budgets, collaborative_searches, compliance_tasks, deposits, financial_reports, plan_tasks, property_views |
| **B** | NULL escape on **SELECT only** | readable by every tenant | ai_usage_log, data_health_logs, email_sends, orchestrator_tasks, saved_calculations, tool_usage_sessions, vendor_communications |

Seven of the fifteen are the same full read+write publication as W34, split across
four policies instead of written as one `FOR ALL`. That is the seventh time this
session the escape turned out to be a leak rather than a hide, and the brief led
with the correction.

**Every SELECT policy on all 15 is granted to `authenticated`** (m417/m418 swept
the old `TO PUBLIC` SELECTs). So the exposure is precisely *every signed-in user
of every other brokerage* — not anonymous. Both the overstatement and the
understatement were available and both would have been wrong.

**An agent corrected me once more mid-wave.** `data_health_scans` is not stratum B:
its UPDATE policy carries `((brokerage_id IS NULL) AND is_lead_visible_role())`,
so an unstamped scan was updatable cross-tenant too. A-shaped on SELECT+UPDATE.

All 15 tables hold **0 rows**, so there is no historical exposure to remediate and
no backfill — only every future write.

## What was actually wrong at the writer sites

Stamping was the assignment; most sites had a second defect underneath it.

**`params.agentId` was the tenant oracle in the money lane.** `budgets`,
`deposits`, `compliance_tasks` and `financial_reports` are all written from a
`"use server"` file whose exports take `agentId` from the caller. Deriving the
brokerage from that id would have let the caller choose which tenant to write
into — the `submitQuizAttempt` defect (W32) on four money tables. The tenant now
comes from `getAgentContext()` only, and the named agent is looked up **scoped by
that brokerage**, so a foreign id finds nothing. `agentId` legitimately stays in
the signature: `DepositTrackerDialog` passes the *transaction's* agent, because a
TC or broker records deposits on a colleague's deal.

**`createPlaybook` has never once created a row.** `plan_tasks.task_description`
is NOT NULL with no default and no trigger, and this writer never set it, so every
call raised a not-null violation into `throw error`. That is why the table is
empty. Its sibling `academy.ts:cloneTemplate` writes the same value to both
`task_description` and `playbook_name`; `createPlaybook` now follows that
convention. Proven live in a rolled-back transaction — old shape refused with the
not-null violation, new shape inserted.

**Four bare inserts were checked for the first time.** `compliance_tasks`,
`orchestrator_tasks` and both `vendor_communications` writes were
`await supabase.from(…).insert({…})` with nothing destructured, inside a
`try/catch`. supabase-js **resolves** a refused write, so the catch caught nothing:
an escrow-delivery obligation, a scheduled-publish queue entry and a delivery
ledger row could each fail silently while the caller reported success. The
`social_posts` UPDATE next to one of them had the same shape in reverse — it
destructured `error`, but a zero-row RLS refusal *is* `error: null`, so it reported
success for a post that never moved. Now `.select("id")` + empty-result check.

**Two public-facing lanes had no gate at all.** `createCollaborativeSearch` and
`trackPropertyView` took a caller-supplied `contactId` — the latter from a
`?contactId=` query param on a page reachable with no session — and had no
authorization of any kind. Both now go through `requireContactAccess`, the shared
portal gate a sibling in each file already used. That closed something bigger than
the row exposure on the property-view side: the same function bumps
`contacts.intent_score`, reading it without destructuring `error` so a refused read
laundered into `intent_score || 0` and wrote 5 back over the real score. A caller
could move any lead's score in any brokerage.

## The write hole nobody was looking for

Asking the catalogue a question I had not asked before — *any INSERT or UPDATE
policy whose predicate is unconditionally true* — returned three tables with an
open **UPDATE**: `long_form_videos`, `marketing_stats`, `transparency_videos`, all
`FOR UPDATE USING (TRUE) WITH CHECK (TRUE) TO PUBLIC` since migration 063.

m413 took `anon` off these tables' SELECT and m414 asserted them off the open
internet — **both only touched SELECT**. Same read-side-only sweep miss as
`commission_splits` in W32.

**My first reading of it was wrong and the empirical check is what caught it.**
`TO PUBLIC` plus a live `anon` UPDATE grant reads as "any anonymous caller can
rewrite every row". Running it proved otherwise:

| role | result |
|---|---|
| `anon` | refused — matches **no** SELECT policy, and Postgres evaluates the SELECT policy to locate the row for an UPDATE carrying a WHERE |
| `authenticated` | **rewrote all three rows** |

So the true exposure was: any signed-in user of any tenant could rewrite every row.
Serious, but a tier below what I first said. m425 gates INSERT and UPDATE on
`is_platform_admin()` — not a new opinion about who owns these tables, but making
the write side agree with the `DELETE` policy each table *already* carried. Safe to
close now: 0 rows, 0 code references anywhere in `app/ lib/ services/ hooks/`.

**Not a deletion.** The tables stay; nothing here rules on whether those features
should be built.

m426 asserts the **construct, schema-wide**: no UPDATE policy in `public` may carry
an unconditional predicate. Deliberately not a list of three table names — the
defect worth preventing is a fourth such policy on a table that does not exist yet.
It also survives legitimate change: a properly tenant-scoped write added later
still passes, because only an *unconditional* predicate fails. Three guards this
session went red on strictly better code by pinning a spelling instead of a shape.
Negative control raised at exactly 3, naming all three.

## Measured, not closed

- **72 tables still carry an unconditional INSERT policy** (`WITH CHECK (true)` to
  `authenticated`). Most draw their real protection from the tenant stamp. Two are
  `TO PUBLIC` and both are deliberate and named: `tool_usage_sessions_insert` (the
  owner-ruled anonymous calculator carve-out, m394 `keep_anon_insert`) and
  `listing_inquiries_insert`. Recorded in m426's header so it cannot be mistaken
  for something this wave handled. → task #180.

- **Act-as writes are refused once a tenant table is stamped.** Proven live against
  `budgets` as the superadmin's uid: stamping their **own** brokerage is allowed,
  stamping **another** is `new row violates row-level security policy`.
  Impersonation is app-level — `getAgentContext()` returns the impersonated
  tenant, but the JWT is still the staff user's, so `current_user_brokerage_id()`
  returns the *staff* brokerage. This is **not new to W35**: it applies to every
  table stamped in waves 21–34 whose policy is the raw
  `(brokerage_id IS NULL) OR (brokerage_id = current_user_brokerage_id())` shape.
  Before stamping, the NULL escape let the write through *and published the row to
  every tenant*; after, it is an honest refusal. Right direction, but it breaks a
  staff support workflow.

  The root cause is a policy defect worth naming: that shape omits the
  `is_platform_admin()` clause `has_brokerage_access()` carries and the rest of the
  schema uses. Since
  `has_brokerage_access(x) == is_platform_admin() OR (x IS NOT NULL AND x = current_user_brokerage_id())`,
  swapping the stratum-A shape to the canonical helper would remove the NULL escape
  **and** restore platform-staff access in one move. → task #181, needs an owner
  call on whether platform staff should read tenant financials at all.

## Reported, deliberately not fixed

Each of these is real, out of the assigned scope, and recorded rather than
half-closed:

- **`lib/kernel/financial.ts:485 loadCommissionQueue` is a cross-tenant money read** —
  service client (RLS bypassed) filtered by a **caller-supplied** `brokerageId`,
  with the resolved context destructured and never used to authorize. Reached from
  a `"use server"` export that takes `brokerageId` as a raw parameter. Any
  authenticated user can read any brokerage's commission queue. **Higher severity
  than anything this wave stamped.**
- `collaborative-search.ts` — every *other* export still takes a caller-supplied
  `searchId`/`memberEmail` with no auth at all; `inviteFamilyMember` sends an email
  on an unauthorized path. A whole-file gating job.
- `idx-search.ts` — `saveProperty` reads `contacts` **by** the caller-supplied id
  and stamps from that row: the same defect on a different table.
- `trackPropertyView` accepts `mlsNumber` and silently discards it; `property_id`
  stays null, so the three listing-keyed readers still count zero views.
- `social-publishing.service.ts:cancelScheduledPost` filters `payload->post_id`
  (single arrow) — jsonb compared against a bare uuid string; should be `->>`.
- `social_posts` is itself a full stratum-A escape table.
- `deposits.created_by` exists and is never set — escrow money with no actor.
- Within-tenant agent forgery persists in the financial lane: a user may still pass
  a colleague's `agentId`. A naive self-check would break the brokerage P&L panel,
  because `getAgentContext()` returns `agentId: null` for every non-`agent`
  user_type.

## Verification

Live `pg_policy` read for all 15 tables before dispatch and per-site by each agent;
`has_brokerage_access` / `is_lead_visible_role` / `portal_member_searches` bodies
read rather than assumed; trigger definitions and `tgenabled` checked on the two
tables that have them. Every live proof ran inside a transaction ended by a `raise`,
so the fixtures roll back by construction — confirmed 0 rows afterwards on every
table touched. m425/m426 applied via `apply_migration` and confirmed in
`supabase_migrations.schema_migrations`; m426's body run as a negative control
before m425.
