# Wave 9 — slice D2: the compliance loop closes

The owner's ruling, which governs everything below:

> the audit gate is when the offer is accepted and all paperwork is submitted to
> compliance to be sure all documents for the transaction are all present and all
> signatures/initials are complete on both sides. if all are present, then a
> transaction is created, if not, then the missing piece is sent to the tc and
> agent to get it finished and resubmitted for approval.

Step 4 was half built: the resubmit worked, the approval left no trace.

---

## 1. What I CONFIRMED in the brief

**The defect is real and as described.** `app/actions/buyer-offer/flag-compliance.ts`
inserted every flag with `status: "open"`, and a grep of `app/`, `lib/`, `hooks/`,
`services/` and `scripts/` for any write that moves a `buyer.offer.compliance.flagged`
activity off `'open'` returned **nothing**. There was no `resolveComplianceFlag`, no
status update, no re-open. The three consequences the brief lists all follow
mechanically.

**The queue surface reads `status='open'`** —
`app/actions/compliance/dashboard.ts:86` (pre-change line number). Because nothing
could ever close a flag, that filter was decorative: "open flags" meant "every flag
ever raised in the last 30 days".

---

## 2. What I CORRECTED

### 2a. There are TWO compliance-flag ledgers, and one of them already closes

The brief says "NOTHING ever resolves, closes or re-opens one". That is true of
**this** lane and only this lane. `compliance_flags` (the TABLE) is a different
ledger — the Fair-Housing / consent / content-moderation queue — and it already has:

* a lifecycle: `status CHECK = flagged | reviewed | resolved | overridden`
  (`lib/compliance/compliance-flag-policy.ts:9`);
* an SLA reaper: `lib/compliance/compliance-flag-reaper.ts:reapStuckComplianceFlags`;
* a human resolution endpoint: `app/api/compliance/flags/route.ts` `PATCH`, which
  writes `status`, `resolution_notes` and `resolved_at`, role-gated to
  broker/admin/superadmin/compliance_officer.

The buyer-offer audit-gate flag is **not** a `compliance_flags` row. It is an
`activities` row keyed `entity_type='offer'` + `entity_id=<offers.id>` +
`activity_type='buyer.offer.compliance.flagged'`. That lane had no lifecycle at all.

This matters for the fix: I did **not** merge the two. They are not duplicates —
they are different subject matter (deal paperwork vs. content moderation), different
tables, different readers, different SLAs. The precedent from the `compliance_flags`
PATCH endpoint (a role-gated human "mark resolved") is what I copied in shape, not
in code.

### 2b. `app/api/cron/em-receipt-watcher/route.ts` cannot raise a flag at all

Not part of D2, but found while reading the callers, and it invalidates the brief's
implicit assumption that all three callers currently produce rows:

`flagOfferCompliance` opens with a **session** auth gate:

```ts
const authClient = await createClient()                 // cookie-based
const { data: { user: authUser } } = await authClient.auth.getUser()
if (!authUser) return { success: false, error: "Unauthorized" }
```

A cron GET has no session cookie, so `authUser` is `null` and the watcher's call at
`route.ts:96` returns `Unauthorized` on **every** iteration. The EM-receipt watcher
has never raised a flag since that auth gate landed.

Its 48-hour dedupe is dead for a second, independent reason:

```ts
.filter("notes", "ilike", `%${offer.id}%em_receipt_missing%`)
```

`flagOfferCompliance` writes `notes` as JSON containing
`flagType: "missing_form"` — the string `em_receipt_missing` never appears in it, so
that `ilike` matches zero rows regardless.

**I did not fix either.** The route is outside my file scope, and the auth fix is a
design decision (a system-actor path for cron on a `"use server"` RPC endpoint) that
should be ruled on rather than smuggled in. Recommended fix, for whoever takes it:
give the watcher a service-client path that calls
`lib/compliance/offer-flag-resolution.ts:recordOfferComplianceFlag` directly (it takes
an injectable client and does no auth), then delete the dead `ilike` dedupe — my
`flag_key` dedupe replaces it. Note the watcher's title embeds the overdue **day
count**, so its subject changes daily; it should pass a stable title and put the day
count in `body`, or the key-based dedupe will not bind for it either.

### 2c. The queue's "Open offer" deep link was dead for flags

`app/actions/compliance/dashboard.ts` hardcoded `contact_id: null` on every
`kind:'flag'` item while the page rendered
``href={`/crm/contacts/${item.contact_id ?? ""}/offers/${item.offer_id}`}`` — i.e.
`/crm/contacts//offers/<id>`, a 404. `activities.contact_id` was populated all along
(flag-compliance copies it from the offer row); the reader just never selected it.
Fixed on both surfaces, and the link is now omitted rather than rendered broken when
either segment is missing.

