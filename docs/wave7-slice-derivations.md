# Wave 7 — the DERIVATION slice

Companion to `docs/wave7-offer-lifecycle-audit.md` (the pre-dispatch audit) and
`lib/buyer-offer/offer-lifecycle.ts` (the contract).

This slice owned the **readers**: the three places that answered "what state is
this offer in", plus the fourth inlined copy of one of them. It did not touch the
writers — those are a separate slice.

Files changed:

- `app/actions/buyer-offer/track-offer-lifecycle.ts` (repoint)
- `lib/buyer-offer/expire-offers.ts` (repoint)
- `lib/buyer-offer/status-sync.ts` (repoint)
- `app/actions/buyer-offer/handle-multi-offer.ts` (merge target)
- `lib/buyer-offer/lifecycle-event-map.ts` (**DELETED**)
- `lib/buyer-offer/index.ts` (barrel)

---

## 1. DELETIONS, each with its named survivor

### 1.1 `lib/buyer-offer/lifecycle-event-map.ts` — the whole file

D1 in the audit. Deleted after both of its functions were read in full against
their survivors.

| deleted | survivor | merged first? |
|---|---|---|
| `OFFER_LIFECYCLE_EVENTS` (22 underscore constants) | `lib/buyer-offer/offer-lifecycle.ts:OFFER_EVENT` | nothing to merge — see below |
| `deriveOfferState` | `lib/buyer-offer/offer-lifecycle.ts:deriveOfferStateFromActivities` | nothing to merge — see below |
| `detectConflictingOffers` | `app/actions/buyer-offer/handle-multi-offer.ts:checkDuplicateOffer` | **YES — two capabilities merged, see §2** |
| `OfferLifecycleEvent` (type) | `lib/buyer-offer/offer-lifecycle.ts:OfferEvent` | n/a |
| `OfferEventMetadata` (type) | none — deliberately not replaced, see below | n/a |

**`deriveOfferState` had nothing to merge, and the evidence is the key.** It read
`activities` filtered by `.eq("metadata->>offer_id", offerId)`. Nothing in the
repo writes offer lifecycle events under `metadata.offer_id` — the writers put
the offer id in `notes` (as JSON) and/or in `entity_id`, and every other reader
(`track-offer-lifecycle.ts`, `status-sync.ts`, `expire-offers.ts`,
`compliance-gate.ts`, `lib/kernel/transactions.ts`) keys on
`entity_type='offer'` + `entity_id`. So `deriveOfferState` derived state from
rows that do not exist, and returned `"DRAFT"` for every offer on the platform —
including, silently, on a refused read, because it did `const { data: events }`
and never destructured `error`. Its state table is also strictly narrower than
the survivor's: 7 of its 22 constants mapped to a state, and the survivor covers
14 events over the same seven states. There is no behaviour here the survivor
lacks.

**`OFFER_LIFECYCLE_EVENTS` had no importer and no emitter.** Verified by grep
across `app/ lib/ components/ hooks/ services/ scripts/`: the only file that ever
named the constant was `lib/buyer-offer/index.ts`, re-exporting it. Every writer
in the tree emits a **string literal**, so deleting the constant cannot break a
writer. Six of its names have no counterpart in `OFFER_EVENT` and are called out
as an open contract question in §5.

**`OfferEventMetadata` was deleted, not replaced.** Zero importers anywhere
(same grep). It is an index-signature bag (`[key: string]: any`) whose one
load-bearing field, `offer_id`, IS the abandoned `metadata->>offer_id` key —
i.e. the type documents the wrong key. Keeping it would preserve a pointer to
the thing this wave abolished. If a typed metadata payload is wanted later, it
belongs next to `OFFER_EVENT` where the writers can see it.

**Where the record lives in code:** `lib/buyer-offer/index.ts`, in place of the
old `LIFECYCLE EVENT MAP` export block — the one place any importer of the
deleted module would look.

### 1.2 `track-offer-lifecycle.ts:deriveStateFromEvent` + its private 7-name `.in(...)` list

- **Survivor:** `lib/buyer-offer/offer-lifecycle.ts:EVENT_TO_STATE` (the map),
  `…:OFFER_LIFECYCLE_EVENT_TYPES` (the filter), applied by
  `…:deriveOfferStateFromActivities`.
