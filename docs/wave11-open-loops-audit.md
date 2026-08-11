# Wave 11 — closing the loops left open

Not new territory. This is the backlog the previous waves' ledgers recorded
honestly rather than quietly dropping, plus the items their file scopes forbade
them from touching. Every claim below was re-verified against the tree today.

The unifying shape: **a path that reports success while doing nothing.** Each of
these is a loop that never closes, and each is invisible from both ends — the
caller sees no error, the reader sees no row.

## L1 — the deal's agent has NEVER received a transaction notification

`lib/kernel/notification-engine.ts:185-192` resolves the recipient for a
`transaction`-entity notification:

```ts
.from("transactions").select("agent_id")      // agents.id
…
user_id: transaction.agent_id,                // notifications.user_id → users FK
```

`transactions.agent_id` is an **agents.id**; `notifications.user_id` is a
**users.id**. Disjoint id spaces. Every transaction-entity notification has been
addressed to an id that cannot match a user — so either the insert FK-throws or
it lands against nobody, and in both cases the responsible agent is never told.

The resolver already exists and is used elsewhere in this exact situation:
`resolveAgentRecordToUserId` (agents.id → users.id). This is the class the
identity-class guard exists for.

## L2 — the earnest-money watchdog cannot raise a flag at all, and its dedupe is dead

`app/api/cron/em-receipt-watcher/route.ts` is a cron (no session, service
credential). It calls `flagOfferCompliance`, which is a `"use server"` module
opening with a cookie-session auth gate (`auth.getUser()` → `Unauthorized`).
**Every iteration returns Unauthorized**, so a missing earnest-money receipt has
never once been flagged.

Independently, its 48-hour dedupe cannot match either. It filters
`notes ilike '%<offerId>%em_receipt_missing%'`, but the writer stores
`JSON.stringify({ offer_id, flagType, severity, … })` where `flagType` is one of
the packet vocabulary values — the literal `em_receipt_missing` never appears in
`notes`. So if the auth problem were fixed alone, the watchdog would re-flag the
same offer every run.

Both must be fixed together or the fix trades silence for noise.

## L3 — the LISTING packet scan matches a key nothing writes

Wave 9 fixed exactly this class on the offer side (`scanOfferPacketCompleteness`
returned `blockers: []` on an unrunnable scan and the gate read it as a pass).
Its sibling still has the disease in a purer form:

`lib/workflow/intelligence/scan-offer-packet.ts:scanListingPacketCompleteness`
looks its document up by `metadata.linked_listing_id`. Nothing in the tree writes
that key — and this is already ESTABLISHED, not suspected:
`lib/compliance/required-documents.ts:244` records the same finding for the
sibling audit and was fixed there by matching **both** that key and the
`listing_id` COLUMN, which `lib/documents/upload-document.ts` actually writes.

So the listing scan always takes its "no document" exit and reports a pass. Wave
9's agent deliberately did not widen the lookup, on the reasoning that it would
start matching agent-uploaded PDFs which legitimately carry no `filledPacket`.
That reasoning is sound and must be preserved: the fix is to match what a STAGED
LISTING PACKET is actually keyed by, and to make an unrunnable scan a refusal
rather than a silent pass — the wave-9 `scanOutcome` vocabulary already exists
for exactly this and should be reused, not re-invented.

## L4 — the confirm-branch inbound documents never reach their offer

Wave 10 made the CONFIRM branch (the one an outside buyer's agent actually
triggers) file its attachments instead of discarding them. They are stamped
`metadata.awaiting_offer_link` plus a `listing_id`, because at that moment no
offer row exists yet.

Nothing ever completes the link. Whichever surface turns a confirmed inbound
email into an offer must stamp `metadata.linked_offer_id` on those rows, or they
count toward the LISTING forever and never toward the offer whose compliance gate
needs them — and the attestation, which requires a document on file for the
offer, will refuse.

## L5 — the pre-flight scan panel hides the remedy it was given

`app/components/offer/offer-agent-actions.tsx:runScan` surfaces only
`json.error`. Since wave 9 the actionable instruction lives in
`blockers[0].body` ("What to do: …"), which is the whole point of that change —
a refusal that names the fault and withholds the remedy is the dead end this
sequence of waves keeps removing.

## Recorded, NOT to be invented in this wave

- Several contract terms have no `transactions` column at all (`financing_type`,
  `down_payment_*`, `closing_cost_contribution`, `possession_terms`,
  escalation / appraisal-gap). Persisting them needs DDL and an owner decision,
  not a guessed home.
- `signedDocUrl` returns `""` on failure and the caller then bails **after** the
  bytes are in the bucket — an orphaned storage object. Pre-existing.
- The audit/gate event names (`buyer.offer.block`, `.compliance.*`,
  `.provider.signature.*`, `.buyer_signed`, `.counter.*`) still have no canonical
  constant. They are correctly absent from the STATE maps; a sibling
  `OFFER_AUDIT_EVENT` const is the recommendation, not a state mapping.
- `getOfferLifecycleState`, `canBuyerSubmitOffer`, `getBuyerActiveOffers` are
  ungated `"use server"` exports on the service client. Pre-existing authz change;
  the gate pattern (`requireContactTenant`) is already in the same module.

## Rules (unchanged)

- DUPLICATE → read BOTH, MERGE onto the survivor, THEN delete naming it.
- NOT a duplicate → wire it or finish it. "No caller" is never a deletion reason.
- supabase-js RESOLVES a refused query — destructure `error`; gates fail CLOSED.
- Pre-rollout the tables are EMPTY: "nothing came back" is never health, and on
  these paths it is the bug.
- `agents.id` / `users.id` / `contacts.id` are DISJOINT — resolve, never `??`.
- `activities.brokerage_id` is NOT NULL with no default.
- Assert CONSTRUCTS in proofs, never spellings; negative-control every assertion.
