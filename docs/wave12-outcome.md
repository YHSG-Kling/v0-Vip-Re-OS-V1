# Wave 12 — what shipped, what was found on the way, what is still open

The audit is `docs/wave12-inbound-lane-audit.md`. This is the outcome ledger.

Three parallel slices were dispatched against disjoint file scopes. The container
was restarted mid-flight and all three were killed **after** they had written
their code and **before** any of them wrote a proof or reported. Everything below
was therefore re-verified by hand against the tree, and every proof in this wave
was written afterwards rather than by the agent that wrote the code — which is
the safer order anyway, and is why two long-standing assertions turned out to be
worthless (recorded at the end).

---

## R1 — inbound offers are keyed off the MAILBOX, not the sender

`lib/inbound-mail/offer-detect.ts`, `lib/inbound-mail/offer-intake.ts`,
`app/api/webhooks/inbound-mail/route.ts`.

The webhook already resolved the credential that owns the inbox and passed the
offer lane only the SENDER. Now it passes the mailbox owner, and:

- **The sweep is scoped to that agent's listings.** `agent_user_id` is a
  `users.id`, `listings.agent_id` is an `agents.id` — resolved through
  `resolveAgentIdInBrokerage`, never coalesced. An email in agent A's inbox can
  no longer open an offer on agent B's listing.
- **`assessOfferIntake` takes a three-valued `mailboxOwnsListing`.** `false`
  skips; `null` (the transactional lane, which frequently resolves no agent)
  keeps the brokerage-wide match that works today and records `match_key:
  "brokerage_wide_unkeyed"` in the provenance, so a later reader can tell the two
  apart. The sender now decides only whether `offers.contact_id` (NOT NULL) can
  be filled — `auto` vs `confirm` — never whether detection is trustworthy.
- **A misdirected offer is named.** When the mailbox-keyed sweep finds nothing
  and the mail is offer-shaped, one diagnostic query asks whether the address
  matched a DIFFERENT agent's listing, and logs it. It creates nothing.
- **The `.limit(300)` cap is detected exactly** (one row over the cap is
  requested) and reported on the provenance, on the result, and in the log when
  it truncated and nothing matched.

### The grouping key, and the defect the proof caught