---

## 3. The resolution anchor, and the evidence for it

**FLAG KEY = `normalize(flagType) :: "title:" normalize(title)`**, scoped by
`(brokerage_id, entity_type='offer', entity_id, activity_type, status='open')`.
Normalization is lowercase + whitespace-collapse + trim. **Digits are never stripped.**

Every candidate anchor the brief named was read and rejected on evidence:

| candidate | why it is not the anchor |
|---|---|
| `entity_id` | the OFFER. Every miss on one deal shares it — resolving by it closes unrelated flags. |
| `flagType` | six buckets. `analyzeFilledPacket` emits one `missing_signature` blocker **per unfilled signature field**, so one packet yields many flags of one type. |
| `documentId` | **the trap.** `scanOfferPacketCompleteness` finds the staged doc with `.order("created_at",{ascending:false}).limit(1)` — the *newest*. A resubmission that re-stages the packet gets a **different** `documents.id` for the **same** miss, so keying on it mints a fresh flag every attempt. That is the duplicate stacking, not a fix for it. Excluded deliberately; negative control NC-2 below proves the exclusion is load-bearing. |
| `title` | **this is the anchor.** |

Why `title` is a real identity and not a spelling accident — `lib/workflow/intelligence/packet-analysis.ts:analyzeFilledPacket`
produces exactly three title shapes, each a deterministic function of the miss's own
identity:

* `` `Form missing: ${formName}` `` → unique per form
* `` `Field missing on ${formName}: ${fieldName}` `` → unique per form+field
* `` `Signature block missing on ${formName}` `` / `` `Initial block missing on ${formName}` ``
  → unique per **form**, and deliberately so: two unfilled signature fields on one
  form are ONE piece of work for the TC ("this form is not signed"), and the flag
  must stay open until *no* signature is missing on it. Collapsing them is correct.

`formName` / `fieldName` are carried on `PacketScanFinding` but are **dropped** at the
`flagOfferCompliance` boundary (`scan-offer-packet.ts:204-212` passes only
flagType/severity/title/body/documentId). Keying on them would have required editing
`scan-offer-packet.ts`, which the other agent owns — and would have been *worse*,
because it would have split the per-form signature collapse above into per-field
flags. Title-keying needs no cross-slice wiring and is semantically right.

### `source` — derived, never passed

A reconciling caller may only retire flags **it** produced; a packet scan must never
auto-close the ad-hoc flag a human typed. All three live callers were read to settle
the discriminator:

* `lib/workflow/intelligence/scan-offer-packet.ts:211` — passes `documentId: doc.id` on
  **every** dispatch (blockers and the collapsed warning summary). Its four
  fail-closed exits return before the dispatch loop, so they raise no rows.
* `app/components/offer/offer-agent-actions.tsx:82` — no `documentId`.
* `app/api/cron/em-receipt-watcher/route.ts:96` — no `documentId`.

So `documentId != null ⇔ packet_scan`. `complianceFlagSource()` is **module-private**
on purpose: every export of a `"use server"` module is an RPC endpoint, and a
caller-supplied source would let anyone tag their own manual flag as scanner-owned so
the next scan silently retired it.

**Coupling to declare:** this derivation depends on `scan-offer-packet.ts` continuing
to pass `documentId`. Verified against the other agent's current version of that file
at the time of writing.

---

## 4. The duplicate-stacking decision: UPDATE the survivor

**Chosen: update the existing open flag in place. Do not insert a second row, and do
not merely refuse the insert.**

Evidence for update over refusal:

1. A refusal would freeze the **first** attempt's wording forever, while the scanner's
   `body` carries the current reason a field is unfilled (`uf.reason ?? "not provided
   in intake"`). The TC would read stale remediation text.
2. `reflag_count` / `last_reflagged_at` on the survivor is the **only** place the
   system records that a miss has now outlived N resubmissions — exactly the
   accountability the owner's "get it finished and resubmitted" step needs. A refusal
   discards that observation entirely. The queue surfaces it as
   *"survived N resubmissions"*.
3. Both options keep the queue count honest (one row per miss), so the audit value in
   (2) is the tie-break.

Two further decisions inside the same call:

* **Self-healing.** If earlier resubmissions already stacked duplicates, the
  **oldest** row is the survivor (it is the row the queue has been showing, and its
  `created_at` is the true age of the outstanding work) and the rest are collapsed to
  `resolved` with a reason naming the survivor's id. The stacking already in the
  database therefore drains on the next raise instead of being permanent.
* **The notification fan-out is deliberately NOT deduped.** A failed resubmission is a
  new event for the humans even when the miss is old — the owner's rule is that the
  missing piece goes to the TC and the agent *every time it blocks*. Only the audit
  ROW is deduped.

