# Wave 24 — six tables, and my counts were wrong in both directions

Continues wave 23. Same thesis, established in `docs/wave22-audit.md` W22-4 and
demonstrated in wave 23: a table whose reader filters `.eq("brokerage_id", …)`
cannot see its own untenanted rows, because `NULL = <uuid>` is NULL. These are
**live bugs**, fixed with no migration and no policy change.

Six tables, every one triaged by reading its reader.

## The counts I supplied were wrong in both directions

| table | I said | actual |
|---|---|---|
| `smart_assistant_suggestions` | 3 | **3** ✓ |
| `sequence_step_executions` | 4 | **4** ✓ |
| `open_house_attendees` | 4 | **2** — three writers already stamped `event.brokerage_id` |
| `cron_execution_logs` | 4 | **5** |
| `social_posts` | 3 | **0** — all 22 sites already stamp |
| `system_health_checks` | verify | **0** — one writer, already carrying `service_status.brokerage_id` |

`social_posts` is the instructive one. My "3" came from W22-4's proximity
heuristic, and the reason the wave-23 scanner could not clear it was a **block
bodied row mapper** — `.map(x => { … return {…} })` — which it could not follow.
Verified by hand: `lib/social/orchestrate-social-preset-publish.ts:96` returns
`brokerage_id: args.brokerageId` at depth 1. A correctly-stamped writer reported
as unprovable. That is the third scanner false-red in this sequence, all of the
same family.

**Zero non-internal triggers on all six**, measured. Unlike the wave-21 tables
there is no back-fill net anywhere here; the application stamp is the only
mechanism.

## The defect that was not a missing key

`lib/kernel/cron-logging.ts:createCronRunContext` **accepted `brokerage_id` on
its input type and dropped it on the way to the row.** The input interface has
carried it since it was written and the returned context reports it back — the
insert simply never included it.

So the column `system-health.ts:437` filters on was NULL **for a reason no
caller could change**, and `recordCronSuccess` / `recordCronFailure` then read
`logEntry.brokerage_id || "system"` and emitted every kernel event from that
module under the literal string `"system"`.

No "unstamped writer" census can find this. It is not a missing key — it is a
key that was accepted, documented in the type, and discarded.

## Three deliberate untenanted writes, and what defends them

`contact-enrichment/route.ts:226`, `health-check/route.ts:526` and `:553` each
summarise a run that swept **every** brokerage. Attributing one to a tenant
would file a platform sweep inside a single brokerage's console.

The platform-reader check was run **before** deciding, as wave 23 established:
`pl-truth-engine.ts:236 getCronHealth` and `scraping.ts:1041
loadScrapingDiagnostics` both read this ledger with **no brokerage predicate** —
the `lib/platform/ai-ops.ts:73` property that made wave 23's six defensible.
Proven live: the broker health page sees **1 of 2** and **none** of the sweep
row; both platform readers see **2**.

**Caveat, recorded rather than smoothed:** both readers are gated to
`broker`/`admin`/`superadmin` — a **tenant** role. So cron run history is
already cross-tenant-visible to brokers. That is a pre-existing exposure this
wave did not create and did not widen, but it makes these weaker "platform
surfaces" than `lib/platform/ai-ops.ts`, and the allow-list rests on them.
Worth an owner's eye.

## Beyond the brief

- **`checkInAttendee` has never worked.** It sends no `contact_id`, which is
  `NOT NULL` — proven live, `23502`. Every call has been refused while
  `const { data: attendee }` returned `{ success: true, data: null }`. It has no
  callers today (the UI uses `seller-open-house.ts:checkInAttendee`). Stamped,
  refusal surfaced, and the contact-resolution question **named rather than
  guessed**.
- **`recordVisitor` gained an ownership check** — it now verifies the event
  against the caller's brokerage and refuses on mismatch. A new gate, flagged as
  a behaviour change rather than slipped in.
- **`lib/kernel/open-house.ts:352` stamps the *caller's* brokerage, not the
  event's.** It is stamped, so no census ever saw it — but on a cross-brokerage
  event that is a mismatch. An **authorization** question, not a stamp one.
- **The suggestion writers set no `metadata.contact_id`**, and the contact panel
  reader ANDs on it — so those rows land on `/dashboard/coaching` rather than the
  contact panel. Adding it is a product decision, named not invented.

## The scanner was wrong twice more — one a FALSE GREEN

Both found by controls, not inspection:

1. **Block-bodied row mappers** could not be followed, and the `.insert(rows)`
   initializer bound was cut by the very keywords such a body opens with.
2. **`destructuresError` took the FIRST `const {…} = await` in its window.** In a
   tree that writes no semicolons, an earlier statement could answer for a later
   read — it reported `endOpenHouseEvent`'s attendee read as destructured **when
   it was not**. A false GREEN on the exact property being asserted.

A guard that goes green over the defect it exists to catch is worse than no
guard. That is why every assertion carries a control and every control is
watched go red.

**42 assertions · 46 negative controls red · 5 specificity controls green.**

## Readers repaired

`channel-order-runner` now **fails closed** (`recommended: null`) instead of
publishing an advisory computed over a refusal — and the consequence of its
missing stamps was that the advisory had been computed over an **empty window
for every brokerage**. `endOpenHouseEvent`'s attendee read was treating a
refusal as "nobody came": event closed, nobody scored, no capture events,
success returned.

## Still owner rulings

- **`offer_strategy_templates`** — `FOR SELECT USING (is_active = true)` to
  PUBLIC.
- **`handoff-queue-panel.tsx`'s `agentId` prop** — one caller passes an
  `agents.id`, another a `users.id`, the component uses it as both. Wrong in one
  caller either way; which one is a contract decision.
- **`lib/kernel/open-house.ts:352`** — caller-vs-event brokerage, above.
- **Cron history visible to brokers** — above.
- **Leads / raw-leads**, owner-sequenced.
- **`transcribeAudio`'s unvalidated `audioUrl`**; **calculator rate limiting**.

## Verification

Typecheck EXIT=0. Guard chain **223/223** including `test:sweep`, run after the
last edit, in two halves.
