# Wave 10 — slice: the inbound offer (F1 + F2)

Scope: `lib/buyer-offer/buyer-signature-evidence.ts` (new),
`lib/inbound-mail/offer-intake.ts`, `lib/inbound-mail/offer-detect.ts` (its pure
half — the filing plan lives there), `app/actions/buyer-offer/record-seller-response.ts`,
`app/actions/buyer-offer/submit-to-compliance.ts`,
`scripts/inbound-offer-lane-simulator.ts` (new proof, wired into `guard`).

The owner's ruling governs:

> there are times that an offer comes in from an outside buyers agent for a
> listing in house and won't be created from the wizard and those contracts need
> to be executed and signed from the seller and then submitted and read and
> checked through the compliance gate. some documents won't be one of ours and
> submitted from the outside buyer and need to be read and counted in the
> transaction paperwork.

---

## What I confirmed in the audit

**F1 is real and is exactly as described.** `offers.buyer_signed_at` has exactly
one product writer in the tree: `lib/esign-webhooks/finalize-packet.ts` at 243
(counter fully executed) and 258 (buyer-first). The only other assignment
anywhere is `scripts/e2e-lead-to-transaction.ts:181`, a seed. Grep over the
column returns readers everywhere and no third writer.

**Both refusals named in the brief are real,** and there is a THIRD the brief
does not mention: `lib/transactions/offer-bridge.ts:62`
(`assertOfferReadyForTransaction`) refuses on `!o.buyer_signed_at` with
"buyer has not signed yet". So the inbound lane could not have produced a
transaction even if both action-level gates had been softened — which is one of
several reasons the fix had to be at the COLUMN's evidence, not at the gates.

**F2 is real.** `tryIngestInboundOffer` wrote to storage, set
`offers.offer_document_url`, and created no `documents` row.
`auditOfferDocuments` counts only `documents` (by `metadata.linked_offer_id` at
line 172, or the buyer contact at 183). So the outside contract could not be
counted.

**`lib/documents/upload-document.ts` fits, and is the right survivor.** It takes
a `storageUrl` (not bytes), writes `metadata.linked_offer_id` — the exact key the
audit reads — and kicks `scan-uploaded-document.ts`, which produces the
`classification` the audit counts plus `signature_completeness`. The inbound path
now calls it. No second ledger was grown, and no part of it was duplicated.

---

## What I CORRECTED