**Recurrence after resolution mints a NEW flag** rather than re-opening the resolved
row: the earlier resolution (who, when, why) is the record of a fix that really
happened, and overwriting it would erase it. Dedupe matches `status='open'` only.

---

## 5. THE WIRING YOU MUST DO — `app/actions/buyer-offer/submit-to-compliance.ts`

I did not touch that file. Two call sites; the first is the required one.

Add the import at the top, next to the other `lib/compliance` import:

```ts
import { resolveOfferComplianceFlags } from "@/lib/compliance/offer-flag-resolution"
```

### 5a. REQUIRED — the passing gate clears the outstanding set

Insert immediately **before** `return { success: true, transaction_id: result.transactionId }`
(currently `submit-to-compliance.ts:477`, inside the `try` after the
`if (!result?.success || !result.transactionId)` guard):

```ts
    // THE LOOP CLOSES. Compliance has just verified every required document is
    // present and every signature/initial complete on both sides, so nothing
    // outstanding on this offer can still be true. Sweep the flag ledger and
    // record WHO cleared it and WHEN.
    //
    // AFTER the transaction, not before: the owner's ruling is "if all are
    // present, then a transaction is created", so a flag-ledger fault must never
    // withhold the transaction. It must also never be swallowed — the queue
    // would then show work that no longer exists.
    const cleared = await resolveOfferComplianceFlags({
      offerId,
      brokerageId: offer.brokerage_id as string,
      actorUserId: userId,
      reason: `Compliance gate passed on ${now} — all required documents present, all signatures and initials complete on both sides. Transaction ${result.transactionId} created.`,
    })
    if (!cleared.success) {
      console.error(`[submit-to-compliance] offer ${offerId}: transaction ${result.transactionId} was created but the compliance flag ledger was not cleared:`, cleared.error)
    }

    return { success: true, transaction_id: result.transactionId }
```

Argument notes:
* `brokerageId` — from the OFFER row (`offer.brokerage_id`), never from a caller.
  Required: the resolver is a service-client write with RLS bypassed and must carry
  its own tenant scope.
* `actorUserId` — `userId`, the users-class id already validated at the top of the
  action. It is written to `activities.agent_user_id`; it is **never** crossed into
  `activities.agent_id`, which FKs `agents(id)`.
* `now` — the ISO timestamp already in scope at that point.
* No `flagKeys` / `retainKeys` / `sources` — omitting all three is the SWEEP mode,
  which is what a passing gate means.

If you want the outcome in the return type, add
`compliance_flags_cleared?: number` to `SubmitToComplianceResult` and set it from
`cleared.resolved_count`. I left the surface alone because I do not own the file.

### 5b. OPTIONAL — the blocked resubmission retires what was fixed

Insert inside the `if (hasBlockingMissing || hasPacketBlockers || !packetScanRan)`
branch (currently opening at `submit-to-compliance.ts:199`), **after** the
`notifyComplianceFlag` call and **before** the `return { success: false, … }`:

```ts
    // The scan just recomputed what is STILL missing. Any packet-scan flag on
    // this offer that is not in that set names a piece that has since been
    // supplied — retire it, so the queue shrinks as the TC works instead of only
    // ever growing. `sources` is what keeps this from auto-closing the ad-hoc
    // flag a human typed into the offer toolbar.
    if (packetScanRan) {
      const stillOutstanding = packetScan.blockers.map(b =>
        complianceFlagKey({ flagType: b.flagType, title: b.title }))
      const retired = await resolveOfferComplianceFlags({
        offerId,
        brokerageId: offer.brokerage_id as string,
        actorUserId: userId,
        reason: "Resubmission scan no longer reports this miss — the piece was supplied.",
        retainKeys: stillOutstanding,
        sources:    ["packet_scan"],
      })
      if (!retired.success) {
        console.error(`[submit-to-compliance] offer ${offerId}: could not retire fixed packet flags:`, retired.error)
      }
    }
```

This one needs a second import:

```ts
import { complianceFlagKey } from "@/lib/compliance/offer-flag-resolution"
```

Guard it on `packetScanRan`: when the scan could not run, `packetScan.blockers`
carries the synthetic could-not-run blocker rather than a real outstanding set, and
reconciling against it would retire every genuine miss. `"packet_scan"` is the value
of the exported `FLAG_SOURCE_PACKET_SCAN` const — import it instead of the literal if
you prefer.

---

## 6. Files in this slice

