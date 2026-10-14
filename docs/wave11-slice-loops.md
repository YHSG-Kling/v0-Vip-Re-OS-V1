# Wave 11 — the two loops that reported success while doing nothing

Scope: `L1` (the deal's agent was never notified) and `L2` (the earnest-money
watchdog could not raise a flag, and its dedupe was dead). Both defects in the
brief were **confirmed**, and both grew when the code was re-read. This ledger
records what was confirmed, what was corrected, and what was deliberately left
alone.

Files touched:

- `lib/kernel/notification-engine.ts`
- `lib/compliance/raise-offer-flag.ts` (new — the session-free core)
- `app/actions/buyer-offer/flag-compliance.ts`
- `app/api/cron/em-receipt-watcher/route.ts`
- `scripts/wave11-slice-loops-simulator.ts` (new proof, `npm run test:slice-loops`)
- `package.json` (guard chain), `lib/kernel/manager-registry.ts` (owner)

---

## L1 — CONFIRMED, and it was three branches, not one

`notifications.user_id` FKs `users(id)` and is NULLABLE (verified live against
`pg_constraint` / `information_schema`, project `hrvaqgvukzxfskkcrwbt`). Every
value pushed into `recipients[].user_id` must therefore be a users id.

### The full id-class census of `resolveRecipients`

| # | branch | column read | live FK target | verdict |
|---|--------|-------------|----------------|---------|
| 1 | `contact` / `buyer` / `seller` | `contacts.agent_id` | `agents(id)` | **WRONG — fixed** |
| 2 | `contact` / `buyer` / `seller` | `contacts.tc_user_id` | `users(id)` | correct, untouched |
| 3 | `contact` / `buyer` / `seller` | `contacts.compliance_officer_id` | `users(id)` | correct, untouched |
| 4 | `transaction` | `transactions.agent_id` | `agents(id)` | **WRONG — fixed** (the audited one) |
| 5 | `listing_stage_machine` | `listings.agent_id` | `agents(id)` | **WRONG — fixed** |
| 6 | `listing_stage_machine` → seller channel | `contacts.user_id` | `users(id)` | correct, untouched |
| 7 | brokerage-level pool | `users.id` | — | correct by construction, untouched |

So the audit named one of three instances of the same class. Rows 2, 3, 6 and 7
are stated explicitly as CORRECT rather than left unmentioned — the census is the
deliverable, not just the fix.

Cross-checks: `scripts/agent-fk-columns.ts` lists `contacts`, `listings` and
`transactions` under `agent_id` in the AGENTS-FK snapshot; the live constraint
query agrees; `lib/kernel/event-reactor.ts` already resolves `listings.agent_id`
through the canonical helper before using it as a users id, so branch 5 was
inconsistent with its own sibling in the same directory.

### What was actually broken, end to end

1. The three branches wrote an `agents.id` into a `users` FK → the insert was
   **foreign-key rejected**.
2. `await supabase.from("notifications").insert(...)` was wrapped in `try/catch`
   with **no `error` destructure**. supabase-js *resolves* a rejected write, so
   the `catch` never fired and the next line printed
   `Created notification for user …`. The failure had no surface anywhere.

### The fix

- One private helper, `pushResolvedAgentRecipient`, routes every agents-class
  column through the **existing** `lib/kernel/agent-identity-resolver.ts:
  resolveAgentRecordToUserId`. No second resolver was written.
- An agents row with no `user_id` yields **no recipient** and logs why. There is
  no `??` fallback — a fallback across that boundary just writes a different
  wrong id.
- The insert destructures `error`; the success log is unreachable for a rejected
  write; the failed branch `continue`s.
- Every read in the resolver (`contacts`, `transactions`, `listings`, the
  brokerage pool) now destructures `error`, so "refused" and "no rows" stop
  looking identical.

### The import that broke an unrelated proof (caught, not shipped)