- **Merged first:** nothing. The survivor's table is a strict superset (14
  events vs 7) over the identical key, and it is stricter in one place: the
  deleted helper returned the string `"UNKNOWN"` for an unmapped event and let
  that become `current_state`; the survivor skips an unmappable row instead.
- In-code record: bottom of `track-offer-lifecycle.ts`, where the function was.

### 1.3 `expire-offers.ts:LIFECYCLE_ACTIVITY_TYPES` + `ACTIVITY_TO_STATE` + `readCurrentState`

- **Survivor:** `lib/buyer-offer/offer-lifecycle.ts:deriveOfferStateFromActivities`.
- **Merged first:** nothing. Every behaviour of `readCurrentState` is present in
  the survivor, including the load-bearing one — both destructure `error`, so a
  refused read is reported as a refusal rather than collapsing into "offer not
  found" and being skipped by the sweep forever.
- In-code record: top of `expire-offers.ts`, where the constants were.

### 1.4 `status-sync.ts:EVENT_TO_STATUS` (private 9-entry map)

- **Survivor:** `lib/buyer-offer/offer-lifecycle.ts:EVENT_TO_STATUS`.
- **Merged first:** nothing needed — the contract already carries this file's
  nine rows **verbatim** (`draft.created→draft`, `signature.requested→submitted`,
  `sent.to.listing.agent→under_review`, `counter.received→countered`,
  `accepted→accepted`, `rejected→rejected`, `withdrawn→withdrawn`,
  `expired→expired`, `voided→voided`) and adds five the other derivations already
  knew. Confirmed row-by-row before deleting.
- In-code record: top of `status-sync.ts`.

---

## 2. THE ONE REAL MERGE — `detectConflictingOffers` → `checkDuplicateOffer`

Read side by side:

```
detectConflictingOffers(supabase, contactId, listingId, excludeOfferId?)
  → { hasConflict, conflictingOffers: string[] }

checkDuplicateOffer(contactId, listingId)
  → { success, has_duplicate, existing_offer_id?, existing_state?, error? }
```

**Does the survivor detect a same-buyer/same-listing duplicate at all? Yes.** It
queries `offers` by `contact_id` + `listing_id` and then asks
`getOfferLifecycleState` per row — the same shape, on the working key. It is
already wired: `app/actions/buyer-offers.ts:createOffer` calls it before every
offer insert. `detectConflictingOffers` had no caller of any kind.

**Two genuine capabilities the survivor lacked. Both merged.**

1. `excludeOfferId` — leave one offer out of its own scan. Without it, running
   the check for an offer that already exists (an amend or a re-submit) makes
   that offer collide with itself and reports a false duplicate every time. Added
   as an optional third parameter, uuid-validated.
2. The **full** conflicting set rather than the first hit. `existing_offer_id`
   is enough to block; it is not enough to tell an agent what to resolve when a
   buyer has more than one live offer on a property. Added as
   `conflicting_offer_ids: string[]`, returned alongside the unchanged
   `existing_offer_id` / `existing_state` so the existing caller is untouched.

**Three things were NOT ported, because they are defects. The class is fixed at
the survivor instead.**

| loser's behaviour | why it is a defect | what the survivor does |
|---|---|---|
| queries `offers` on a service client with **no `brokerage_id` filter** | cross-tenant read: any brokerage's buyer/listing pair | proves a session and that the CONTACT is in the caller's brokerage (`requireContactTenant`), and the offers query now also carries `.eq("brokerage_id", tenant.brokerageId)` |
| `const { data: offers } = …` — **swallows the read error** | supabase-js RESOLVES a refused query, so a refusal and "no offers" were the same value; the conflict gate failed **OPEN** | `error` is destructured; a failed read returns `success:false` **with the message** (the catch previously returned `success:false` with no `error` at all — also fixed) |
| counted only `PENDING` | a COUNTERED offer is a live negotiation and was not treated as a conflict | counts every **non-terminal** state, and lets the caller decide how much binds |

One more defect found while merging and fixed at the survivor:
`detectConflictingOffers` expressed its exclusion as `.neq("id", excludeOfferId || "")`.
An empty string is not a uuid; Postgres rejects it as malformed input rather than
matching nothing, so the no-exclusion path was one error away from returning zero
rows (and, with the swallowed error above, reading back as "no conflict"). The
survivor applies the filter conditionally instead.

