# Wave 10 — the inbound offer (owner ruling)

## The ruling, verbatim

> there are times that an offer comes in from an outside buyers agent for a
> listing in house and won't be created from the wizard and those contracts need
> to be executed and signed from the seller and then submitted and read and
> checked through the compliance gate. some documents won't be one of ours and
> submitted from the outside buyer and need to be read and counted in the
> transaction paperwork. once the transaction is created, the terms/dates need to
> be saved to the transaction and all parties of the transaction notified of such
> info, dates, contingencies, parties contact info etc.

Five obligations:
1. an offer can arrive from an OUTSIDE buyer's agent on an IN-HOUSE listing,
   not built by our wizard;
2. the SELLER executes and signs it;
3. it is then submitted, READ, and checked through the compliance gate;
4. documents that are NOT ours must be read and COUNTED in the transaction
   paperwork;
5. on transaction creation, terms/dates are saved AND **all parties are
   notified** of the info, dates, contingencies and parties' contact details.

This ruling also confirms the wave-9 judgment call: an offer with no packet of
ours is a legitimate offer, not a fault. Wave 9 already refuses to block it.

## What exists — do NOT rebuild

`lib/inbound-mail/offer-intake.ts:tryIngestInboundOffer` is real and reachable.
It detects a likely offer email, matches the in-house listing, and on the AUTO
path uploads the PDF to the `offer-documents` bucket, inserts an `offers` row
(`status:'submitted'`, `ai_extraction_status:'pending'`, `offer_document_url`),
and kicks `lib/offers/offer-extractor.ts:extractOfferFromPdf`. On the ambiguous
path it notifies the listing agent to review. Obligation 1's INTAKE is built.

`lib/transactions/offer-bridge.ts` already saves real terms on creation:
`purchase_price`, `closing_date`, `earnest_money`, `earnest_money_due_at` /
`_days`, the three contingency-day columns, and a normalised term map
(`closing_date`, `inspection_deadline`, `earnest_money_due`). Obligation 5's
SAVE half is largely built. Verify per-field before extending.

## THE DEFECTS

### F1 — THE INBOUND LANE DEAD-ENDS. Nothing that arrives this way can ever become a transaction.

`offers.buyer_signed_at` is written in exactly ONE place:
`lib/esign-webhooks/finalize-packet.ts` (lines 243, 258) — the webhook for OUR
OWN e-sign envelopes. An offer from an outside buyer's agent was signed on THEIR
paperwork, through THEIR provider or on paper. Our webhook never fires, so
`buyer_signed_at` stays NULL forever.

Two gates then refuse it, permanently:
- `app/actions/buyer-offer/record-seller-response.ts:66` —
  `if (!offer.buyer_signed_at) return …` — **the seller can never accept it.**
- `app/actions/buyer-offer/submit-to-compliance.ts` — same precondition, so it
  can never reach the compliance gate either.

So today the lane runs: email arrives → PDF stored → offer row created → AI
extraction runs → **and stops**. The seller cannot accept, compliance never sees
it, no transaction is ever created. Obligations 2 and 3 are unreachable.

The fix is NOT to drop the buyer-signature requirement — "both sides signed" is
settled law here. It is that an inbound offer has a DIFFERENT, equally valid
evidence source for the buyer's signature: the executed contract that arrived.
Establish it explicitly and record which evidence was used, exactly as wave 9
did for `both_sides_established_by`. Never infer a signature that was not
evidenced.

### F2 — the outside contract is invisible to the paperwork count

`tryIngestInboundOffer` writes the PDF to storage and sets
`offers.offer_document_url`. It creates **no `documents` row**.
`lib/compliance/required-documents.ts:auditOfferDocuments` counts only
`documents` rows keyed by `metadata.linked_offer_id` (line 167-172, and the
sibling queries at 251/261/273).

So the outside buyer's contract — the single most important piece of paper in
the deal — cannot be read or counted toward the transaction paperwork, which is
obligation 4 stated directly. Anything else the outside agent sends (addenda,
pre-approval, disclosures) has the same problem.

Note the shape that already works: `lib/documents/upload-document.ts` is the
universal uploader (used by `record-seller-response.ts`) which creates the
`documents` row AND kicks the classifier. The inbound path should reach the same
ledger rather than growing a second one.

### F3 — nobody is told. No party notification exists on transaction creation.

Grep for a notification on `transaction_created` across `app/` and `lib/`:
nothing. `transaction_participants` is written only by
`lib/application/transactions.ts` and `lib/documents/auto-populate-participants.ts`.
Terms and dates are saved (above) and then sit there.

Obligation 5's second half — "all parties of the transaction notified of such
info, dates, contingencies, parties contact info" — is entirely absent. The
parties are exactly the people who need the dates: buyer, seller, both agents,
and the TC.

## Constraints that bound this work

- Wave 9 just landed on the same gate. `submit-to-compliance.ts` now
  distinguishes `scanOutcome` fault / never-staged, records
  `both_sides_established_by`, and sweeps the flag ledger on pass. Extend that
  vocabulary; do not fork it.
- `activities.brokerage_id` is NOT NULL with no default; `entity_id` is
  nullable. The offer key is `entity_type='offer'` + `entity_id`.
- `agents.id` / `users.id` / `contacts.id` are DISJOINT — resolve, never `??`.
- supabase-js RESOLVES a refused query — destructure `error`; gates fail CLOSED.
- `"use server"` files may export ONLY async functions.
- Pre-rollout: tables are EMPTY. "Nothing came back" is never health.
- Assert CONSTRUCTS in proofs, never spellings; run a negative control on each.