The first version imported `resolveAgentRecordToUserId` **statically**. That is
the obvious shape and it is wrong here: the resolver carries
`import "server-only"`, and `lib/kernel/lifecycle.ts` imports
`notification-engine.ts` statically, so the static edge made the whole lifecycle
chain unloadable outside a react-server condition. `npm run test:parties-notify`
— already on the guard chain — went from green to a hard
`This module cannot be imported from a Client Component module` crash. The
resolver is now loaded at call time, the same idiom this file already uses for
the reactor and `lib/kernel/event-reactor.ts` uses for this exact column.
`test:client-server-only` (which follows dynamic edges too) stays green.

### The thing that would have blocked every deal

The obvious tidy-up here is to **throw** on a failed notification insert.
`processKernelEvent` is on the emit path of every lifecycle action in the
product (~79 direct callers plus `fanOutKernelEvent`), and the module header
promises only that *resolveRecipients* failures are caught by the caller. A
throw on the notification write would turn an undeliverable bell into a failed
offer, transaction or listing write for the human who triggered it. It is
logged, never rethrown, and the proof asserts that the branch contains no
`throw` (`L1.a-failed-bell-never-fails-the-deal`).

---

## L2 — CONFIRMED on both halves, plus a third defect the fix itself exposed

### Half 1 — the cron could not raise a flag

`app/api/cron/em-receipt-watcher/route.ts` holds a service credential and no
cookies, and called `flagOfferCompliance`, whose first act is
`auth.getUser()` → `Unauthorized`. Every iteration failed. The return value was
never inspected and `flagged++` ran anyway, so the run **reported flags it had
not raised**.

### Half 2 — the dedupe could not match

It filtered `notes ilike '%<offerId>%em_receipt_missing%'`. The writer stores
`JSON.stringify({ offer_id, flagType, severity, … })`; `em_receipt_missing` is
emitted nowhere in the tree. Proven, not asserted: the proof drives the **real**
`recordOfferComplianceFlag` and reads the row back
(`L2.behaviour.the-legacy-predicate-matched-nothing`).

### Half 3 — CORRECTION the brief did not contain

Keying the dedupe on `metadata.flag_key` is right, but `complianceFlagKey` is a
function of `flagType + title`, and the watcher's title was

```
Earnest money receipt missing (3 days past contract deadline)
```

That string changes **every night**, so the key would change every night:
`recordOfferComplianceFlag` would have minted a new open flag per run instead of
refreshing one — re-creating the duplicate stacking wave 9 removed, only now
driven by a cron. The title is now the stable subject
(`emReceiptFlagSubject()`), and the day count moved into the body.

### The session-free extraction

New module: **`lib/compliance/raise-offer-flag.ts`**.

*Why that path.* `lib/compliance/offer-flag-resolution.ts` already owns the flag
row's whole lifecycle — the raise (`recordOfferComplianceFlag`), the close
(`resolveOfferComplianceFlags`) and the identity that ties them together
(`complianceFlagKey`). A raise core anywhere else would be a fourth module with
an opinion about what a flag is. It sits beside its sibling, imports the
identity rather than re-deriving it, and is **not** a `"use server"` file.

*Shape.* Exactly `lib/buyer-offer/expire-offers.ts`: the core takes a client and
does the work; the session action and the unattended sweep are two doors into
one implementation.

- `app/actions/buyer-offer/flag-compliance.ts` keeps **only** what it alone can
  do — the cookie-session gate and the caller's tenant — then calls the core.
  The gate is unchanged and takes no bypass parameter. The caller's brokerage
  travels as an *assertion* (`requireBrokerageId`), not as the tenant: the core
  still reads `offers.brokerage_id` off the row and refuses on mismatch.
- The cron calls the core directly with the service client and never reads a
  tenant from the request.

*Deleted from `flag-compliance.ts`*: the inline `agents → user_id` lookup that
resolved the bell target. **Survivor:
`lib/kernel/agent-identity-resolver.ts:resolveAgentRecordToUserId`**, which the
core calls. Nothing was lost — the copy did the same single-column lookup and
yielded null the same way.

### The unattended actor