---

## 3. REPOINTS — what changed, what did not

### 3.1 `track-offer-lifecycle.ts:getOfferLifecycleState`

**Unchanged:** the public return shape
`{success, data:{offer_id, current_state, state_since, history, is_terminal}}`;
the key (`entity_type='offer'` + `entity_id`); the `isValidUUID` guard; the
service client; all three in-file callers and both external callers
(`convert-to-transaction.ts:convertOfferToTransaction`,
`handle-multi-offer.ts` ×3) verified by reading them — they touch only
`current_state`, `is_terminal` and `state_since`.

**Changed, deliberately:**

- `is_terminal` now comes from `offer-lifecycle.ts:isTerminalOfferState` instead
  of an inline `["ACCEPTED","REJECTED","EXPIRED","WITHDRAWN"].includes(...)`.
  Same four states; one definition.
- The derivation now sees **14** event names instead of 7. An offer whose latest
  event is `buyer.offer.signature.requested`, `buyer.offer.counter.received`,
  `buyer.offer.counter.submitted`, `buyer.offer.counter.accepted`,
  `buyer.offer.counter.rejected` or `buyer.offer.voided` used to fall straight
  through the `.in(...)` filter, so the state reported was whatever OLDER event
  preceded it. Those offers now report the correct state.
- **Error text.** A read that returns nothing now says `"Offer has no lifecycle
  events"`; a read that is REFUSED now says `"Could not read offer lifecycle: …"`.
  Both used to be `"Offer not found"` — supabase-js resolves a refused query and
  the old `if (error) throw` path collapsed the two. No caller matches on the
  string; all of them surface it to the operator.
- `current_state` and `history[].state` are typed as the canonical `OfferState`
  union rather than a re-spelled copy and a bare `string`. Same seven members.
- `history[].actor_id` is `string | null`. `activities.agent_id` is nullable on
  the live schema and the unattended sweep files rows with no human actor, so
  the old non-nullable `string` was a type the data could not honour.

**Removed from the public shape — and this is the one capability lost:**
`history[].reason`. It was parsed out of the `notes` JSON blob by this file's own
reader. `deriveOfferStateFromActivities` does not select `notes`, and I do not
own `lib/buyer-offer/offer-lifecycle.ts`, so I did not extend it.

**No caller reads `history` at all** — grepped across
`app/ lib/ components/ hooks/ services/ scripts/`; every `getOfferLifecycleState`
call site reads only `current_state`, `is_terminal`, `state_since`. I chose NOT
to re-attach `reason` with a second query over the same rows, because that would
put a second offer-lifecycle read back into this file — precisely the drift this
wave removes. **Contract request in §5.1.**

### 3.2 `lib/buyer-offer/expire-offers.ts`

**Every refusal is preserved, and one is now stricter.** Proven by direct
execution against a stubbed client (all eleven paths):

```
{"expired":false,"reason":"Offer has no brokerage — cannot file the expiry event"}     ← no brokerage
{"expired":false,"reason":"This offer has no response deadline, so it cannot expire on one"}  ← no deadline
{"expired":false,"reason":"This offer's response deadline is not a readable date"}     ← unparseable deadline
{"expired":false,"reason":"The response deadline has not passed yet"}                  ← deadline in the future
{"expired":false,"reason":"Could not read offer lifecycle: permission denied"}         ← REFUSED read (not "not found")
{"expired":false,"reason":"Offer has no lifecycle events"}                             ← no events
{"expired":false,"reason":"Only PENDING offers can expire (currently DRAFT)"}          ← state !== PENDING
{"expired":false,"reason":"Only PENDING offers can expire (currently COUNTERED)"}      ← NEW: was invisible before
{"expired":false,"reason":"Expiry event recorded but offers.status did not update: no row matched"}
{"expired":false,"reason":"Expiry event recorded but offers.status did not update: boom"}
{"expired":true}                                                                       ← PENDING + passed deadline
activity written: {"activity_type":"buyer.offer.expired","entity_type":"offer","entity_id":"o1","brokerage_id":"b1","agent_id":"a1"}
offers patch   : {"status":"expired"}
```

The COUNTERED line is the behaviour change and it moves in the safe direction: an
offer under live counter used to be invisible to this module's 7-name filter, so
it could read back `PENDING` from an older `buyer.offer.submitted` and be expired
out from under a negotiation. It is now refused.