| file | what changed |
|---|---|
| `lib/compliance/offer-flag-resolution.ts` | **NEW.** Owns the flag row's whole lifecycle: the pure key, the de-duplicating writer `recordOfferComplianceFlag`, and the resolver `resolveOfferComplianceFlags`. |
| `app/actions/buyer-offer/flag-compliance.ts` | Keeps auth, tenant + agent resolution off the offer row, and the notification fan-out. The row write is delegated to the module above, so raise and resolve can never disagree about what identifies a miss. Returns `flag_key` + `deduped`. |
| `app/actions/compliance/dashboard.ts` | Surface data layer. Read errors now fail closed instead of rendering as an empty queue; items carry `flag_key`, `reflag_count` and a real `contact_id`; a `recently_cleared` list reports who cleared what and when; new `resolveComplianceFlagAction` (role- and tenant-gated). |
| `app/dashboard/compliance/queue/page.tsx` | The Compliance queue. New "Cleared (7 days)" tile and a "Recently cleared" card; a "survived N resubmissions" badge; a genuine failed-read state; dead deep links removed. |
| `app/dashboard/compliance/queue/flag-row-actions.tsx` | **NEW** client component — the "Mark satisfied" control, with real pending/error/already-closed states. |
| `scripts/offer-flag-loop-simulator.ts` | **NEW** proof, registered as `test:offer-flag-loop` in the `guard` chain. |
| `package.json` | Registers the proof. |

### Why `lib/compliance/`

`lib/compliance/` already holds the compliance-flag SLA policy
(`compliance-flag-policy.ts`), its reaper, and `required-documents.ts` — the *other*
half of this same audit gate. `lib/buyer-offer/` was the alternative, but
`lib/buyer-offer/compliance-gate.ts` is a `"use server"` module, and this one must
export sync helpers (`complianceFlagKey`) and consts, which a `"use server"` file may
not. It also follows the directory's established pure/impure split.

### No new page

The brief's "do NOT build a new page" is honoured. `/dashboard/compliance/queue` is
the only surface in the tree that reads `buyer.offer.compliance.flagged` (verified by
grep); the Compliance Command Center at `/dashboard/compliance` reads the
`compliance_flags` TABLE and the `content.approval` lane, neither of which is this
ledger, so it was left alone.

### Why the "Mark satisfied" control is not a gate bypass

`submitOfferToCompliance` recomputes the required-documents audit and the packet scan
from scratch on **every** attempt and never reads this ledger. The flags are the WORK
QUEUE the owner's step 4 describes, not the gate's evidence. A flag cleared without
the fix simply comes back on the next submit.

---

## 7. Proof and negative controls

`npm run test:offer-flag-loop` — 55 assertions, all on the **construct** (keys
compared to each other, rows counted by status, actors read back off the row); no
assertion compares a literal key string, title or activity_type. The real module is
driven through an injected supabase-shaped stub, so the whole thing runs without
credentials and "the query returned nothing" is never mistaken for health. A live
creds-gated layer (seed → sweep → assert → idempotent → cleanup count == 0) is present
and skips here.

Every negative control below reintroduced the defect, was confirmed RED, was restored,
and was confirmed GREEN again (55/0).

| # | bug reintroduced | result |
|---|---|---|
| NC-1 | the original defect — `survivor` forced undefined so every raise inserts | **9 red** (`resubmission … does not mint a second flag — 2 open`, dedupe reporting, reflag_count, self-heal collapse) |
| NC-2 | `documentId` put back into the flag key | **12 red** — proves the exclusion is load-bearing, not cosmetic |
| NC-3 | `resolved_by` dropped from the resolution row | **1 red** (`every cleared row records WHO cleared it`) |
| NC-4 | refused READ swallowed, returning `success: true` | **2 red** (`a refused READ does not report a cleared queue`) |
| NC-5 | `.eq("brokerage_id", …)` dropped from the resolve read | **2 red** (cross-tenant clearing, fabricated audit event) |

## 8. Guard results

`test:offer-flag-loop` 55/0 · `test:use-server-exports` 3/0 ·
`test:orphan-exports` PASS (1427 vs baseline 1427; census 8991 ≥ 8986) ·
`test:silent-write` 14/0 · `test:schema-drift` 34/0 · `test:no-dead-components` 1/0 ·
`test:client-server-only` PASS · `test:check-vocabulary` 18/0 ·
`test:vocabulary-drift` 5/0 · `test:event-flow` 1/0 · `test:writerless-reads` PASS ·
`test:orphan-writes` PASS · `test:tenant-scope` PASS · `test:agent-id-class` 23/0.

Live schema facts this slice depends on, checked against the database rather than
assumed:

* `activities.status` is `character varying` with default `'pending'` and **no CHECK
  constraint** — `'open'` and `'resolved'` are both legal.
* `activities` has **no `updated_at` trigger** (only `activities_set_brokerage_trg`
  BEFORE INSERT), so `updated_at` is set explicitly on every resolve.
* `activities.brokerage_id` is NOT NULL with no default.
* `users` has `first_name` / `last_name` / `email` and **no `full_name`** — the actor
  name lookup was written against the real columns.