**C1 — the branch the owner's scenario actually takes is CONFIRM, and it stored
NOTHING AT ALL.** The audit describes the AUTO path ("uploads the PDF … inserts an
offers row … Obligation 1's INTAKE is built"). But `offer-detect.ts:assessOfferIntake`
returns `auto` only when `senderIsKnownContact` — and an OUTSIDE BUYER'S AGENT is
by definition not a known contact. The repo's own existing proof states it:
`scripts/offer-email-intake-simulator.ts:36` — *"offer + listing + UNKNOWN buyer
(outside agent) → confirm"*.

The confirm branch inserted a notification and returned `handled: true`. In
`app/api/webhooks/inbound-mail/route.ts:206` that makes the webhook `continue`
**past its own generic `uploadDocument` loop** further down the same function. So
for the exact case the owner ruled on, the outside buyer's executed contract was
uploaded nowhere, filed nowhere, and read by nothing. The notification told the
listing agent to "review and upload it" — a file the system had just discarded.
Obligation 4 was not merely uncounted on that path; the paper was destroyed.

Fixed: the confirm branch now files every attachment through `uploadDocument`
against the LISTING (`documents.listing_id` — the link `auditListingDocuments`
reads on that side), marked `awaiting_offer_link`, and the notification says how
many are already filed and being read, or names the error if filing failed.

**C2 — filing the inbound contract as `document_type:'offer'` would have refused
100% of inbound offers.** This was the first shape I reached for and it is a trap.
`'offer'` is the key `scan-offer-packet.ts:179` finds a STAGED PACKET by. An
inbound PDF has no `content.filledPacket`. Since wave 9, a staged document that
parses to no packet is `scanOutcome: "fault"` — and `submit-to-compliance.ts`
refuses on a fault. So filing inbound contracts under that type would have taken
every inbound offer from "dead-ended before compliance" to "refused AT
compliance, with a critical blocker fanned out to the TC". The rows are filed
under their own types (`inbound_offer_contract` / `inbound_offer_attachment`) and
reach the audit through `classification`, which is what `auditOfferDocuments`
actually counts. `STAGED_PACKET_DOCUMENT_TYPE` is exported and the proof asserts
the plan never uses it, so nobody can re-introduce this by hand.

**C3 — only `pdfs[0]` was ever touched, on both paths.** An outside agent's email
carries the contract plus addenda, disclosures and the pre-approval. The brief
asked for the class; the class was one line wide. `planInboundFiling` now emits
one entry per PDF and the loop is driven by it.

**C4 — the email lane is not the only outside-offer lane, and the other one is
outside this slice's scope.** `app/api/offers/upload/route.ts` is the listing
agent uploading an outside buyer's agent's PDF by hand — and it has the *identical
pair of defects*: no `documents` row, no `form_source`, no possible
`buyer_signed_at`. In practice it is the MORE likely path (the agent receives the
contract in their own inbox and uploads it). It is a two-call fix against the two
functions this slice added; see "Required follow-up".

**C5 — nothing in the schema marks an offer as inbound today, and the column that
means it already exists.** Checked against the live schema (project
`hrvaqgvukzxfskkcrwbt`) rather than assumed:

| column | live shape | who writes it |
|---|---|---|
| `form_source` | text, nullable, CHECK `portal_upload \| dotloop \| docusign \| skyslope \| authentisign \| in_app \| manual` | ONLY `app/actions/buyer-offers.ts:641` (the wizard) and `tool-call/route.ts` (`in_app` / provider name) |
| `offer_type` | text, default `'standard'`, CHECK `standard \| counter \| backup \| multiple_counter` | means the offer's ROLE in the negotiation, not its origin |
| `esign_provider` | text, CHECK `dotloop \| docusign \| skyslope \| authentisign \| in_app` | the platform NAME of an envelope WE sent |
| `offer_document_url` | text | a stored PDF — true of inbound AND of any uploaded packet |
| `metadata` | jsonb NOT NULL default `'{}'` | free |

So `form_source` is already the column that means "where did this paperwork come
from", `manual` is already its value for paperwork our form engine did not
produce, and **both** outside lanes simply left it NULL. **No column was added and
no CHECK value was invented.** The email lane now writes `form_source: 'manual'`,
and `isOutsideOriginated()` falls back — for the rows that predate this and for
the upload route until it is fixed — to "no envelope of ours, but a document on
file". `test:check-vocabulary` confirms the value is one the database admits.

---

## F1 — the evidence design, and the evidence for it

### The shape

`offers.buyer_signed_at` is a statement about the WORLD ("the buyer signed, on
this date"), not about our webhook. The defect was that only ONE kind of evidence
was ever allowed to establish it. So the column now has exactly **two admissible
sources**, and every gate records which one was used:

1. `our_esign_envelope` — the provider told us the envelope completed.
   `finalize-packet.ts`, untouched.
2. `attested_executed_contract` — a NAMED HUMAN in the deal's brokerage states,
   at a recorded time, that the executed contract ALREADY ON FILE carries the
   buyer's signature, and gives the date it bears.

**Nothing about "both sides signed" was weakened.** All three refusals
(`record-seller-response`, `submit-to-compliance`, `offer-bridge`) still require
the column, unchanged, and `offer-bridge` did not need to be touched at all —
which is the point of fixing the evidence rather than the gates.

### Why a human attestation and not the AI

The brief asked what the AI can establish for a document we did not send. Read out
of the tree:

- **`lib/offers/offer-extractor.ts:extractOfferFromPdf` — the extractor that
  already runs on exactly these PDFs — cannot establish a signature at all.** Its
  prompt schema has 17 keys (`offer_price`, `earnest_money`, `closing_date`,
  financing, contingency days, escalation, possession, notes). Not one concerns a
  signature, a signer, or an execution date. Making it answer would be ADDING a
  capability and then trusting it, not reading one that exists.
- **`lib/documents/scan-uploaded-document.ts` DOES ask a vision model for
  `signature_completeness`** (`{signatures:[{signer_role, signer_name, signed}],
  initials:[{signer_role, all_required_initials_present}]}`), and
  `lib/compliance/signature-completeness.ts:evaluateExecution` is the canonical,
  already-proven predicate over it. That is a real reading — but the scanner's own
  prompt concedes its standing: *"Do NOT infer a signature from a typed name, and
  do NOT report a party you cannot find a signature block for — an unverifiable
  signature must read as missing."*

So the AI is used in the only direction it is safe in. `evaluateExecution(blob,
["buyer"])` runs on the attested document and is **recorded beside the
attestation as `ai_corroboration`, deciding nothing**:

- no blob ⇒ `checked:false, executed:null`. **Silence recorded as silence** — it
  must never read as agreement, and it must never read as contradiction either,
  because `evaluateExecution` returns "not executed" for a blob it never got.
- blob agrees ⇒ `checked:true, executed:true`. Corroboration, on the record.
- blob disagrees ⇒ the attestation **stands** (a person holding the contract
  outranks a model reading a scan, and a veto here would block honest deals on a
  bad OCR), but the disagreement fires the EXISTING `compliance.submit_warnings`
  flag to the TC and the agent with the words *"the document scan could not find
  the buyer signature that was attested"*. Discovering that after closing is the
  outcome worth spending a bell on.

### What actually protects the fact

The attestation is deliberately **not gated on `isOutsideOriginated`**. Gating an
escape hatch on a heuristic mints a second permanent dead-end the moment the
heuristic is wrong about a deal — which is the defect class being closed. The
origin is RECORDED on every attestation instead. What protects it is stronger and
checkable:

- the attestor must be a **real `users` row in the offer's brokerage** (resolved
  to a name, not left as an id nobody can read; `users.id` never crossed with
  `agents.id`);
- **the executed contract must already be on file** — a `documents` row linked to
  THIS offer (`metadata.linked_offer_id`), or failing that
  `offers.offer_document_url` / `seller_response_document_url`. A named document
  belonging to another offer or another brokerage is refused. *This is why F2 is a
  precondition of F1 and not a separate nicety: before this slice, an inbound
  offer had no document row to attest against.*
- the signature date may not be in the future (60s skew, no more);
- the statement must be **words**, not a click;
- **machine evidence is never overwritten.** An offer whose `buyer_signed_at` is
  already set returns `already_established` and writes nothing — idempotent, and
  a second attestation can never rewrite the first one's date or author.

### The write, and the class the brief warned about

`offers.metadata` is a live jsonb column. The evidence record is **merged** into
it, never assigned wholesale — the same class wave 9 found in `generateOfferDraft`,
which replaced a document's metadata and destroyed the only key the packet scan
could find it by. The proof reintroduces exactly that bug as a negative control.

Every read and every write destructures `error` and fails closed. A lost audit
row is reported as a FAILURE whose message says the offer IS stamped, so an agent
does not attest twice — and a retry is safe, because it lands on the
already-established branch.

### The event name

`buyer.offer.signature.attested`, spelled in ONE module — deliberately NOT added
to `OFFER_EVENT`. That map is the state machine and `EVENT_TO_STATE` /
`EVENT_TO_STATUS` are total records over it, so any name added there must invent a
state AND a status. Recording how a signature was evidenced changes neither. Same
reasoning, and same precedent, as `buyer.offer.compliance.passed` in
`compliance-gate.ts`.

### At the gate — extending wave 9's vocabulary, not forking it

`submit-to-compliance.ts` now resolves `describeBuyerSignatureEvidence(offer)`
instead of testing the raw timestamp, refuses when it is null (with the shared,
actionable wording), and the gate event records:

- `both_sides.buyer.established_by` — the SOURCE, not the column name, plus the
  whole evidence record (who, when, which document, the AI reading);
- `packet_checked.buyer_signature_source` and
  `packet_checked.buyer_signature_established_by`, sitting next to wave 9's
  `both_sides_established_by`.

Wave 9's own vocabulary is untouched: `both_sides_established_by` still reports
`packet_field_scan + executed_contract_columns` / `executed_contract_columns_only`,
because that names the ALTITUDE the check ran at, which is a different axis from
what put the timestamp in the column. `test:offer-packet-gate` stays green at
32/32.

---

## F2 — how the outside documents now reach the count

`lib/documents/upload-document.ts:uploadDocument` — the universal uploader, the
same one `record-seller-response.ts` uses — is called for **every** inbound PDF on
**both** branches. It creates the `documents` row (with
`metadata.linked_offer_id`, `listing_id`, `contact_id`) and kicks
`scan-uploaded-document.ts`, so each file gets a `classification` (which is what
`auditOfferDocuments` counts), a summary, extracted fields, a
`signature_completeness` reading, and the field-extraction / deadline-derivation
hooks that follow it. Nothing here re-implements either half, and
`offer-intake.ts` contains no `documents` insert of its own — the proof asserts
both.

| branch | before | now |
|---|---|---|
| AUTO (buyer is a known contact) | `pdfs[0]` → storage + `offers.offer_document_url`; zero `documents` rows | every PDF → `documents`, keyed to the offer, listing and contact; the contract's already-uploaded URL is reused rather than storing the same bytes twice |
| CONFIRM (**the outside buyer's agent**) | nothing stored, webhook skips its own uploader | every PDF → storage + `documents` against the listing, marked `awaiting_offer_link`; the notification says how many are filed, or names the failure |

Filing is best-effort **per file** and never throws into the webhook: one
unreadable attachment must not cost the deal the other four. Every failure is
returned and logged, never swallowed — pre-rollout these tables are empty, so "no
documents came back" can never be read as health.

---

## Deletions

**None.** Nothing in this slice was a duplicate. `planInboundFiling` was moved out
of `offer-intake.ts` into `offer-detect.ts` — the lane's existing PURE half, which
`offer-intake.ts` already imports and which the existing `test:offer-email-intake`
proof already drives — rather than adding a second module for it. That also let
the new proof drop `--conditions=react-server`, since `offer-detect.ts` carries no
`server-only` barrier.

---

## Required follow-up (outside this slice's file scope)

1. **`app/api/offers/upload/route.ts` — the OTHER outside-offer lane (C4).** It is
   the same two defects and now a two-call fix: pass `form_source: 'manual'` on
   the insert, and call `uploadDocument({ brokerageId, storageUrl: publicUrl,
   fileName: file.name, documentType: 'inbound_offer_contract', contactId,
   offerId: offer.id, listingId })` after it. Until it lands, offers created that
   way are still counted by `isOutsideOriginated`'s NULL fallback (they have a
   document and no envelope), so the refusal wording is right — but their contract
   still reaches no `documents` row, so the attestation will refuse them for want
   of a document to attest to. **This should land before rollout.**
2. **A surface for the attestation.** `recordSellerResponse` accepts
   `buyerSignature { signedAt, attestation, documentId?, attestorUserId? }` and
   returns `needs_buyer_signature_attestation: true` on the refusal it belongs to,
   so a caller can prompt instead of showing a dead end.
   `app/components/offer/offer-agent-actions.tsx:recordAccepted` (the one button in
   front of this action) does not yet read that flag — it is a UI file and outside
   this slice. Until it does, the agent sees the actionable refusal text but
   cannot answer it from that panel.
3. **Link the confirm-branch documents to the offer when the agent ingests it.**
   They carry `metadata.awaiting_offer_link` and a `listing_id`; whichever surface
   turns a confirmed inbound email into an offer row should stamp
   `metadata.linked_offer_id` on them so they count toward THAT offer rather than
   only the listing.
4. **`signedDocUrl` returns `""` on failure** and `tryIngestInboundOffer` then
   returns `handled:false` *after* the bytes are already in the bucket — an
   orphaned object. Pre-existing, untouched, noted.

---

## Proof

`scripts/inbound-offer-lane-simulator.ts` → `npm run test:inbound-offer-lane`,
wired into the `guard` chain immediately after `test:offer-packet-gate`, and owned
by `compliance_officer` via `MAINTENANCE_DOMAINS.inbound_offer_lane`
(`test:proof-ownership` passes).

Constructs, not spellings. **62 assertions, 0 failed.**

- **behaviour, against the real pure readers**: a NULL column yields NO evidence
  (a signature is never invented); a set column with no record names the only
  other writer AND marks itself `recorded:false`; a stored attestation reports its
  author; the two sources never produce the same sentence; the origin predicate
  answers from the live CHECK vocabulary in both directions and its NULL fallback
  turns on the envelope, not on hope; the outside refusal differs from ours, names
  the attestation, and does not tell anyone to wait.
- **behaviour, driving the REAL writer against an injected stub store** (no
  credentials, no live rows, so "nothing came back" is never health): every
  refusal — blank statement, future date, unparseable date, cross-brokerage
  attestor, non-existent attestor, no contract on file, a document belonging to
  another offer, a document in another brokerage — and each one asserts the column
  was NOT stamped; refused read / refused update / refused insert each fail
  closed with their own honest message; an already-signed offer writes nothing;
  the success path stamps the ATTESTED date, records who + when + which document +
  the verbatim statement, **preserves pre-existing `offers.metadata` keys**, and
  writes an audit row keyed `entity_type='offer'` + `entity_id` with the tenant
  and with `agents.id` / `users.id` never crossed.
- **behaviour, the AI's standing**: unscanned ⇒ `checked:false`; agreeing scan ⇒
  recorded; **disagreeing scan does not veto the human**, and the disagreement is
  recorded with what the scan says is missing.
- **behaviour, the filing plan**: every attachment planned (not just the first);
  the contract distinguishable from its attachments; **nothing planned under
  `STAGED_PACKET_DOCUMENT_TYPE`**, compared against the real exported constant;
  one PDF ⇒ one entry; zero PDFs ⇒ no invented row.
- **structure, resolved through whichever identifier the code binds** (so a rename
  cannot fake it): intake reaches the universal uploader and writes no `documents`
  insert of its own; the filing helper is called on BOTH branches (call sites
  counted through the bound name); the origin is recorded on `form_source`;
  `record-seller-response` binds the signature fact to a variable the attestation
  can move AND still refuses on it; `submit-to-compliance` binds the EVIDENCE and
  refuses on it; the gate event records the buyer's evidence source; wave 9's
  `both_sides_established_by` vocabulary is left intact.

### Negative controls (all five: red, then restored green)

| bug reintroduced | result |
|---|---|
| `attestBuyerSignature` assigns `offers.metadata` wholesale instead of merging | 61 passed, **1 failed** — "existing offers.metadata keys SURVIVE — the blob is merged, not replaced" |
| `planInboundFiling` files everything as `document_type:'offer'` (C2) | 60 passed, **2 failed** — "NOTHING is filed under the staged-packet document_type", "the contract is still distinguishable from its attachments" |
| `record-seller-response` refuses on the raw `offer.buyer_signed_at` again, so an attestation cannot move it | 61 passed, **1 failed** — "…and still REFUSES when nothing established it" |
| the AI corroboration made decisive — a scan that cannot find the buyer signature vetoes the attestation | 60 passed, **2 failed** — "a scan that could not find the buyer signature does NOT veto the human…", "…but the disagreement is recorded" |
| the CONFIRM branch files nothing again (C1) | 61 passed, **1 failed** — "…and it is called on BOTH the confirm and the auto branch — call sites found: 1" |

Restored: 62 passed, 0 failed.

(The fourth control initially crashed the proof rather than failing it cleanly —
the assertions read `offers.metadata[KEY]` unguarded. Hardened to optional access
so a regression REPORTS instead of throwing, then re-run: clean red, then green.)
