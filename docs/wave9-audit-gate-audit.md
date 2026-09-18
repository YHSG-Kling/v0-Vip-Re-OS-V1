# Wave 9 — the audit gate (owner ruling)

## The ruling, verbatim

> the audit gate is when the offer is accepted and all paperwork is submitted to
> compliance to be sure all documents for the transaction are all present and all
> signatures/initials are complete on both sides. if all are present, then a
> transaction is created, if not, then the missing piece is sent to the tc and
> agent to get it finished and resubmitted for approval.

So the gate has four obligations:
1. fire when the offer is ACCEPTED and the paperwork is submitted;
2. verify EVERY required document is present;
3. verify ALL signatures/initials are complete ON BOTH SIDES;
4. pass ⇒ create the transaction; fail ⇒ send the missing piece to the TC and the
   agent, who finish it and RESUBMIT for approval.

Everything below was read out of the tree before any work was briefed.

## What already satisfies the ruling — do NOT rebuild it

**Obligation 1 is met, and well.** `app/actions/buyer-offer/submit-to-compliance.ts`
refuses unless `offers.buyer_signed_at` is set AND an executed contract is on file
by one of two paths it names explicitly: `seller_response_type='accepted'` with
`fully_signed_contract_received_at` (buyer-first), or `seller_signed_at` with
`fully_signed_contract_received_at` (seller-first counter). That IS "accepted, both
sides signed" at the offer level. Leave it alone.

**Obligation 2 is met.** `auditOfferDocuments` resolves the broker's required-docs
checklist agent → team → brokerage, scoped to the property's state (listing.state,
else the 2-letter state parsed from the address). Blocking misses refuse the
submit; warning misses pass but notify.

**Obligation 4's notification half is met.** On refusal it fans out a
`compliance.submit_blocked` flag to the agent, the TC (from the brokerage roster
inside `notifyComplianceFlag`), the compliance officer, the OFFER's agent
(resolved `agents.id` → `users.id`) and the LISTING agent. Warning-level misses
notify too, at medium severity.

## THE DEFECTS — three, each verified

### D1 — the packet gate PASSES when there is no packet at all

`lib/workflow/intelligence/scan-offer-packet.ts:scanOfferPacketCompleteness`
returns, when it cannot find the staged offer document:

```ts
return { success: false, offerId, documentId: null, completionPercent: 0,
         totalFields: 0, filledFields: 0, blockers: [], warnings: [],
         notifications_fired: 0, error: "No staged document found for this offer" }
```

`blockers: []`. And the gate reads ONLY the blockers —
`submit-to-compliance.ts:143`:

```ts
const hasPacketBlockers = packetScan.blockers && packetScan.blockers.length > 0
```

`packetScan.success` and `packetScan.error` are referenced NOWHERE in that file
(grep: lines 137, 143, 182, 191, 202, 216, 284 — all `.blockers` / `.warnings`).

**So "the packet is fully signed" and "there is no packet whatsoever" are
indistinguishable to the gate, and both pass.** The same is true of the invalid-ID
early return. A transaction is then created having verified zero signatures and
zero initials — the exact opposite of obligation 3. This is the task-#105 class
("documents_verified passes with zero documents") reappearing in the packet half
of the same gate.

FAIL CLOSED: a completeness scan that could not run has not established
completeness. It must block and say so.

### D2 — the loop never closes: no compliance flag is ever resolved

`app/actions/buyer-offer/flag-compliance.ts:118` inserts every flag with
`status: "open"`. Grep across `lib/` and `app/` finds **no** function that
resolves, closes or re-opens a compliance flag — no `resolveComplianceFlag`, no
status update on any compliance-flag row.

Consequences, all of which the owner's step 4 requires not to happen:
- the TC fixes the missing item, resubmits, and the ORIGINAL flag stays `open`
  forever;
- each resubmission fans out a NEW flag for anything still missing, so duplicates
  stack per attempt;
- a passing resubmission clears nothing, so the compliance queue never returns to
  empty and stops meaning anything.

"Resubmitted for approval" is only half-built: the resubmit works, the approval
leaves no trace, and the outstanding-work list is write-only.

### D3 — "both sides" is asserted at the OFFER, never inside the PACKET

Obligation 3 is checked twice over, at two different altitudes, and only the first
is complete:
- at the OFFER row: buyer signed + executed contract on file — **correct** (above);
- inside the PACKET: `lib/workflow/intelligence/packet-analysis.ts:analyzeFilledPacket`
  walks `filledPacket.forms[].unfilled[]` and classifies each missing field via
  `classifyMissingField` into `missing_signature` (critical) / `missing_initial`
  (high) / other. It is FIELD-driven and side-agnostic: it reports whatever the
  staged packet happens to contain. Nothing asserts that the packet contains a
  seller-side signature block at all.

So a packet built with only buyer-side fields walks through with zero blockers.
Combined with D1 (no packet ⇒ no blockers) the packet half of this gate can be
satisfied without a single seller signature ever being examined.

## The work

**Fail closed on an unrunnable scan (D1)** — the narrow, highest-value fix.
**Close the loop (D2)** — flags resolve when the miss is fixed; resubmission does
not stack duplicates; a passing submit clears the outstanding set.
**Make "both sides" explicit in the packet (D3)** — a packet that cannot show a
seller-side signature block is not complete, and must say which side is missing.

## Rules (restated because they are what matters)

- DUPLICATE → read BOTH, MERGE onto the survivor, THEN delete naming it as
  `file.ts:functionName`. Never port a defect — fix the class at the survivor.
- NOT a duplicate → WIRE it or finish it. "No caller" is never a deletion reason.
- Pre-rollout: tables are EMPTY. "The query returned nothing" is never evidence of
  health — and on THIS gate it is the bug.
- supabase-js RESOLVES a refused query — destructure `error`; **a gate fails
  CLOSED**.
- `"use server"` files may export ONLY async functions.
- `agents.id` / `users.id` are disjoint id spaces — resolve, never `??`.
- Assert CONSTRUCTS in proofs, never spellings.
