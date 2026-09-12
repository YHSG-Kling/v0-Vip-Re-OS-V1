# Wave 12 — the owner's four rulings on the offer lane

> an outside buyers agent snding in an offer on an inside listing, should not be
> scanned on inbound emials by sender since we wont have that agents's email
> hooked to our listing. you can monitor the agent assigned to the listing
> (listing agent)'s email for an emial with the listing's address/offer. if we
> send an offer out to an outsdie listing agents property listing for our buyers,
> you can check for the returned email from that listing agent. creat the
> required columns for the contract terms along with the orphaned storage objects
> for supabase buckets. also any offer that comes in for insdie listings, once
> agent approves, is pushed to the sellers's portal to see the offer with the
> interactive net sheet. and if muliple offers, then a complete comparison.

Five obligations. Every claim below was read against the tree and the LIVE schema
(Supabase MCP, project `hrvaqgvukzxfskkcrwbt`) today — not inferred from the
previous waves' ledgers, two of which turned out to be wrong when checked.

Ruling 1 **supersedes wave 11 slice B's design**. That is stated first because it
means correcting work this branch already shipped, not adding to it.

---

## R1 — the inbound lane is keyed off the SENDER, which the owner has ruled out

### What is there now

`app/api/webhooks/inbound-mail/route.ts` resolves a per-user credential
(`resolveUserByInboundIdentifier` → `resolvedCredential.agent_user_id`,
`.brokerage_id`) for the gmail/outlook lane. **It knows exactly whose mailbox the
message arrived in.** It then throws that away for the offer lane: the only
identity it passes to `tryIngestInboundOffer` is `senderContactId` — the SENDER.

`lib/inbound-mail/offer-intake.ts:tryIngestInboundOffer` then:

- loads **every** in-house listing in the brokerage (`.limit(300)`, statuses
  active / coming_soon / pending) and address-matches against all of them;
- calls `assessOfferIntake({ …, senderIsKnownContact })`, whose entire branch
  between `auto` and `confirm` is the sender;
- and on the AUTO path calls `linkInboundDocumentsToOffer` with `fromEmail`
  **AUTHORITATIVE**, which `offer-detect.ts:planInboundOfferLink` uses to GROUP
  pending documents by sender.

### Why the owner is right and this is wrong

An outside buyer's agent is, by definition, not in our contacts. Their address is
not hooked to our listing and never will be. So:

- `senderIsKnownContact` is false ~always on the very scenario this lane exists
  for. The `auto` branch is unreachable for a real outside agent; every genuine
  inbound offer lands on `confirm`.
- `planInboundOfferLink` groups by an identifier that has no relationship to the
  deal. Wave 11 chose sender-grouping to avoid linking two outside agents'
  paperwork to one offer — a real hazard — but picked the wrong boundary. Two
  emails from the same outside agent about **two different listings** group
  together; two emails from an agent and their assistant about the **same
  listing** do not.
- The 300-listing sweep means an email in agent A's mailbox can create an offer
  on agent B's listing. Nothing checks that the mailbox owner has anything to do
  with the matched listing.

### The boundary the owner named

**The MAILBOX is the authority.** The listing agent's inbox + the listing's
address + offer signals. `resolvedCredential.agent_user_id` is a `users.id`;
`listings.agent_id` is an `agents.id` — DISJOINT id spaces, so this must RESOLVE
(`lib/kernel/agent-identity.ts`), never `??`. That resolution is the entire
correction: match only against listings whose assigned agent OWNS the mailbox the
message arrived in.

Two honest limits that must be preserved, not papered over:

1. The **transactional** provider lane (postmark/sendgrid/mailgun/resend) has no
   mailbox owner in the same sense — `resolveUserByInboundIdentifier` is called
   with `toAddress`. When it yields no agent, the mailbox key is absent and the
   lane must fall back to the brokerage-wide address match it does today, and
   SAY SO in the provenance. Refusing outright would delete a working path.
2. `.limit(300)` is a silent cap. Scoping to one agent's listings makes it far
   less likely to bite, but a cap that truncates must be reported, not hidden.

## R2 — the outbound reciprocal does not exist at all

When we write an offer for OUR buyer on an OUTSIDE listing, `offers.listing_id`
is null and `offers.property_address` carries the address
(`app/actions/buyer-offer/prefill-offer.ts`). `submit-for-signature.ts` sends the
packet through the e-sign provider.

