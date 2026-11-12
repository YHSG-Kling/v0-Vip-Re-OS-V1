# Wave 7 — the WRITER slice

Companion to `docs/wave7-offer-lifecycle-audit.md` (the pre-dispatch audit),
`docs/wave7-slice-derivations.md` (the reader slice), and
`lib/buyer-offer/offer-lifecycle.ts` (the contract).

**Provenance note.** The agent that did this work was lost to a session restart
before it wrote its ledger. This file was reconstructed by reading the actual
diff on disk, not from a report — every claim below was verified against the
code as committed, and anything I could not verify is marked as such rather than
asserted. The in-code comments the slice left behind are extensive and were the
main evidence.

Files changed: `record-seller-response.ts`, `submit-to-compliance.ts`,
`respond-to-counter.ts`, `submit-for-signature.ts`,
`record-seller-signed-counter.ts`, `flag-compliance.ts`,
`lib/buyer-offer/compliance-gate.ts`, `app/actions/buyer-offers.ts`
(+ `handle-multi-offer.ts`, shared with the reader slice as the merge target).

---

## The invariant this slice enforces

Every `activities` row describing an offer now carries **both**:

- `brokerage_id` — taken from `offers.brokerage_id`, never from a caller.
  It is NOT NULL with no default, so an omission wrote ZERO rows.
- `entity_type: 'offer'` + `entity_id: <offers.id>` — the key every reader uses.
  `entity_id` is nullable, so an omission SUCCEEDED and was then invisible.

Verified by inspecting all 14 `from("activities").insert` sites across the seven
files: every one has both fields.

## Defects closed

| # | Where | Was | Now |
|---|---|---|---|
| A | `record-seller-response.ts` | `entity_type:'offer'`, no `entity_id`, event `buyer.offer.seller_${type}` — a name no reader knows | keyed, and `RESPONSE_EVENT[responseType]` → canonical `OFFER_EVENT.ACCEPTED/.REJECTED/.COUNTERED`; the human prose still reads "Seller accepted" |
| B | `submit-to-compliance.ts` | `buyer.offer.accepted` under `entity_type:'contact'`, no `entity_id` | re-keyed to the offer, `OFFER_EVENT.ACCEPTED` |
| C | `submit-to-compliance.ts` | its own `compliance.passed` insert with no `entity_id`, duplicating `compliance-gate.ts` | **merged and deleted** — see below |
| D | `respond-to-counter.ts` | every offer event under `entity_type:'contact'`; `syncOfferStatus` result discarded | all five re-keyed to the offer with canonical events; errors now checked |
| E | `submit-for-signature.ts` | 4 of 5 inserts omitted NOT NULL `brokerage_id`; line 134 checked its error and returned, so **every call failed and no offer was ever sent for signature** | all carry `brokerageId` + `entity_id` |
| F | `compliance-gate.ts:emitCompliancePassed` | no `brokerage_id` at all — the gate could never be opened through it | takes tenant/contact/agent from the offer row |

Also keyed (they already had the tenant, but not the key):
`flag-compliance.ts` and `record-seller-signed-counter.ts`. The latter now
writes **two** rows — the audit event on the counter offer, and
`OFFER_EVENT.COUNTER_RECEIVED` on the *parent* offer, which is the row that
actually moves the parent's derived state.

`buyer-offers.ts` already carried both fields; its literal was switched to
`OFFER_EVENT.DRAFT_CREATED`.

## The merge (defect C)

**Survivor:** `lib/buyer-offer/compliance-gate.ts:emitCompliancePassed`.
**Deleted:** the parallel insert inside `submit-to-compliance.ts`.

Both wrote `buyer.offer.compliance.passed` and **both were broken** — one had the
key but no tenant, the other the tenant but no key. The survivor absorbed the
loser's richer audit shape (title / description / notes / contact_id / agent_id /
status / priority) and now resolves tenant, contact and agent from the offer row
itself. The call site fails CLOSED: if the gate event does not land, no
transaction is created, because that row *is* the gate
`convert-to-transaction.ts`, `lib/kernel/transactions.ts` and
`checkCompliancePassed` all read.

## Defect E — `buyer.offer.submitted` had no emitter (closed by me, not the slice)

The slice left this open; the brief permitted that if the right emitter fell
outside its file scope, and it did. I closed it in
`lib/esign-webhooks/finalize-packet.ts`:

- That file's `finalizeMatchingOffer` inserted `entity_type:'offer'` with **no
  `entity_id`** — the same defect, in a file neither slice owned. Keyed.
- It now emits `OFFER_EVENT.SUBMITTED` on the buyer-first path. That function's
  own docblock already identified this moment in its own words — *"Forward to
  listing agent and await seller response"* — so DRAFT → PENDING belongs exactly
  there. The error is checked and logged loudly: if that row is lost the offer
  stays DRAFT forever, can never expire on its deadline, and every surface
  gating on PENDING treats a live offer as a draft.
- `offers.status` is moved in step, from `EVENT_TO_STATUS`, not a literal.
- **Deliberately NOT on the counter-fully-executed branch.** There both sides
  have signed and the next state is ACCEPTED — which in this system is reachable
  ONLY through the compliance gate. Emitting an acceptance there would walk
  straight past it. That branch keeps its `counter.fully_executed` audit row and
  compliance remains the only door.

This is what makes the wave live rather than structural: before it, no offer
ever reached PENDING, which is why `/api/cron/offer-expiry` (wave 6) refused
every offer it scanned.

## Contract change absorbed (raised by the reader slice, §5.1)

`OfferHistoryEntry` gained `reason: string | null`, parsed once in
`deriveOfferStateFromActivities` via `parseReason` (reads `reason`, then
`response_type`; null on anything unparseable — a malformed audit note must not
break a state read). The reader slice was right that re-parsing `notes` in
`track-offer-lifecycle.ts` would reintroduce the drift, and right to raise it
rather than route around the contract. `getOfferLifecycleState` surfaces it
again, so no caller lost a field.

## Still open — on the record, not silently dropped

1. **Audit/gate events have no canonical constant.** `buyer.offer.block`,
   `.compliance.passed/.failed/.flagged`, `.provider.signature.*`,
   `.buyer_signed`, `.counter.fully_executed`, `.counter.seller_signed`,
   `.counter.external_received`, `.signature.sent_to_contact` are still string
   literals. They are correctly absent from `EVENT_TO_STATE`/`EVENT_TO_STATUS`,
   which are TOTAL `Record<OfferEvent, …>` — adding them would force an invented
   state. Both slices reached this independently. **Recommendation:** a sibling
   `OFFER_AUDIT_EVENT` const in `offer-lifecycle.ts`, no state mapping.
2. **`getOfferLifecycleState`, `canBuyerSubmitOffer` and `getBuyerActiveOffers`
   are ungated `"use server"` exports** on the service client — an unauthenticated
   caller with an offer uuid reads any tenant's lifecycle. Pre-existing, not in
   the audit, and an authz change rather than a lifecycle one.
   `checkDuplicateOffer` and `emitMultiOfferEvent` in the same module already
   have `requireContactTenant`, so the pattern to copy is in the file.
3. **`buyer.offer.sent.to.listing.agent`** is in the contract (mapping to
   `under_review`, which the UI renders) but still has no emitter. It is the
   honest name for "the agent forwarded it", a step the product does not yet
   have a button for.