`activities.agent_user_id` FKs `users(id)`, so "the system" cannot be a literal.
`resolveUnattendedRaiserUserId` resolves, in order: the brokerage's provisioned
system actor (`lib/auth/isa-actor.ts`, whose own docblock settles this fallback
rule), then the offer's agent, then a brokerage principal (roles expanded
through `rawRoleVariantsFor`, because a hand-spelled `user_type` filter that
matches zero rows is a *successful* query — the exact mistake that once cost
every TC their compliance notifications). If none resolve, the offer is
**skipped with a recorded reason** in the response. The old code's silent
`continue` on that path is gone.

### The dedupe key chosen

`metadata->>flag_key eq complianceFlagKey(emReceiptFlagSubject())`, scoped by
`brokerage_id + entity_type='offer' + entity_id + activity_type`, with the last
raise read from what the writer stamps: `metadata.last_reflagged_at ??
metadata.raised_at ?? created_at`.

- **Not** status-filtered: a flag a TC resolved two hours ago still means the
  humans have heard about this miss today.
- **On a refused read** it returns `raisedWithinWindow: false` *with* an error,
  and the cron raises anyway and reports the warning. Same ruling
  `recordOfferComplianceFlag` already made for its own lookup, and safe for the
  same reason: the writer upserts on the key, so the worst case is one duplicate
  *notification*, while the other direction is a missed money deadline.

### Other corrections made in the same pass

- `.or("contact_id.eq.${offer.contact_id},…")` built a malformed filter when
  `contact_id` was null. The or-clause is now assembled from the keys the offer
  actually has.
- The receipt-count read never destructured `error`; a refused query returns
  `count: null`, which `(count ?? 0) > 0` reads as "no receipt on file" — i.e. it
  would have flagged on an unreadable ledger. It now skips with a reason.
- The route returns `skipped[]` and `warnings[]`, so a run that flags nothing
  says *why* for every offer instead of returning a bare `flagged: 0`.
- A flag that reached **no** recipient is reported as a warning rather than
  counted as delivered.

---

## Proof — `npm run test:slice-loops`

`scripts/wave11-slice-loops-simulator.ts`. 17 assertions, 14 negative controls.
Registered in the `guard` chain and owned by `compliance_officer` via
`MAINTENANCE_DOMAINS.unattended_compliance_flag_lane`.

Assertions are on CONSTRUCTS, not spellings:

- "no expression whose column is `agent_id` is written to a `user_id` field" —
  derived by scanning every `user_id:` value and taking its terminal property.
- "every `*.agent_id` read is an argument to a call that reaches the canonical
  resolver" — the set of resolving functions is computed from each declared
  function's own body, so renaming the helper does not change the answer.
- "no import of the cron resolves to a `use server` module" — every specifier is
  resolved on disk and its leading directive read. It asks the class, not the
  name.
- "the guard on the insert's error precedes the success log" — by index, using
  the destructured identifier's actual name.
- "every `continue` in the sweep is immediately preceded by a recorded reason" —
  the first version of this used a 500-character lookback and **did not flip**
  under its own negative control, so it was hardened to require the immediately
  preceding statement. Stated here because a control that stays green means the
  assertion was worthless.

Negative controls rewrite the defect into the real file, verify the mutation
applied (a find-string that no longer matches is theatre), require the check to
go RED, restore, and verify the restore by sha256. All 14 flip.

Behaviour assertions drive the real modules through an injected stub client.
tsx compiles to CJS here, so a mutated module cannot be re-imported in-process;
those six are controlled by **discrimination** instead — each pairs the positive
with the cases that must NOT match (another offer, another miss, another tenant,
outside the window, a refused read), so an always-true implementation fails
them. This is stated in the proof itself rather than dressed up as a source
control.

---

## Deliberately NOT done

- `recordOfferComplianceFlag`'s signature was left alone (out of scope, and
  widening `raiserUserId` to nullable would let a tenant-less raise through).
- The EM flag still files under the `missing_form` bucket. Adding an
  `em_receipt_missing` taxonomy value would change a shared vocabulary the
  packet analyzer and the settings picker both read; the body says what it is.
- `notification_rules.recipient_role` casing (`'TC'`) is the *rule* vocabulary,
  not `users.user_type`, and is internally consistent in that file. Untouched.
- Duplicate recipients (an agent who is also `team_lead` appears twice) is
  pre-existing and orthogonal to the id-class defect.
