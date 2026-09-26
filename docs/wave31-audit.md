# Wave 31 — the census that closed a class, and the half of wave 30 that was in the database

Follow-up to wave 30 and to m413/m414. No new owner ruling; this wave finishes
two things the previous one deliberately left open, and one thing it did not
know it had left open.

## The census (task #171)

m413 narrowed 8 of the 25 `FOR SELECT USING (true) TO PUBLIC` policies — the
ones on tables with **zero readers** — and refused to sweep the remaining 17.
The stated reason was the one that mattered: **a server-side reader on a
logged-out route runs as `anon` too**, so "no browser client" proves nothing.
Sweeping on that assumption is how a public pricing page breaks quietly.

96 call sites across the 17 tables, each resolved to the client it actually
uses and the surface it is reached from. Two surfaces genuinely serve
logged-out visitors, and both were the reason to look:

| surface | table | how it reads |
|---|---|---|
| `/pricing`, `/get-started` | `subscription_tiers` | `loadPublicTiers(svc)` — **every** caller passes `createServiceClient()`, which bypasses RLS entirely |
| `/portal/[contactId]/documents` | `state_compliance_requirements` | cookie client, but `app/portal/[contactId]/layout.tsx` admits nobody without a Supabase auth user (portal clients ARE auth users — the OTP link creates one) and redirects to `/portal/login` |

Everything else resolved to one of two shapes: a `createServiceClient()` read
(crons, kernel, seeders, compliance loaders) or a cookie-client read inside a
server action or `/dashboard` page that has already resolved a session. **Not
one anon-context reader among the 17.**

So m417 sweeps the **construct** and m418 asserts it at **zero** — the stronger
invariant m414 could not yet earn. A policy authored next month with this shape
now fails there rather than six waves later. The escape hatch is named in the
failure message and is not "reopen the policy": serve a genuinely public
surface server-side on the service client, the way `/pricing` already does.

Proved live, two-sided, in one session so the role switch itself is evidence:

| role | plan_limits | subscription_tiers | state_protected_classes | state_compliance_requirements |
|---|---|---|---|---|
| `anon` | 0 | 0 | 0 | 0 |
| `authenticated` | 68 | 4 | 49 | 76 |

A one-sided "anon reads 0" would also be what a broken query looks like. The
`authenticated` row is the control.

### One code change had to land first, and it was a real defect

`platform_settings` was the single table this could have broken, and the way it
would have broken is the point. `lib/ai/cost-tracking.ts:checkPlatformAIEnabled`
read the platform AI kill switch — `emergency_mode`, `ai_enabled` — through
`createClient()`, the **caller's** session, and **fails open**, returning
`{ enabled: true }` on a refused read. Narrowing the policy underneath that code
would have left a live emergency stop silently unenforced for any anon-context
call while the log line scrolled past.

That read is now on the service client, which is what a platform-wide stop
button should always have been: it has no business depending on who is asking.
Fail-open is kept deliberately — a settings outage should not take AI down for
every tenant — but the read now succeeds.

## The half of wave 30 that was in the database (m415/m416)

Wave 30 found that a gate matching a `platform_role` roster against the
`user_type` **column** admits **nobody who should pass**, and fixed it in
TypeScript. The identical inversion was sitting in **13 RLS policies across 12
tables**, spelled `current_user_type() = 'superadmin'` — and
`current_user_type()` is literally `SELECT user_type FROM users WHERE id =
auth.uid()`.

Measured on the live database: **zero** users carry `user_type='superadmin'`.
The one superadmin is `(user_type='admin', platform_role='superadmin')`. Every
one of those 13 predicates was false for every user who has ever signed in.

Two of the 13 were the **whole gate**, so the capability was simply absent:

- **`superadmin_audit_log.sal_superadmin_read`** — the superadmin could not read
  the superadmin audit log. The record of privileged action was unreadable by
  the only role entitled to read it.
- **`state_protected_classes.spc_superadmin_write`** — the superadmin could not
  add or correct a state's fair-housing protected classes. That table feeds
  `lib/compliance-rules/state-fair-housing.ts`; its 49 rows were frozen.

The other 11 were the cross-tenant disjunct on a tenant read
(`brokerage_id = current_user_brokerage_id() OR <this>`). Those fail **closed** —
the superadmin simply saw nothing outside their own brokerage — safe but wrong,
and silently so: an empty table rather than a stated refusal.

The survivor is **`is_platform_admin()`**, already backing 505 policies across
179 tables, and a strict **superset** of what the 13 tried to express: it still
accepts a `user_type='superadmin'` row if one is ever written, and additionally
accepts the spelling the superadmin is actually stored under. Nothing widens
beyond superadmin. This deliberately does **not** reach for m408's
`is_platform_staff()` — the ruling says who the staff are; it does not say a
marketing account may read the superadmin audit log.

m416 asserts the construct at zero **and** that the two whole-gate cases carry
`is_platform_admin()`, because a future edit that *deletes* those policies would
satisfy the first check while losing the capability.

## A silent lie found on the way

`app/actions/workflows.ts:generateScriptContent` ended with a bare
`await supabase.from("scripts").insert(...)` and returned `{ success: true }`.
supabase-js **resolves** a refused write, so the row was never created and the
action said it was. `scripts` is the platform approved-script catalogue: its
INSERT policy is `is_platform_admin()` with no per-author clause, so that write
has been refused for every ordinary agent since the policy was written — which
is why the table holds **zero rows**. The write was doubly dead: it stamps
`status: 'draft'`, and the only reader (`/dashboard/voice`) filters
`status = 'approved'`.

`error` is now destructured and the refusal reported. The generated text is
still returned — it is the useful output — but the caller is told it was not
saved instead of being told it was. Deliberately **not** "fixed" by widening the
policy or switching to the service client: either would let any agent write into
the catalogue the voice console reads from, and this action has no UI caller to
justify it. Whether agent-authored scripts deserve their own author-scoped home
is a product decision, not something to settle from inside a catch block.

## Verification

Typecheck EXIT=0. Guard chain **225/225** across both halves, `test:sweep` run
**last** and actually run (457 proofs, 0 failed). Each assertion migration's
body was run as a negative control **before** its change and raised at the
expected count (m416 → 13, m418 → 17). m415–m418 all confirmed present in
`supabase_migrations.schema_migrations`. Index verified byte-identical to the
working tree before committing.

One measurement was thrown away rather than reported: a direct `anon`-key probe
of the REST endpoint returned 403 on all 17 tables, but the body was
`Host not in allowlist` — the agent proxy refusing, not the database. It proves
nothing about RLS and is not counted as evidence. The in-database role switch
above is the proof.

## Still owner rulings

Unchanged from wave 30, minus `playbooks` (closed in m413/m414):

- **`learning_modules.brokerage_id` is `NOT NULL`**, so a *platform-provided*
  course is structurally impossible — only tenant-owned ones can exist.
- **`commission_splits_insert`** has `is_platform_admin() OR is_brokerage_admin()`
  with **no tenant predicate** — any brokerage admin can insert a commission
  split for any brokerage, including a NULL one.
- `submitQuizAttempt` takes `agentId` from the caller with no auth check.
- Two lockfiles disagree; `pnpm-lock.yaml` is stale.