`planInboundOfferLink` was re-keyed from SENDER to **mailbox + sender +
normalized subject** (reply/forward prefixes stripped repeatedly, so "Re: Fwd:
Re:" is one thread). Mailbox is a HARD FILTER with the excluded rows counted, not
dropped. The refusal wave 11 built is unchanged — only the key moved.

Running the existing wave-11 proof against it surfaced a real regression: **a
finer key can SPLIT one agent's paperwork, and the split was silent.** The
leftover pages sit on `awaiting_offer_link` forever and never reach the offer's
compliance count — precisely the defect wave 11 closed, reappearing in a narrower
case. The argument for a finer key is that splitting fails safely while merging
fails invisibly, and "safely" is only true if the residue is VISIBLE. So the plan
now returns `remaining`, `offer-intake` warns on it, and
`app/api/offers/upload/route.ts` raises a notification on BOTH shapes — nothing
linked because nothing could be told apart, and something linked while other
pages stayed behind — saying which happened.

The wave-11 fixture that exposed it was itself unrealistic (two attachments of
one email disagreeing about the subject, which `fileInboundPdfs` cannot produce),
so it was corrected AND the real case was added as its own assertion.

## R2 — the outbound reciprocal

`app/actions/buyer-offer/submit-for-signature.ts`,
`app/components/form-wizard/FormWizard.tsx`, `offer-intake.ts`.

`planOutboundWatch` (pure) has three outcomes: an **in-house** listing needs no
watch (the reply lands on our own listing and R1 owns it); an **outside** listing
with a `listing_agent` signer arms the watch on that address; an outside listing
**without** one REFUSES and says what is missing. It never guesses the address
out of the other signers — our own buyer's agent is role `agent` too, so picking
"an agent" would record OUR side as the counterparty and route our own mail back
into the deal.

The address is written to `offers.metadata` (a live jsonb column — no column
invented), **merged**, on the same write that stamps the envelope, so a packet
that went out and a record of who it went to can never disagree.

`tryRouteOutboundOfferReply` matches a reply from that address, scoped to the
mailbox owner's own deals, files its attachments to the offer, stamps the reply,
and tells the agent. When more than one live offer names the same counterparty it
routes NOTHING and says so, which is the same refusal the inbound lane makes.

**The end-to-end break this would have shipped with.** `FormWizard.tsx:396`
flattened `listing_agent` and `seller` into a flat `"agent"` before calling the
action, because the action's parameter type admitted only buyer/co_buyer/agent.
Step 4 of that same wizard renders a "Listing Agent" row and collects their name
and email — and threw the address away one line before it left the browser. The
watch would have refused on every outside-listing offer forever. The role now
travels, and the action narrows it for the e-sign provider itself.

## R3a — the contract terms have a home (m387)

Twelve columns added to `transactions`, named identically to their `offers`
counterparts. `CONTRACT_TERM_COLUMNS` in `lib/transactions/offer-bridge.ts` is
the single definition the SELECT, the INSERT and the proof all read, and the
proof compares it against the live schema snapshot on BOTH tables — so a term
added to one side and forgotten on the other fails at CI, not months later as a
NULL.

A TERM is not a DEADLINE (`inspection_period_days` vs `inspection_deadline`); the
two name sets are asserted disjoint so one can never overwrite the other.

`createTransactionFromOffer` is the single chokepoint — `kernel/transactions.ts:
createTransactionFromCompliantAcceptedOffer` and `seller-offers.ts:acceptOffer`
both delegate to it — so one fix covers every path. Verified, not assumed.

**Found while wiring it:** the bridge hard-zeroed the buyer's closing-cost credit
with a comment saying the column was not selected. It now reads
`closing_cost_contribution`. Every deal that negotiated a credit had its seller
net overstated.

## R3b — orphaned storage objects (m387, m388)

Eleven call sites shared one shape: upload the bytes, mint a URL, and on failure
return AFTER the bytes are in the bucket. `lib/storage/put-and-sign.ts` makes it
one step and **compensates** — the fix is to undo the upload, not to log it. A
row lands on `storage_orphaned_objects` only when the undo is ITSELF refused, so
the ledger is a worklist of real orphans and an empty worklist means what it
says. When even that write fails it is reported, because at that point nothing in
the system knows the object exists.

`lib/storage/orphan-sweeper.ts` + `app/api/cron/storage-orphan-sweep` (daily,
service client) retry them. The sweeper's `outcome` discriminant makes it
structurally impossible to report a refused read as "nothing to sweep" —
necessary because pre-rollout the buckets are EMPTY.

m388 revokes the anon/authenticated grants on the worklist: m387 had RLS on with
no policy, which denies every row but still leaves the table discoverable through
the schema. The security advisor was right to flag it.

## R4 — the seller sees an offer only when the agent releases it

`offers.presented_to_seller_at` is the gate; NULL means the seller must not see
it. Before this the portal filtered by `status` alone and an emailed offer is
inserted `status:'submitted'`, so a buyer's name, price and terms were on the
seller's screen the instant the webhook returned. `offers.status` has **no CHECK
constraint**, so it was never a gate.

`app/actions/offers/present-to-seller.ts` stamps it — authenticated, tenant
verified, resolving `users.id` → `agents.id`, and **reversible**, because a
one-way release of another party's terms is a trapdoor rather than a gate. It
also writes the `portal_offer_notification` activity the seller's banner reads,
which until now only our own offer wizard wrote — so an emailed offer could never
raise it.

- **R4b** `InteractiveNetSheet` documented a seller-portal `readOnly` mode in its
  own header and had never been used outside the agent's page. It is now wired
  into the seller's view. It is **not** a duplicate of `NetSheetCalculator` — one
  ranks multiple offers by net proceeds, the other is a single-offer what-if the
  seller edits — so both survive and only the missing wire was added.
- **R4c** The portal rendered a hand-rolled three-row table and called
  `analyzeMultipleOffers` on every page load, re-burning paid inference, while
  the comparison the agent had already generated sat in `offer_comparison`.
  `getSellerOfferComparison` reads it back behind the release gate: it WITHHOLDS
  a comparison covering an offer the seller has not been shown, labels one that
  predates a newly released offer `stale` instead of passing it off as current,
  and reports a refused read out loud.

---

## Two assertions that were worthless until this wave broke them

Both were caught by running the negative control, not by reading the code.

1. **`test:vendor-w9` — "PDF lands in the EXISTING client-documents bucket".**
   It asserted the bucket NAME appeared anywhere in the file. Repointing the
   actual upload at a different bucket left it GREEN, because the compensating
   delete further down still named the right one. It now requires every bucket
   named in that action to be that bucket. Verified red.
2. **`test:inbound-offer-lane` — the link-plan `reason` literals.** Frozen on
   `only_sender` / `ambiguous_senders`, which a correct rename moved. Rewritten
   to assert WHICH ROWS LINK and WHETHER THE PLAN REFUSES; a rename cannot fake
   either and a regression cannot hide behind either.

Three of my own negative controls also failed to apply on the first attempt (a
trailing comma, a substring rename, a column that was not in the set being
tested) and each was redone until it actually went red. A control that silently
does not apply proves the same nothing as no control at all.

## Still open, named rather than dropped

- **#142** hazard insurance as a buyer transaction step.
- **#147** `hooks/use-dashboard-data.ts` — 20 unreferenced data hooks, still
  needs a read-both verdict.
- `getOfferLifecycleState`, `canBuyerSubmitOffer`, `getBuyerActiveOffers` remain
  ungated `"use server"` exports on the service client. Pre-existing.
- The audit/gate event names still have no canonical `OFFER_AUDIT_EVENT` const.
- `signedDocUrl`'s long-TTL signing is still the bridge to sign-on-read. The
  orphan class is closed; the TTL question is not.
- The remaining `signedDocUrl` callers not in this wave's scope still use the
  two-step shape. The ones repointed are listed in the audit; the rest are a
  known, bounded follow-up now that the helper exists.