The written literals are now sourced, not typed: `activity_type` is
`OFFER_EVENT.EXPIRED` and the status is `EVENT_TO_STATUS[OFFER_EVENT.EXPIRED]`.
Both still evaluate to exactly `"buyer.offer.expired"` / `"expired"` — verified
at runtime — so nothing on disk or on screen changes shape.

`sweepDueOfferExpirations` is untouched, including its `status.is.null` branch
and its throw-on-refused-scan.

### 3.3 `lib/buyer-offer/status-sync.ts`

**Unchanged:** the rule (`offers.status` is an OPERATIONAL INDEX ONLY — it
REFLECTS lifecycle and never DRIVES it), the key, the `isValidUUID` guard, the
service client, both function signatures and both return shapes.

**Changed:**

- The private map is gone; the canonical one is imported.
- The `.in(...)` filter is `OFFER_LIFECYCLE_EVENT_TYPES` (14) rather than
  `Object.keys(<private map>)` (9). Consequence: an offer whose latest event is
  `buyer.offer.submitted` / `.counter.submitted` / `.counter.accepted` /
  `.counter.rejected` / `.countered` is no longer skipped, and `offers.status`
  now moves to `pending` / `pending` / `accepted` / `rejected` / `countered`
  respectively. Those five literals are the ones the offer screens already
  render (per the contract's docblock).
- **Every failure path now logs at `console.error` with the offer id** — see §4.

---

## 4. ON THE RECORD: `syncOfferStatus`'s result was discarded by both callers

**The condition as briefed.** `app/actions/buyer-offer/submit-for-signature.ts:257`
and `app/actions/buyer-offer/respond-to-counter.ts:171` each did:

```ts
// Sync status
await syncOfferStatus(offerId)
```

and threw the result away — neither assigned it, tested it, nor mentioned it in
its own return value. That mattered because **both hit the failure path every
time**: `respond-to-counter.ts` wrote all six of its offer events under
`entity_type: "contact"` (audit defect D), and `submit-for-signature.ts`'s
signature-requested insert omitted the NOT NULL `brokerage_id` so it wrote zero
rows (audit defect F). `syncOfferStatus` queried
`entity_type='offer'` + `entity_id=offerId`, found nothing, returned
`{success:false, error:"No lifecycle events found"}` — and the caller reported
success while `offers.status` stayed stale on every screen.

**What I did, at my end.** Those two files belong to the WRITER slice, so I did
not change them. Instead every failure path in `syncOfferStatus` — empty result,
read error, unmapped event, update error — now emits a `console.error` naming the
offer id. The empty-result branch says in plain words that `offers.status` was
NOT updated and is now stale, names the two likely causes (wrong `entity_type`,
or omitted `entity_id`), and states that the caller may discard the result so
nothing downstream will report it. `getCurrentOfferStatus` got the same
treatment. The docblock carries the warning with both call sites named.

**Resolved concurrently.** Re-checked at the end of this slice: the writer slice
has since repaired both call sites — `submit-for-signature.ts:356-360` captures
the result and logs a `statusSyncError`, and `respond-to-counter.ts:273-279`
returns `success:false` with the sync error surfaced to the operator. The loud
logging added here stays as the second line of defence: it is the only trace if a
future call site is written to ignore the result again.

---

## 5. THINGS I DID NOT DO, AND WHY

### 5.1 CONTRACT REQUEST — `history[].reason` has no home

`lib/buyer-offer/offer-lifecycle.ts:OfferHistoryEntry` carries
`{event, state, at, actorAgentId}`. It does not carry the human reason, which
the writers DO record: `withdrawOffer` puts `reason` into the `notes` JSON, and
`recordSellerResponse` puts `response_type` there. The old
`getOfferLifecycleState` surfaced it as `history[].reason`.

I did not add `notes` to the canonical select, because `offer-lifecycle.ts` is
not in this slice and the brief is explicit that a disagreement with the contract
is to be raised, not silently routed around. **Recommendation:** add `notes` to
the derivation's select and a `reason: string | null` to `OfferHistoryEntry`,
parsed once, so no reader ever re-parses that blob again. Until then the field is
simply absent, and nothing reads it.

### 5.2 The non-state offer events have no canonical constant

D1's 22 names were checked one by one against the tree before the file was
deleted. Three groups:

**(a) Live event names that `OFFER_EVENT` does not carry — already on the record
elsewhere.** `buyer.offer.compliance.passed` (written by
`lib/buyer-offer/compliance-gate.ts:emitCompliancePassed`, read as a hard gate by
`convert-to-transaction.ts` and `lib/kernel/transactions.ts`),
`buyer.offer.compliance.failed`, `buyer.offer.compliance.flagged`
(`flag-compliance.ts:113`), `buyer.offer.buyer_signed` and
`buyer.offer.counter.fully_executed` (`lib/esign-webhooks/finalize-packet.ts:276`),
and `buyer.offer.seller_accepted|seller_rejected|seller_countered`
(`record-seller-response.ts` — audit defect A).

These are correctly absent from `EVENT_TO_STATE` / `EVENT_TO_STATUS`, which are
TOTAL `Record<OfferEvent, …>`: adding an audit/gate event there would force an
invented state mapping. The writer slice reached the same conclusion
independently and has written it into
`lib/buyer-offer/compliance-gate.ts:11-27`, with the standing recommendation for
a sibling `OFFER_AUDIT_EVENT` const recorded in `docs/wave7-slice-writers.md`.
Nothing further from this slice — it is not a derivation question, and deleting
D1 strands nothing because every one of these is emitted as a string literal and
D1's constant had no importer.

**(b) Names with no emitter in code at all** — `buyer.offer.provider_loop_created`,
`buyer.offer.prefill_complete`, `buyer.offer.provider_documents_synced`,
`buyer.offer.rollback`. Zero hits across `app/ lib/ components/ hooks/ services/`.
Two more, `buyer.offer.provider_status_synced` and `buyer.offer.accepted_final`,
survive only as prose in `lib/buyer-offer/COMPLIANCE_RULES.md` (see §5.4). These
were an aspiration, not a vocabulary; nothing is stranded by their removal.

**(c) The seven that D1 mapped to a state** — all seven have a canonical
counterpart in `OFFER_EVENT`, under the DOT spelling the live writers use.

### 5.3 `getOfferLifecycleState` is an ungated `"use server"` export

It is a public HTTP endpoint, running on `createServiceClient()`, that takes an
offer uuid and returns that offer's full lifecycle state and history to an
unauthenticated caller, cross-tenant. So are `canBuyerSubmitOffer` and
`getBuyerActiveOffers` in `handle-multi-offer.ts`. This is pre-existing, is not
named in the audit, and is an authz change rather than a derivation change —
adding a gate would alter the contract of five call sites mid-wave, in a tree
another agent is editing. **Recorded here so it is on the record and not
rediscovered as new.** `checkDuplicateOffer` and `emitMultiOfferEvent` in the
same module already have the gate (`requireContactTenant`), so the pattern to
copy is in the file.

### 5.4 `lib/buyer-offer/COMPLIANCE_RULES.md` still documents `detectConflictingOffers`

Line 61 of that file shows `detectConflictingOffers(supabase, contactId, listingId)`
as the duplicate-prevention recipe. That function no longer exists. The file is
outside this slice's file list so I left it alone. **It should be repointed to
`app/actions/buyer-offer/handle-multi-offer.ts:checkDuplicateOffer`.** (Its
"3 PENDING offers" section is likewise illustrative — the real cap lives in
`lib/offers/multi-offer-rules.ts:evaluateOfferLimit`, called by
`handle-multi-offer.ts:canBuyerSubmitOffer`.)

### 5.5 Pre-existing guard failure, untouched by this slice

`npm run test:agent-id-class` (`scripts/identity-class-guard.ts:733`) asserts
`(tol.match(/agent_id: await resolveAgentId\(/g) ?? []).length === 4` in
`track-offer-lifecycle.ts`. The file has 3 — because a previous wave moved the
expiry path out to `expireOffer(...)`, where the same resolved value is passed as
`actorAgentId:` rather than `agent_id:`. The identity class is still correct; the
guard's regex is one refactor behind. I did not touch any of those four lines and
the count is unchanged by this slice. Fixing the assertion belongs with whoever
owns that guard.

### 5.6 `expire-offers` is not re-exported from the barrel

Left as a path import so the session-free module is never pulled in as a side
effect of reaching for something else in `@/lib/buyer-offer`. Noted in the barrel.
