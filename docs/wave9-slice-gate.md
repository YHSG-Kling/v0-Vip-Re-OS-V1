# Wave 9 — slice: the audit gate (D1 + D3)

Scope: `lib/workflow/intelligence/scan-offer-packet.ts`,
`lib/workflow/intelligence/packet-analysis.ts`,
`app/actions/buyer-offer/submit-to-compliance.ts`,
`scripts/offer-packet-gate-simulator.ts` (new proof, wired into `guard`).

The owner's ruling governs:

> the audit gate is when the offer is accepted and all paperwork is submitted to
> compliance to be sure all documents for the transaction are all present and all
> signatures/initials are complete on both sides. if all are present, then a
> transaction is created, if not, then the missing piece is sent to the tc and
> agent to get it finished and resubmitted for approval.

---

## What I confirmed in the audit

**D1 is real and is exactly as described.** `scanOfferPacketCompleteness`
returned `blockers: []` on both of its early exits (invalid id, no staged
document), and `submit-to-compliance.ts:143` read only
`packetScan.blockers.length`. `packetScan.success` and `packetScan.error` were
referenced nowhere in that file. "Fully signed" and "no paperwork at all"
were the same value at the gate, and both created a transaction.

**D3 is real** — `analyzeFilledPacket` was field-driven and side-agnostic, and a
buyer-only packet produced zero blockers. But the fix the brief imagined is not
available from this data; see below.

## What I corrected

**C1 — the listing checkpoint already reads `success`, so the pattern existed.**
`app/actions/seller-listing/execution-engine.ts:markAgreementSigned` refuses on
`blockingDocs.length > 0 || packetBlockers.length > 0 || !packetScan.success`
and says `packet check could not run (...)`. The offer checkpoint was the only
one that did not. The two gates are meant to be the same run, so the offer side
now refuses on the same condition and in the same words.

**C2 — D1 has a THIRD exit the audit does not mention, and it is the one that
fires in practice.** A staged document whose `content` does not parse, or parses
without a `filledPacket`, fell through to `analyzeFilledPacket({})`, which
returns zero blockers and `completionPercent: 100`. That is not hypothetical:

- `app/actions/voice-assistant/draft-offer-from-voice.ts:173` stages the document
  with `content = JSON.stringify({ filledPacket, intake })`, and then at line 199
  calls `generateOfferDraft({ documentId: doc.id, ... })`;
- `app/actions/ai-offer-creation.ts:790-811` **overwrites that same row's
  `content` with a different shape** (`{ prefilled, needs_agent_input, ... }` —
  no `filledPacket`) and **replaces `metadata` wholesale** rather than spreading
  it.

So on that path the packet the scanner is asked to walk no longer exists, and
the scan reported "100% complete, nothing outstanding". Fixed: a document with
no packet in it is now an unrunnable scan, not a clean one.

**C3 — the offer packet lookup can only ever match ONE staging path.** The scan
finds the packet by `document_type='offer'` AND
`metadata->>linked_offer_id = <offers.id>`. The only writer of
`documents.metadata.linked_offer_id` on a packet row is
`app/api/agent-assistant/tool-call/route.ts:1051` (the ElevenLabs voice cockpit).
`lib/documents/upload-document.ts:69` writes the key too, but with
`document_type` defaulting to `'uploaded_document'`, so it does not match.
`offers.metadata.linked_document_id` — the reverse link named in the comment at
tool-call/route.ts:1009 — **is never written by anything.**

Consequence, stated plainly: with D1 fixed, an offer whose packet was staged by
any path other than the voice cockpit will be REFUSED at compliance, because
nothing links its packet to the offers row. **This is a wiring gap in files
outside this slice's scope and it must be closed before rollout** — see
"Required follow-up" below. I did not soften the gate to hide it: a gate that
passes because it could not find the paperwork is the defect being fixed, and
the refusal is loud, actionable, and reaches the TC and the agent, which is
precisely the owner's step 4.

**C4 — `scanListingPacketCompleteness`'s lookup matches a key nothing writes.**
It finds the listing packet by `metadata->>linked_listing_id`. All three
listing-agreement staging paths (`draft-listing-from-voice.ts:147`,
`tool-call/route.ts:804`, `api/workflow/intake/listing/route.ts:117`) write
`brokerage_id / contact_id / document_type / status / state_code / metadata /
content` and **no listing link at all** — neither the metadata key nor the
`listing_id` column. `lib/compliance/required-documents.ts:244` already carries a
comment recording that `linked_listing_id` is "a key nothing in the codebase
writes", and that audit was fixed to match both forms; the packet scanner was
not. So the listing packet gate always takes the `!doc` branch and returns
`success: true, completionPercent: 100, blockers: []`. It is a permanent no-op
that reads as a pass. I did NOT change that lookup: widening it to the
`listing_id` column would start matching agent-uploaded PDFs, which legitimately
have no `filledPacket`, and the paper-signing path is a deliberate design in that
function. It needs the listing checkpoint's owner, not this slice.