**Nowhere in the tree is the outside listing agent's email address recorded.**
`grep -rn "listing_agent_email\|listingAgentEmail\|sendOfferToListingAgent"`
returns nothing on the offer lane. So when that agent replies with a counter, an
acceptance, or a signed contract, the reply lands in our buyer agent's mailbox
and the offer lane has no way to connect it to the offer — the address match will
not fire either, because an outside listing has no `listings` row to match.

This is the mirror of R1 and needs the same shape: record WHO we sent it to at
send time (`offers.metadata`, which exists and is jsonb), then treat a reply from
that address, in our agent's mailbox, about that offer, as this deal's mail.

## R3a — the contract terms had no home. Now they do (m387, applied)

Verified against the live `transactions` table before writing anything. These
columns did NOT exist and the offer→transaction bridge dropped the values:

`financing_type`, `down_payment_amount`, `down_payment_percent`,
`closing_cost_contribution`, `possession_terms`, `escalation_clause`,
`escalation_cap`, `appraisal_gap`, `due_diligence_fee`,
`inspection_period_days`, `appraisal_contingency_days`,
`financing_contingency_days`.

`supabase/migrations/m387-…sql` adds all twelve, **named identically to the
`offers` columns they come from** so the bridge is a 1:1 copy and no second
vocabulary is created. `scripts/schema-snapshot.ts` is regenerated.

What remains is code: `lib/transactions/offer-bridge.ts` already SELECTs
`inspection_period_days`, `appraisal_contingency_days`,
`financing_contingency_days` (it derives deadlines from them) and never persists
them. The rest are not even selected.

Note the distinction the bridge already gets right and must keep: a **deadline**
(`inspection_deadline`, a date derived from the contract date) is not a **term**
(`inspection_period_days`, the number on the contract). Both belong; neither
replaces the other.

## R3b — orphaned storage objects: 11 call sites, all the same shape

`lib/storage/signed-doc-url.ts:signedDocUrl` returns `""` on failure — by
design, "so callers can guard exactly as they did for publicUrl". Every caller
does guard. **Every caller guards by bailing AFTER the bytes are already in the
bucket:**

```
app/transactions/[transactionId]/page.tsx:247      app/actions/vendor-w9.ts:92
app/actions/portal-settings.ts:69                  app/api/offers/upload/route.ts:78
app/actions/documents.ts:242                       app/dashboard/…/cda-workflow-client.tsx:279, :345
app/actions/vendor-portal.ts:473                   app/portal/lender/…/document-upload.tsx:85
lib/inbound-mail/offer-intake.ts:159, :277
```

`offer-intake.ts:157-160` is the clearest: upload succeeds, sign fails,
`return { handled: false }`. The PDF sits in `offer-documents` forever with no
`documents` row, no `offers` row, and no log line naming it. Nothing in the tree
sweeps a bucket (`grep` for `storage…remove(` finds one unrelated call in
`vendor-portal.ts`).

m387 adds `storage_orphaned_objects` (service-role only; RLS on, no permissive
policy). The correct shape is a **compensating delete**: on the failure path,
remove the object; only if the REMOVE also fails does a row get written, so the
ledger holds genuine orphans rather than a log of every hiccup. A cron sweeps
what is left.

Pre-rollout the buckets are empty. "The sweep found nothing" is therefore not
evidence of anything, and the proof must not treat it as such.

## R4 — the seller sees every offer the instant it lands, before any agent reads it

The owner's ruling is a GATE — "once agent approves, is pushed to the seller's
portal". There is no gate.

`app/portal/[contactId]/offers/page.tsx:313` filters
`getSellerOffers(contactId)` by `["pending","submitted","under_review","countered"]`
and renders. An inbound offer written by `offer-intake.ts` is inserted with
`status: "submitted"` — so it is on the seller's screen the moment the webhook
returns, with the buyer's name, price, and terms, before the listing agent has
opened it. That is the defect, and it is the opposite of what the owner
described.

`offers.presented_to_seller_at` (m387) is the gate. NULL means the seller must
not see it. It is set only by an approval action and must never be inferred from
`status` — `offers.status` has **no CHECK constraint** (verified), so status is
not a trustworthy gate for anything.

