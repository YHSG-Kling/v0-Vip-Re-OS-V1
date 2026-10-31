# Wave 11 — slice: the listing packet + the inbound link (L3 + L4 + L5)

Scope: `lib/workflow/intelligence/scan-offer-packet.ts`,
`lib/inbound-mail/offer-detect.ts`, `lib/inbound-mail/offer-intake.ts`,
`app/api/offers/upload/route.ts`, `app/components/offer/offer-agent-actions.tsx`,
`scripts/offer-packet-gate-simulator.ts`, `scripts/inbound-offer-lane-simulator.ts`,
`scripts/compliance-checkpoints-simulator.ts` (one assertion hardened — see below),
`lib/kernel/manager-registry.ts` (two existing entries extended),
`package.json` (both proofs now run under `--conditions=react-server` so they can
drive the REAL writers).

**No new proof script was added**, so no new `MAINTENANCE_DOMAINS` entry was
needed: the work extends `test:offer-packet-gate` and `test:inbound-offer-lane`,
both already owned by `compliance_officer` (`test:proof-ownership` passes,
309 unowned = baseline).

---

## Confirmed

**L3 is real and is exactly as the audit describes.**
`scanListingPacketCompleteness` found its document by
`document_type='listing_agreement'` + `metadata->>linked_listing_id`. Grep over
the whole tree returns **no writer of `linked_listing_id`** — the only mentions
are the two readers (`required-documents.ts:264`, this scanner) and the comments
recording that fact. So the `!doc` branch fired every time and returned
`success: true, completionPercent: 100, blockers: []` — a permanent no-op that
read as a full pass at the checkpoint that decides whether a listing may be
taken on (`markAgreementSigned` refuses on `blockers.length > 0 || !success`, and
neither could ever be true).

**L4 is real.** `offer_intake_review` (the confirm-branch notification) has no
consumer anywhere in the tree, and no surface ever wrote `linked_offer_id` onto
the rows the confirm branch files with `awaiting_offer_link`.

**L5 is real.** `runScan` reported `json.error` only, while
`app/api/offers/[offerId]/packet-scan/route.ts` returns the **whole summary**
(blockers included) on the 400 as well as the 200.

**Wave 10's follow-up #1 has already landed** in `app/api/offers/upload/route.ts`
(`form_source: 'manual'` + `uploadDocument(... INBOUND_CONTRACT_DOCUMENT_TYPE)`).
I did not redo it.

---

## CORRECTED — and this is the one that would have blocked deals

### C1 — the obvious L3 fix refuses 100% of AI-staged listing agreements

The brief's shape is right (find the packet, refuse an unrunnable scan) but the
offer side's *rule* cannot be copied across, because of a defect on the listing
side that no prior wave checked for:

`app/actions/ai-listing-intake.ts:generateListingAgreement` (1275-1297)
**overwrites the staged document's `content`** with its own prefill shape —
`{ packet_type, state, forms, prefilled, needs_agent_input, formwizard_url }`,
**no `filledPacket`** — and replaces `metadata` wholesale. It is called
immediately after the insert on **both** staging paths:

| staging path | writes `content = {filledPacket, intake}` | then calls the generator |
|---|---|---|
| `app/actions/voice-assistant/draft-listing-from-voice.ts` | 163 | 178 |
| `app/api/workflow/intake/listing/route.ts` | 130 | 150 |

This is the exact twin of wave 9's C2 (`generateOfferDraft`), which wave 9 found
on the OFFER side and never checked for on the listing side. Consequence: **the
field-level packet is gone from every listing agreement this product stages,
every time, by design and not by corruption.**

So if the widened lookup had applied the offer side's rule — "a staged document
that carries no `filledPacket` is a FAULT" — every listing staged through the
voice/intake lane would have been **refused at `markAgreementSigned`**, which
refuses on `!success`. Fixing the lookup without noticing this would have turned
a silent pass into a total outage on the flagship listing lane.

**The listing side therefore needs a different answer from the offer side, and
here is the evidence-backed reason:** on the offer side, the no-packet exit is
`no_packet_staged` for "no row at all" and `fault` for "a row with no packet",
and the gate can afford the fault because the offer's own executed-contract
columns carry the deal. On the listing side the *known, deliberate, in-tree*
shape of a staged packet's content **is** the generator's prefill shape, so that
shape is reported as `no_packet_staged` — non-blocking, with the document named
and the reason recorded in `error`. **A shape nothing in this tree writes is
still a `fault`**, so genuine corruption still refuses; no in-tree writer can
reach that branch, which is exactly why it cannot block an honest deal.

### C2 — what a STAGED LISTING PACKET is actually keyed by

Read end to end, the answer is: **the seller contact, and nothing else.**