---

## D1 — the fix shape, and why

The brief offered (a) caller reads `success === false`, (b) scanner returns a
real blocker, (c) both. **I chose (c), and the load-bearing half is (b).**

`blockers` is the field every consumer reads, the field that decides the
refusal, and the field that fans out to the TC and the agent. `success` is a
field a caller has to remember to check. Putting the failure in `blockers` means
the next consumer written against this scanner fails closed *by default* — it
cannot repeat the mistake even if it reads nothing else. `success` is then read
at the gate as well, so a future change that reports a fault without a finding
still cannot pass, and so the refusal message can name the reason
(`packet check could not run (...)`) the way the listing checkpoint does.

Four exits now return `success:false` **and** one critical blocker whose `body`
says what to do:

| exit | title | remedy in the body |
|---|---|---|
| invalid id | offer/user id is not valid | reopen the offer from the deal file and submit from there |
| documents read refused (`error` destructured — supabase-js RESOLVES a refused query) | document store could not be read | system fault; retry, escalate before resubmitting |
| no staged document | no offer packet is staged against this offer | stage the completed forms against this offer in the Form Wizard, then resubmit |
| document parses to no packet (C2) | the staged offer packet could not be read | re-stage the packet, then resubmit |

None of them claims `completionPercent: 100`. An unread packet is 0% verified,
not "a packet with nothing outstanding" — those are only the same number when
nobody looked.

