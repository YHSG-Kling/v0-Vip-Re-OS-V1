# Wave 7 — offer lifecycle: one vocabulary, one key, one derivation

Pre-dispatch audit. Every claim below was read out of the tree or the live schema
before any work was briefed. Nothing here is inferred from a function name.

## Live schema (project `hrvaqgvukzxfskkcrwbt`)

`activities` columns relevant to this file:

| column | type | null? |
|---|---|---|
| `brokerage_id` | uuid | **NOT NULL** |
| `entity_type` | text | **NOT NULL** |
| `entity_id` | uuid | null |
| `agent_id` | uuid (FK `agents`) | null |
| `agent_user_id` | uuid (users-class) | null |
| `metadata` | jsonb | null |
| `notes` | text | null |

Two of those facts do all the damage below: `brokerage_id` is NOT NULL with no
default (an insert that omits it writes zero rows), and `entity_id` is nullable
(an insert that omits it succeeds and is then invisible to every keyed reader).

## THE KEY

`entity_type = 'offer'` **AND** `entity_id = <offers.id>`.

Already named as canonical in five places:
`track-offer-lifecycle.ts:99-114`, `lib/kernel/transactions.ts:204-205`,
`lib/buyer-offer/status-sync.ts:44-46`, `lib/buyer-offer/compliance-gate.ts:42`,
`lib/buyer-offer/expire-offers.ts:93-94`.

## THREE derivations, two vocabularies

| # | Where | Vocabulary | Key |
|---|---|---|---|
| D1 | `lib/buyer-offer/lifecycle-event-map.ts:deriveOfferState` | 22 UNDERSCORE constants (`buyer.offer.draft_created`, `.submitted_to_seller`, `.seller_accepted`, `.counter_received`, …) | `metadata->>offer_id` |
| D2 | `track-offer-lifecycle.ts:getOfferLifecycleState` | 7 DOT events (`buyer.offer.draft.created`, `.submitted`, `.accepted`, `.rejected`, `.countered`, `.expired`, `.withdrawn`) | entity_type + entity_id ✅ |
| D3 | `lib/buyer-offer/status-sync.ts:syncOfferStatus` | 9 DOT events; adds `.signature.requested`, `.sent.to.listing.agent`, `.counter.received`, `.voided` | entity_type + entity_id ✅ |

`lib/buyer-offer/expire-offers.ts` (wave 6) carries a **fourth copy of D2's
table**, inlined because that module must be session-free.

**D1 is dead.** Zero writers emit any of its underscore constants except
`buyer.offer.seller_*` (see A below) and `buyer.offer.buyer_signed`.
`deriveOfferState` and `detectConflictingOffers` have no callers outside the
`lib/buyer-offer/index.ts` re-export barrel.

## Confirmed defects

**A — the live seller-response writer is invisible to every derivation.**
`app/actions/buyer-offer/record-seller-response.ts:128-141` is the one wired to a
button (`app/components/offer/offer-agent-actions.tsx:100`, rendered by
`app/crm/contacts/[contactId]/offers/[offerId]/offer-actions-bar.tsx`). It inserts
`entity_type: "offer"` with **no `entity_id`**, under
`buyer.offer.seller_accepted | seller_rejected | seller_countered` — names in no
reader's vocabulary. A seller acceptance recorded through the UI therefore never
reaches `getOfferLifecycleState`, `syncOfferStatus`, or the expiry sweep.
`is_terminal` stays false and `offers.status` never moves.

**B — the acceptance event is filed under the wrong entity.**
`submit-to-compliance.ts:264-275` writes `buyer.offer.accepted` with
`entity_type: "contact"` and no `entity_id`. D2 filters `entity_type='offer'` AND
`entity_id=offerId`, so the one event meaning "this offer is accepted" is
unreachable from the offer.

**C — the compliance-passed row that gates transaction creation omits the key.**
`submit-to-compliance.ts:249-262` writes `buyer.offer.compliance.passed` with
`entity_type: "offer"` but no `entity_id`. Two readers gate on exactly that row
**with** `.eq("entity_id", offerId)`: `convert-to-transaction.ts:110-112` and
`lib/kernel/transactions.ts:221-223`. `compliance-gate.ts:86` writes the same
event *with* `entity_id` — two writers of one event disagreeing on the key.

**D — counter acceptance never moves the status column.**
`respond-to-counter.ts:76-166` writes every offer event under
`entity_type: "contact"` (`.block`, `.counter.accepted`, `.accepted`,
`buyer.under_contract`, `.counter.rejected`, `.counter.submitted`), then calls
`syncOfferStatus(offerId)` at line 171 — which queries `entity_type='offer'` +
`entity_id=offerId`, finds nothing, returns
`{success:false, error:"No lifecycle events found"}`, and the result is discarded.

**E — `buyer.offer.submitted` has no live writer.**
Only `track-offer-lifecycle.ts:212 (submitOffer)` emits it, and `submitOffer` has
no caller — the wizard's `submitOffer` is an unrelated local function of the same
name. `buyer-offers.ts:createOffer` emits `buyer.offer.draft.created`;
`submit-for-signature.ts` emits `buyer.offer.signature.requested` (D3 only). So
D2's derived state for a real offer is stuck at DRAFT. That is *why* the wave-6
expiry sweep is inert rather than dangerous — it refuses anything not PENDING.
The fix is to give submission a real event on the canonical key, **not** to
loosen the refusal.

**F — four writes omit NOT NULL `brokerage_id`, so they write zero rows.**
- `lib/buyer-offer/compliance-gate.ts:84-94` (`emitCompliancePassed`) supplies no
  `brokerage_id` at all. It destructures `error` and returns it, so the caller
  sees the failure — but the gate it exists to open never opens.
- `submit-for-signature.ts:100`, `:118`, `:134` — the two `buyer.offer.block`
  audits and the `buyer.offer.signature.requested` event. Only the last insert in
  that file (`:216`, via `sentinelWrite`) supplies the tenant.
  Line 134 destructures `eventError` and returns
  `{success:false, error:"Failed to log signature request event"}`, so **every
  call to `submitOfferForSignature` fails at that line** and no offer is ever sent
  for signature.

## Consolidation shape

- ONE vocabulary module: D2's 7 states are the state machine; D3's extra events
  (`signature.requested`, `counter.*`, `compliance.*`) are **sub-states** that map
  into the 7, not a rival machine.
- ONE key on every writer: `entity_type='offer'` + `entity_id=<offers.id>`, and
  `brokerage_id` from `offers.brokerage_id` — never from a caller.
- ONE derivation, imported by the session path and the session-free path alike;
  `expire-offers.ts`'s inline copy folds into it.
- D1 (`lifecycle-event-map.ts`) is the loser. Its only unique capability is
  `detectConflictingOffers` — read it against `buyer-offers.ts:canBuyerSubmitOffer`
  and the 3-pending cap and MERGE anything the survivor lacks **before** deleting.