Both staging inserts write `brokerage_id`, `contact_id` (the seller),
`document_type`, `status`, `state_code`, `metadata.packet_type` and `content`.
**Neither writes any listing link at all** — not `metadata.linked_listing_id`,
not the `listing_id` column — and they cannot: on the voice/intake lane the
packet is staged *before* a listing row exists (`/dashboard/listings/new?documentId=…`
is where the agent goes next). The two surfaces that later create the listing —
`FormWizard.handleSubmitListing` → `listings-kernel.ts:createListingWithSellerContact`,
and the `compliance-listing-auto-create` chain — **never write the document
back**, so the link is never created afterwards either. Both are outside this
slice's file scope; see "Required follow-up".

The lookup now tries, in order, all pinned to the caller's brokerage:

1. the **`listing_id` COLUMN** — what `lib/documents/upload-document.ts` writes,
   and the form `required-documents.ts:242` was fixed to match;
2. **`metadata->>linked_listing_id`** — still honoured for anything ever written
   that way;
3. the **seller contact** from the listing row (`seller_contact_id ?? contact_id`),
   restricted to rows with no `listing_id` of their own — an unlinked packet may
   be this listing's, a packet linked elsewhere never is — and rejected on a
   `state_code` that disagrees with the listing's state, because one seller can
   list two properties.

### C3 — wave 9's reasoning is preserved by a property of what a packet IS

Wave 9 declined to widen this lookup because it would start matching
agent-uploaded PDFs, which legitimately carry no `filledPacket`, and the paper
path must not be refused. **That reasoning is sound and is now enforced
structurally rather than by narrowness**, with a discriminator that separates the
two populations by what they are rather than what they link to:

```
storage_url IS NULL  AND  metadata->>packet_type IS NOT NULL
```