The refusal reaches people on the **existing** path: because the reason is a
blocker, the gate's existing `notifyComplianceFlag(... alsoNotifyUserIds:
dealRecipients ...)` fan-out fires unchanged — the offer's agent (RESOLVED
`agents.id` → `users.id`), the listing agent, plus the TC and compliance officer
from the brokerage roster inside the helper. The blocker bodies are appended to
that flag as `What to do: …` and to the returned `error`, so the refusal tells
the TC and agent what to finish rather than only what is wrong.

The same class-fix was applied to `scanListingPacketCompleteness`'s two
unrunnable exits (invalid id, unreadable store). It changes no verdict there —
`markAgreementSigned` already refuses on `!success` — but it stops the next
consumer of that summary from having to know that `blockers: []` can mean
"nobody looked". The `!doc` branch is deliberately left as a non-blocking
observation: that is the paper-signing path, documented in the function.

---

## D3 — what the data can and cannot support

**The packet cannot assert "both sides", and no amount of care at the analyzer
makes it able to.** The evidence, read out of the fill engine:

1. `lib/workflow/intake/form-fill-engine.ts:fillStateAssociationForm` builds
   `filledFields` by walking the intake object's own keys (line 313-317: with no
   learned mapping, `formField = intakeField`). `unfilled` is populated from a
   **hard-coded list of four names** (line 328):
   `["buyerLegalName", "propertyAddress", "offerPrice", "closeDate"]`.
   None of the four contains "signature" or "initial", so
   `classifyMissingField` can never return `missing_signature` on a
   state-association form. **The critical-severity branch is unreachable on that
   path.**
2. `lib/workflow/intake/voice-to-offer.ts:OfferIntake` has **no seller party
   field at all** — the only "seller" key on it is `sellerConcessionAmount`. So
   no seller-side field can appear in an offer packet's filled fields either.
3. The only source of signature-named fields is
   `fillBrokerageForm`, whose names come from
   `brokerage_form_library.field_schema` — arbitrary brokerage-uploaded strings.
   `loadBrokerageForms` swallows any error and returns `[]`, and pre-rollout the
   table is empty.

So a rule of the form "refuse unless the packet contains a seller-side signature
block" would refuse **every packet the product can build today**, and a rule that
guesses a side from names the tree does not emit would be inventing a
convention. Both were rejected.

### What I shipped instead

**The side is made explicit as DATA, read out of the field name and never
inferred**, using the party vocabulary the tree already uses
(`form-fill-engine.ts:HEURISTIC_PATTERNS` matches `buyer|purchaser` and
`seller|grantor`):

- `PacketScanFinding.side` — a missing signature/initial blocker now carries its
  side, and the title says it: *"Seller signature block missing on X"*. That is
  the missing piece the owner's step 4 sends back, named.
- `PacketAnalysis.signatureSides: Record<"buyer"|"seller"|"unspecified",
  { evidenced, outstanding }>` — what the packet was *able to show* per side.
  `evidenced: false` means the packet said nothing about that side. That is
  **silence, recorded as silence**, and it is the whole point: a buyer-only
  packet with zero blockers now reports `seller.evidenced === false` instead of
  looking identical to a fully-signed one.
- `unspecified` is returned in **both** directions of doubt: no party token, or
  more than one (`buyer_and_seller_initials` is evidence for neither side,
  because signing it proves nothing about which party did). Proving "both sides"
  requires two separately-named blocks — the only thing that actually proves two
  signatures.

The analyzer **reports; it does not decide** — deliberately, because "both
sides" means different parties at the two checkpoints (buyer + seller for an
offer; seller + listing broker for a listing agreement). Each gate applies its
own rule to the same evidence. This is also why the shared analyzer's behaviour
for the listing checkpoint is unchanged: `signatureSides` is additive, blocker
counts and severities are untouched, and `test:compliance-checkpoints` stays
green at 29/29.

### At the offer gate

The "both sides" assertion lives where the evidence actually is — the offer row
— and it is now **explicit and recorded** instead of implicit:

- refusal already enforces buyer `buyer_signed_at` plus an executed contract by
  one of the two named paths; that is both sides, from columns;
- `emitCompliancePassed`'s `scanResults` now carries `both_sides`, naming **the
  column that established each side**, whether the packet corroborated it, which
  sides it could not show, and the raw per-side evidence — so no later reader of
  the gate row can mistake a column check for a field-by-field signature check;
- a **one-sided** packet (it carries signature blocks, and one side's are simply
  not in it — the exact D3 scenario) fires the existing
  `compliance.submit_warnings` flag to the TC and the agent, naming the absent
  side and telling them to confirm it on the executed contract.

A packet carrying **no** signature blocks at all does not fire a per-deal
warning: that is currently every packet the fill engine builds, so notifying it
per deal would be a bell that always rings and therefore teaches people to
ignore it. It is recorded on the gate row instead, where it is durable and where
a reader is asking what was verified. That is a judgement call and it is the one
place in this slice where a fact is recorded rather than pushed; it is stated
here so it can be overruled.

### What would be needed to make the packet answer it properly

1. `OfferIntake` gains the seller party (`sellerLegalName`, `coSellerLegalName`,
   `sellerEntity`) — `ListingIntake` already has them.
2. `FilledForm` gains a signature-block inventory rather than inferring one from
   field names: `signatureBlocks: Array<{ fieldName, role: "buyer" | "seller" |
   "listing_broker" | ..., signed: boolean }>`, emitted by the fill engine from
   the form's real field schema, and by the e-sign provider's **recipient roles**
   on the executed envelope (which are authoritative and already exist upstream —
   `lib/esign-webhooks/download-signed-package.ts:125` carries `signers`).
3. Then `analyzeFilledPacket` reports per-role coverage from declared data and
   the gate can refuse on a genuinely absent seller block, with no name-guessing
   anywhere in the chain.

---

## Required follow-up (outside this slice's file scope)

1. **Cross-link every offer-packet staging path** (C3). Until this lands, only
   the ElevenLabs voice cockpit produces a packet the gate can find, and every
   other offer will be refused. Fix at `draft-offer-from-voice.ts` and
   `ai-offer-creation.ts:generateOfferDraft` (which should also **spread**
   existing `metadata` rather than replacing it, and stop overwriting
   `content` with a shape that drops `filledPacket` — C2).
2. **Give the listing packet scan a link that something writes** (C4).
3. `app/components/offer/offer-agent-actions.tsx:runScan` shows only
   `json.error` on a failed pre-flight scan; the actionable remedy now lives in
   `blockers[0].body` and should be surfaced there too.

## Proof

`scripts/offer-packet-gate-simulator.ts` → `npm run test:offer-packet-gate`,
wired into the `guard` chain after `test:compliance-ledger`.

Constructs, not spellings:

- behaviour, against the real pure analyzer: side read from the name, both
  directions of doubt → `unspecified`, a buyer-only packet records
  `seller.evidenced === false`, an outstanding seller signature is CRITICAL and
  carries `side === "seller"`, the two sides do not produce the same sentence;
- behaviour, against the shape the fill engine really builds: a
  state-association packet produces no signature findings at all and shows
  neither side — the D3 evidence above, made executable;
- structure, resolved through the enclosing object literal so re-wording cannot
  fake it: **no summary in the packet-scan module reports `success: false`
  together with an empty blocker list**, none claims 100% completion, and both
  document lookups destructure `error`;
- structure, resolved through whichever identifier the code binds
  `packetScan.success` to (so a rename cannot fake it): **the gate's refusal
  branch depends on it**, fans out on the shared `notifyComplianceFlag` path
  with `dealRecipients`, and carries the blocker bodies.

### Negative controls (all three: red, then restored green)

| bug reintroduced | result |
|---|---|
| `unrunnableScan` returns `blockers: []` | 26 passed, **2 failed** — "not one of them reports an empty blocker list", "each carries at least one finding of its own" |
| gate condition back to `hasBlockingMissing \|\| hasPacketBlockers` | 27 passed, **1 failed** — "the refusal branch depends on it", printing the condition it found |
| `classifyFieldSide` always returns `unspecified` | 21 passed, **8 failed** across both side sections |

Restored: 29 passed, 0 failed.