### R4b — the interactive net sheet is BUILT and NOT WIRED to the portal

`app/components/features/offers/interactive-net-sheet.tsx:16` says, in its own
header: *"Surfaced on the agent's offer view AND reusable by the seller portal
(read-only mode via `readOnly`)"*. It takes a `readOnly` prop for exactly that.

Its only importer is `app/dashboard/listings/[id]/offers/page.tsx:5` — the
AGENT's view. The seller portal renders `app/components/portal/NetSheetCalculator.tsx`
instead.

This is the governing correction's exact case: an advanced capability, finished,
with a documented seller-portal mode that no caller ever uses. **It is not a
duplicate to delete — the two are different things** (the interactive sheet ranks
MULTIPLE offers by net through `rankOffersByNet`; the portal calculator is a
single-offer what-if the seller edits). The interactive sheet is what the owner
asked for by name and it must be WIRED, with `readOnly` for the seller.

### R4c — "a complete comparison" exists three times over, and the seller gets none of it

Built and live for the AGENT:

- `lib/offers/offer-analyzer.ts:analyzeAndCompareOffers` → persists to
  `offer_comparison` (`offer_ids`, `comparison_matrix`, `net_to_seller_by_offer`,
  `ai_recommendation`, `recommended_offer_id`)
- `app/actions/seller-offers.ts:triggerOfferComparison` / `loadLatestOfferComparison`
- `lib/kernel/offers.ts:compareOffers`, `MultiOfferMatrixCard`,
  `buildSellerDecisionRoom`

What the SELLER's multi-offer view renders (`page.tsx:674-743`) is a hand-rolled
3-row table — price, financing, earnest money — computed inline, with
`analyzeMultipleOffers(listing.id, "")` called on every page load (it re-burns AI
inference; `loadLatestOfferComparison` exists precisely so it does not have to).
The persisted comparison the agent generated is never read by the portal.

So the seller sees a thinner comparison than the one already computed and stored
for this listing. Reading `offer_comparison` is the fix; building a fourth
comparison is not.

### R4d — the "you have a new offer" banner cannot fire for an inbound offer

`activities.activity_type = 'portal_offer_notification'` is read by the portal
(`page.tsx:297`) and written in exactly one place:
`app/crm/contacts/[contactId]/offers/components/offer-form-wizard.tsx:278` — our
own wizard. An offer that arrives by email never writes it. The approval action
is where that notification belongs.

---

## What this wave must NOT do

- **Not** delete `NetSheetCalculator`. It is the seller's single-offer what-if,
  not a stale copy of the interactive sheet. Both survive; only the missing
  wire is added.
- **Not** delete `planInboundOfferLink`. Its ambiguity refusal is correct and
  hard-won — a plan that links NOTHING and reports why is better than one that
  guesses. Only its KEY changes, from sender to listing+mailbox.
- **Not** invent a fourth comparison, a fourth net-sheet engine, or a second
  terms vocabulary. All three already exist and are named above.
- **Not** widen `assessOfferIntake` into an auto-create for unknown senders.
  `offers.contact_id` is NOT NULL; fabricating a buyer contact to satisfy it is
  worse than the confirm branch.

## Rules (unchanged, and two earned this wave)

- DUPLICATE → read BOTH, MERGE onto the survivor, THEN delete naming it
  `file.ts:functionName`. NOT a duplicate → wire it or finish it. "No caller" is
  never a deletion reason.
- supabase-js RESOLVES a refused query — destructure `error`; gates fail CLOSED.
- Pre-rollout the tables and buckets are EMPTY: "nothing came back" is never
  health.
- `agents.id` / `users.id` / `contacts.id` are DISJOINT — resolve, never `??`.
  **R1 turns on this**: the mailbox gives a `users.id`, the listing holds an
  `agents.id`.
- `activities.brokerage_id` is NOT NULL with no default.
- `offers.status` has **no CHECK constraint** — never use it as a gate.
- Assert CONSTRUCTS in proofs, never spellings; negative-control every assertion
  (reintroduce the bug → red, restore → green).
- `scripts/tenant-scope-guard.ts` scans RAW SOURCE with a 500-char window after
  `.from("<table>")`. Do not put long comments inside a query chain, and do not
  name a table literally inside a comment.
