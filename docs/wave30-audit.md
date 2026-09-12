# Wave 30 — the gate was inverted, and a quiz answer key was on the open internet

Owner rulings:

> "the platform roles are the staff including superadmin, admin, support,
> marketing. the tenants will also have their own kb, courses, training
> material, onboarding, support tickets but all will be under their own
> brokerageid."

I researched both before dispatching and **got the shape of both wrong**. The
corrections are the substance of this document.

## Ruling 1 — six rosters, and the survivor was not the one I named

I briefed four disagreeing definitions of "platform staff". There were **six**:

| source | roster |
|---|---|
| DB `CHECK` on `users.platform_role` | superadmin, admin, marketing, support ✅ |
| `isPlatformStaffIdentity()` | the same four ✅ |
| `PLATFORM_STAFF_ROLES` — six lines above it, same file | superadmin, support |
| `is_platform_admin()` (RLS) | superadmin |
| `requirePlatformStaffAuth` in `lib/kernel/api-auth.ts` | hard-coded superadmin, support |
| the staff action's PostgREST filter | `user_type.in.(superadmin,support)` |

**The survivor is `lib/platform/platform-staff-roster.ts`** — which already held
the correct four, under a header comment insisting there were two. I had named a
file in `lib/auth/` instead. My caller list was 4 files / 5 sites; the real
figure was **11 sites across 10 files**.

### The defect was inversion, not narrowness

I predicted `vendor-budget.ts` "admits only `userType === 'superadmin'`, because
`support` and `marketing` are not user_types." Every clause of that was wrong in
a way that mattered:

- **`support` IS a legal `user_type`** (14 values in `users_user_type_check`). So
  the gate **leaked**: any *tenant* user whose `user_type` happened to be
  `support` received the full vendor-name-and-dollar breakdown that file exists
  to redact.
- **`marketing` is genuinely not a `user_type`** — staff are written as
  `user_type='system'` — so it was permanently excluded.
- **The live superadmin is `(user_type='admin', platform_role='superadmin')`.**
  The gate matched a `platform_role` roster against the `user_type` **column**,
  so it admitted **nobody who should pass** while admitting people who should
  not. Not a narrow gate. An inverted one.

The same inversion sat in three more places nobody had flagged: a
superadmin-only budget toggle **unreachable by the superadmin**;
`requireSuperadminAuth`, guarding billing / entitlements / subscriptions,
**refusing the superadmin**; and `resolvePlatformStaffIds`, which imported the
2-role duplicate — so **every platform alert ever raised** (connector health,
scraper failures, raw-lead ingestion) reached 2 of 4 staff roles and reported
success. Measured: 2 of 5 recipients notified → 4 of 5.

### `is_platform_admin()` deliberately did not move

This was the scoping decision of the wave. That helper backs **505 policies
across 179 tables** — commission, financial, PII. Widening it to four roles
would hand a marketing account superadmin-equivalent database access
schema-wide. The ruling says who the staff *are*; it does not say a marketing
user may delete a commission row.

So `is_platform_staff()` (m408) is a **new** helper carrying the four roles, used
on the platform **catalogue** write side only. Verified after: admin footprint
still 505, definition byte-identical; staff footprint 22 across exactly the seven
content tables; `service_status` and `api_response_logs` at zero.

Two deliberate deviations from my brief, both right:

- **`service_status` and `api_response_logs` excluded.** Machine telemetry whose
  only writer is a service-client cron — widening grants no human workflow
  anything, while letting a marketing account forge or clear a platform outage.
  m409 **pins** both exclusions so a later copy-paste cannot "finish the
  pattern."
- **`support_tickets` moved its SELECT too.** Postgres evaluates the SELECT
  policy for any UPDATE or DELETE carrying a WHERE clause, so a write-side-only
  swap would have been **inert**.

## Ruling 2 — the tenant half had never been exercised, and it showed

Every one of these tables is 100% platform rows, so the tenant-owned path had
never run. Two real defects:

**A quiz answer key served to the open internet.** `onboarding_quizzes.oq_select`
was `USING (true)` to PUBLIC and never referenced its parent step. Proven live
with a fixture — a quiz owned by tenant A holding `"TENANT-A-SECRET"`:

| caller | sees A's step | sees A's **quiz** |
|---|---|---|
| tenant B admin | 0 | **1 — "TENANT-A-SECRET"** |
| `anon`, no session | — | **1 — "TENANT-A-SECRET"** |

The parent was correctly hidden; the child was not. The 8 live rows are the
platform answer key. Fixed in m411 and independently re-checked: **anon reads 0**.

**A tenant could never author a quiz for its own step** — writes were
`is_platform_admin()` only, so a brokerage admin got "new row violates row-level
security policy" on a step it had just created and owned.

`support_ticket_messages` INSERT was default-denied. Not user-visible, because
every writer is the *service* client — but that means application code was the
only barrier between tenants, which is not where a tenancy boundary belongs.

### A user-facing bug found on the way

The tenant onboarding authoring surface **refused valid saves**. The category
dropdown offered seven options while the live CHECK admits five different ones —
four of seven rejected with 23514 — and the blank form defaulted Order to `0`
where the CHECK requires ≥ 1. So **the first save of a freshly-opened create
form always failed**, whatever the user picked. One vocabulary module now,
following the `help-topic-categories.ts` precedent.

## The orphan guard did its job, and the answer was not to work around it

`test:orphan-exports` went red: *"CAPABILITY REMOVED —
`lib/auth/resolve-user-role.ts:isPlatformStaff` exists NOWHERE in the tree."* It
refuses a deletion until the survivor is **named**.

It is `lib/platform/platform-staff-roster.ts:isPlatformStaffRole` — the correct
four roles plus a `platformStaffCan` capability matrix the deleted one never had,
with `isPlatformStaffIdentity` now delegating to it. Functionality was **widened,
not lost**, so the baseline was re-set deliberately.

### A guard I turned red by improving the code

The onboarding-steps simulator asserted the literal string
`CATEGORIES.has(input.category)` — pinning one function name in one file. Moving
the vocabulary into a shared module made it fail on strictly better code.

Rewritten to assert the **construct**: that `input.category` is validated against
the shared source before reaching the insert. Plus a **new** assertion that the
picker imports the same module — which is the invariant that actually prevents
the drift, and which nothing was checking. Three negative controls, each verified
*applied* before its result was believed, each red for its own reason, files
restored byte-identical.

## Verification

Typecheck EXIT=0. Guard chain **225/225** in two halves, `test:sweep` last and
actually run (457 proofs). m408, m409, m411, m412 all confirmed present in
`supabase_migrations.schema_migrations`. Index verified byte-identical to the
working tree before committing.

## Still owner rulings

- **`learning_modules.brokerage_id` is `NOT NULL`**, so a *platform-provided*
  course is structurally impossible — only tenant-owned ones can exist. The
  ruling says tenants will "also" have their own, implying platform ones exist.
  They cannot. Changing that means dropping the constraint, reworking two
  policies, the `learning_assignments` FK and every reader.
- **`commission_splits_insert`** has `is_platform_admin() OR is_brokerage_admin()`
  with **no tenant predicate** — any brokerage admin can insert a commission
  split for any brokerage, including a NULL one. Pre-existing, found while
  proving this wave's fixtures.
- **`playbooks`, 8 rows, readable by `anon`** — the wave-28 ruling applied to
  `offer_strategy_templates` but never to the table of that name. It belongs to a
  class none of my sweeps covered: `FOR SELECT USING(true)` to PUBLIC, 25
  policies. None of those tables carries a `brokerage_id`, so it is
  world-readable *platform* data rather than cross-tenant leakage, and 22 of the
  25 are empty or are pricing tables.
- `submitQuizAttempt` takes `agentId` from the caller with no auth check — RLS is
  now the correct guard, but the missing gate remains.
- Two lockfiles disagree; `pnpm-lock.yaml` is stale.