Every staging path writes `metadata.packet_type` (`'listing'` from the two
inserts, `'listing_agreement'` from the generator's overwrite) and none writes a
`storage_url`, because a staged packet is form data and not a file.
`upload-document.ts` is the mirror image: it **always** writes a `storage_url`
and **never** writes `packet_type`. The agent's own upload door
(`app/api/listings/[listingId]/upload-document`) accepts a `docType` hint of
`listing_agreement`, so without this discriminator a signed listing-agreement PDF
filed against the listing **would** have been adopted as a packet and refused as
a fault — the negative control below shows exactly that, 4 assertions red.

### C4 — the listing scan was not tenant-scoped at all

The old query filtered on `document_type` and a metadata key and **nothing
else** — no `brokerage_id`. Every candidate lookup is now pinned to the caller's
brokerage, and a `listingId` that does not belong to it is a **fault**, not an
empty result. (This mattered more once the contact branch existed, but it was
already wrong.)

### C5 — the L4 mis-link is a real hazard, and it is decided by a pure function

Two outside agents can email offers on the **same listing**; both sets sit there
with `awaiting_offer_link`. Stamping every pending row on the listing with the
first offer created would count **another deal's paperwork** toward this one —
worse than the gap being closed, because it is invisible and it *passes* a gate.

`offer-detect.ts:planInboundOfferLink` (pure, proven) groups the pending rows by
**sender** — the deal boundary an email lane actually has — and links a group
only when something identifies it:

| input | rule |
|---|---|
| `preferFromEmail` (the AUTO branch knows the sender) | **authoritative**: only that sender's rows link; if that sender is not waiting, **nothing** links, even when exactly one other group is |
| `preferFileName` (the manual route: the agent uploads the PDF that arrived) | the group containing a matching attachment name |
| exactly one sender waiting | that group |
| anything else | **nothing is linked**, `ambiguous: true`, and the senders are returned |

### C6 — a spelling assertion in a neighbouring proof had to be hardened

`scripts/compliance-checkpoints-simulator.ts:161` asserted "both scans call the
shared analyzer" by matching the two **argument expressions verbatim**
(`analyzeFilledPacket(filledPacket)` / `analyzeFilledPacket((parsed?.filledPacket`).
Re-binding the packet to a differently-named local — all this slice did on the
way to fixing the lookup — read as "the shared rule was abandoned". It now
splits the module at the listing scan and asserts each half reaches the analyzer,
whatever it hands it. Negative-controlled: stubbing out the listing analyzer call
turns it red (28/1), restoring it green (29/0).

---

## Where the inbound link is completed, and how the match is scoped

The surfaces that turn a confirmed inbound email into an offer row are exactly
two — `offers` has only these product writers besides the buyer-side wizard
(`buyer-offers.ts:createOffer`) and the voice cockpit:

1. **`app/api/offers/upload/route.ts`** — the agent picks the buyer and uploads
   the contract. **This is the surface the `offer_intake_review` notification
   asks for** ("confirm the buyer to create the offer"). It passes
   `fileName: file.name`, so when several outside agents are waiting on the same
   listing the file the agent just uploaded identifies whose paperwork it is.
2. **the AUTO branch of `lib/inbound-mail/offer-intake.ts`** — the sender was
   already a known contact. It passes `fromEmail`, which is authoritative.

`linkInboundDocumentsToOffer` reads with `error` destructured (a refused read is
reported, never read as "nothing was waiting" — pre-rollout these tables are
EMPTY), and each write:

- **MERGES** `metadata` (`...existing`), never assigns it wholesale — the
  load-bearing bug of wave 9 and a negative control here;
- sets `linked_offer_id`, clears `awaiting_offer_link`, stamps `offer_linked_at`;
- fills `contact_id` only where the confirm branch had nobody;
- re-asserts **brokerage + listing + `metadata->>linked_offer_id IS NULL`** in the
  WHERE and reads back the affected ids, so a second offer matches 0 rows and is
  told, rather than stealing the first offer's paperwork.

An ambiguity is **not** silent: the upload route notifies the uploading user on
the same `offer_intake_review` rail the intake opened the loop on, names the
senders, and says what to do (upload the PDF that came from *this* buyer's agent,
or file their documents from the deal file). The route's JSON also returns
`inbound_documents_linked`, `inbound_link_reason`, `inbound_link_ambiguous`,
`inbound_link_senders`.

*Consequence worth naming:* the agent uploading the same PDF they received by
email produces two `documents` rows for one contract. Harmless to the audit —
`auditOfferDocuments` collects a **set of classifications** — but it is a
duplicate in the deal file, and it is the price of matching on the file rather
than guessing.

---

## L5 — the panel

`runScan` now binds `json.blockers`, takes the first finding, and builds the
message from **`title` — `body`** (the "What to do: …" half wave 9 put there),
on the refusal path **and** on the path where a scan ran and found blockers.
`scanOutcome === "no_packet_staged"` reads as *"Nothing to scan"* rather than
*"Scan could not run"*, because the offer wizard stages no packet at all and
those offers pass the gate on their executed-contract columns — a panel that
cries fault at every wizard offer teaches agents to ignore it.

---

## Deletions

**None.** Nothing in this slice was a duplicate. `planInboundOfferLink` was put
in `offer-detect.ts` — the lane's existing PURE half, where wave 10 put
`planInboundFiling` — rather than growing a second module, and the I/O half sits
with the lane that opened the loop.

---

## Proof

Extended, not forked. **`test:offer-packet-gate` 66 passed / 0 failed**
(was 32) and **`test:inbound-offer-lane` 88 passed / 0 failed** (was 62). Both
now run under `--conditions=react-server` so the proofs can import the REAL
`server-only` modules and drive them against injected stub stores; the existing
assertions were re-run under the flag unchanged before anything was added.

`scanListingPacketCompleteness` grew an optional `client` param for exactly this
— the same pattern `attestBuyerSignature` established in wave 10. It is a
parameter, not an export, so `test:use-server-exports` is unaffected.

The stubs emulate the two things a hand-written fake usually gets wrong: `->>` is
a **TEXT cast** (jsonb `true` reads as `"true"`; a JSON null or an absent key
reads as SQL NULL), and a refused query **RESOLVES**.

Constructs, not spellings:

- **behaviour, the listing lookup**: a packet staged against the SELLER is found
  and WALKED (the outstanding seller signature blocks at critical); the
  `listing_id` column and the metadata form are honoured; an agent-uploaded
  signed-agreement PDF is never adopted **and the paper path is not refused**;
  both halves of the discriminator are required; another brokerage's packet,
  another listing's packet and another state's packet are all left alone; a
  listing outside the caller's brokerage is a fault;
- **behaviour, the outcomes**: nothing staged is non-blocking, `completionPercent
  0` (never 100 again) and carries a reason; the generator's prefill shape —
  built in the proof from the generator's REAL keys — does **not** refuse, and is
  recorded with the document it saw; an unreadable packet, a refused read and an
  invalid id each refuse with a real blocker;
- **structure**: every summary either scan returns (resolved through the
  enclosing object literal) says WHY it ended; no exit in the module claims 100%;
  the lookup no longer depends only on the key nothing writes; every candidate
  lookup is pinned to the brokerage;
- **behaviour, the inbound link (pure)**: one sender links all of that sender's
  pages; two senders with nothing to choose links NOTHING; the uploaded file name
  identifies the group; a known sender is authoritative in both directions; an
  already-linked row is never re-linked;
- **behaviour, the inbound link (the REAL writer)**: the stamp lands on the key
  `auditOfferDocuments` counts; **pre-existing metadata keys survive**; the buyer
  is filled in; another brokerage's pending row is untouched; an ambiguity stamps
  nothing and is returned; a refused read and a refused write are reported per
  row and never counted as linked; a second offer cannot steal the first's
  paperwork;
- **structure**: both offer-creating surfaces call the linker, the AUTO branch
  with the sender it knows and the route with the file it was handed; the write
  spreads the existing blob and re-asserts tenant + listing + unlinked;
  an ambiguity reaches a human;
- **structure, the panel**: resolved through whichever identifiers the component
  binds — `json.blockers` → `[0]` → `?.body` → the message — on both paths.

### Negative controls (seven: red, then restored green)

| bug reintroduced | result |
|---|---|
| listing lookup back to link-keys only (drop the seller-contact branch) | 61 passed, **5 failed** — the packet is not found, not walked, and the fault/no-packet exits change |
| the generator's prefill shape treated as a FAULT (the offer side's rule) | 64 passed, **2 failed** — "the generator's prefill shape does NOT refuse the listing" |
| drop `storage_url IS NULL` + `packet_type IS NOT NULL` (wave 9's exact concern) | 62 passed, **4 failed** — the agent's signed PDF is adopted **and the paper path is refused** |
| `linkInboundDocumentsToOffer` assigns `metadata` wholesale | 87 passed, **1 failed** — "existing metadata keys SURVIVE — the blob is MERGED" |
| `planInboundOfferLink` links a group whenever any is waiting | 86 passed, **2 failed** — both ambiguity assertions, pure and against the writer |
| the AUTO branch drops the authoritative sender | 87 passed, **1 failed** — "the AUTO branch completes it with the sender it already knows" |
| `runScan` back to `json.error` only | 60 passed, **6 failed** — the whole L5 section |
| *(neighbour)* listing analyzer call stubbed out | `test:compliance-checkpoints` 28 passed, **1 failed** |

**One control stayed green and the assertion was hardened.** With the
discriminator removed, `pdfWithMarker.documentId === null` still held — because
the *fault* exit also reports a null `documentId`. An assertion a reintroduced
bug can satisfy is worthless, so it now asserts the whole verdict
(`no_packet_staged`, `success`, no blockers) and goes red with the other three.

### Guards run

`test:offer-packet-gate` 66/0 · `test:inbound-offer-lane` 88/0 ·
`test:listing-doc-upload` 48/0 · `test:orphan-exports` PASS ·
`test:use-server-exports` 3/0 · `test:compliance-checkpoints` 29/0 ·
`test:offer-email-intake` 12/0 · `test:offer-flag-loop` 55/0 ·
`test:simulator-wiring` 12/0 · `test:proof-ownership` PASS.

---

## Required follow-up (outside this slice's file scope)

1. **Give the staged listing packet a link something writes** — the real fix for
   C2. `FormWizard.handleSubmitListing` knows both the `documentId` it preloaded
   and the `listingId` it just created; `createListingWithSellerContact` should
   take the documentId and stamp `documents.listing_id` (the column
   `auditListingDocuments` already reads). The contact fallback shipped here is
   the honest reading of today's data, not a replacement for the link.
2. **`generateListingAgreement` must stop destroying the packet** (C1) — it
   should SPREAD `metadata` rather than replacing it and must not overwrite
   `content` with a shape that drops `filledPacket`. This is the listing twin of
   wave 9's still-open follow-up on `generateOfferDraft`. **Until it lands, the
   listing packet scan can never report `scanned` on the AI lane** — it will
   always answer "nothing to verify", which is honest but is not the check the
   owner asked for.
3. **`markAgreementSigned` should read `packetScan.scanOutcome`**, the way
   `submit-to-compliance` reads the offer side's, instead of inferring from
   `success`. Behaviour is identical today (`no_packet_staged` returns
   `success: true`); reading the outcome makes the intent explicit and lets the
   listing gate record what was verified on its own event, as the offer gate does.
4. **A consumer for `offer_intake_review`.** The notification is the only thing
   that tells the listing agent an emailed offer is waiting, and it is delivered
   in-app with `entity_type: 'listing'`. There is no listing-page surface that
   lists pending inbound paperwork and offers "create the offer from this" —
   the agent has to know to go to the offers upload zone. That zone also still
   asks for the **buyer contact UUID typed into a text box**
   (`offer-upload-zone.tsx:126`), which is not a surface an agent can use.
5. **`notifyComplianceFlag`'s multi-channel branch uses `require`** and throws
   `require is not defined in ES module scope` under ESM (visible in the proof
   output; it is caught and logged, so the in-app notification still lands and
   the multi-channel one silently does not). Pre-existing, outside scope, noted.
6. `signedDocUrl` returning `""` after the bytes are in the bucket — still open,
   still untouched (recorded by wave 10).
