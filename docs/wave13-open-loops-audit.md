# Wave 13 — closing the loops wave 12 named and left open

Not new territory. This is the backlog the previous ledgers recorded honestly
rather than dropping. Every claim was re-verified against the tree today, and one
of them turned out to be **wrong in my own favour**, which is recorded first.

## Correction to the wave-12 ledger

`docs/wave12-outcome.md` says "the remaining `signedDocUrl` callers not in this
wave's scope still use the two-step shape". **That is false.** A grep of the tree
today finds `signedDocUrl` called in exactly one place — inside
`lib/storage/put-and-sign.ts` itself. Every one of the eleven call sites was
repointed. The loop is closed; I under-reported the work. Nothing to do here
except stop carrying it as open.

---

## L1 — the offer gates are ADVISORY, and three of them are open to any browser

The most valuable finding in this wave, and it is two defects sharing a cause.

### L1a — `createOffer` enforces neither gate

There are two different questions about whether a buyer may make an offer, and
they are not duplicates:

- `app/actions/buyer-lifecycle-core.ts:canBuyerSubmitOffers` — the LIFECYCLE gate
  (`isOfferAllowed`: is this buyer far enough along, financially verified, etc.)
- `app/actions/buyer-offer/handle-multi-offer.ts:canBuyerSubmitOffer` — the
  LIMIT gate (how many offers are already pending; `evaluateOfferLimit`)

Both are real and they answer different things. The near-identical names
(singular vs plural) are a hazard in their own right.

**Neither is enforced where an offer is actually created.** `canBuyerSubmitOffers`
is called by three PAGES (`/offers`, `/offers/new`, the contact page) to decide
what to render; `canBuyerSubmitOffer` is called by one client banner.
`app/actions/buyer-offers.ts:createOffer` — the server action that writes the row
— references neither. A gate that only the UI consults is a suggestion: the
action is directly invocable, and every path that is not the wizard (the upload
route, the inbound-mail lane, a stale tab) bypasses it entirely.

### L1b — three `"use server"` exports on the service client with no auth at all

`canBuyerSubmitOffer`, `getBuyerActiveOffers` (both in `handle-multi-offer.ts`)
and `getOfferLifecycleState` (`track-offer-lifecycle.ts`) take an id and read
through `createServiceClient()` with **no `auth.getUser()` and no tenant check**.

`getBuyerActiveOffers` is the sharp one: it is invoked from a CLIENT component
(`app/components/offer/multi-offer-status-banner.tsx:32`) with a bare
`contactId`, so it is a server action reachable from any signed-in browser with
any contact id in the database. That returns another brokerage's buyer's live
offers.

The gate pattern is already in the same module — `handle-multi-offer.ts` has a
`requireCaller`-style helper immediately above `canBuyerSubmitOffer` that reads
the session, resolves the caller's brokerage and refuses a contact outside it.
It is used by the other exports in the file and skipped by these.

Also here, and secondary: `canBuyerSubmitOffer` calls `getOfferLifecycleState`
once per offer in a loop — an N+1 that grows with the buyer's history.

## L2 — hazard insurance (#142): built, wired at the edges, unproven as a STEP

Contrary to the backlog line ("build hazard insurance"), most of it exists:
`lib/transactions/hazard-insurance.ts` (a substantial pure reader with posture,
severity, reminder windows), `app/actions/transaction-hazard-insurance.ts`
(`getTransactionHazardInsuranceAction`, `recordHazardPolicyAction`), a UI section
on the transaction page, `hazard_insurance_bound` in `milestone-identity.ts`, and
a `closing-orchestration.ts` reader that gates on that milestone.

What is NOT established, and is this wave's actual question: **does the step ever
appear on a buyer's deal?** `milestone-catalog.ts` declares
`hazard_insurance_bound`, but a declared milestone is not a seeded one, and
`closing-orchestration.ts:302` only *finds* the milestone — if nothing seeds it
for buyer transactions, that reader has been looking for a row that never exists,
which is the same silent-pass class wave 9 fixed on the offer packet and wave 11
fixed on the listing packet.

Establish it before changing anything. If it IS seeded, the loop to close is the
reminder lane (the windows are declared; is anything firing them?). If it is NOT
seeded, that is the defect.

## L3 — `hooks/use-dashboard-data.ts` (#147): a complete, correct, unused data layer

19 exported hooks over one generic `useDashboardData`, all hitting
`/api/dashboard/data`. Verified today:

- **The route is good.** It authenticates, resolves `agentId` through
  `resolveAgentId` and `brokerageId` from `users` — never from query params, with
  the invariant written into its header — and scopes every branch by both.
- **Nothing imports the hooks.** Zero consumers across `app`, `lib`, `hooks`.
- **Nothing else calls the route either.** Its only referrer is the hook file.

So this is not a parallel data layer competing with a live one; it is a whole
lane — client hooks plus a correctly-gated endpoint — that no surface reached.
The read-both verdict is owed against how the dashboard fetches today (server
components reading Supabase directly). Those are not the same thing: server
components cannot revalidate on mutation without a round trip, which is what SWR
+ `mutate` is for.

The rule applies unchanged: **"no caller" is not a deletion rationale.** Either a
surface genuinely wants client-side revalidation and this is what it should use,
or the capability duplicates a live one and the survivor must be NAMED. Decide by
reading both, not by counting imports.

## L4 — the audit/gate event names still have no constant

`buyer.offer.block`, `.compliance.*`, `.provider.signature.*`, `.buyer_signed`,
`.counter.*` are written as string literals. They are correctly ABSENT from the
STATE maps (they are audit events, not lifecycle transitions) —
`lib/buyer-offer/compliance-gate.ts:24` records the recommendation: a sibling
`OFFER_AUDIT_EVENT` const in `offer-lifecycle.ts`. Small and mine to do.

---

## Rules (unchanged)

- DUPLICATE → read BOTH, MERGE onto the survivor, THEN delete naming it
  `file.ts:functionName`. NOT a duplicate → wire it or finish it. **"No caller"
  is never a deletion reason.**
- supabase-js RESOLVES a refused query — destructure `error`; gates fail CLOSED.
- Pre-rollout the tables are EMPTY: "nothing came back" is never health.
- `agents.id` / `users.id` / `contacts.id` are DISJOINT — resolve, never `??`.
- `activities.brokerage_id` is NOT NULL with no default; `entity_id` is nullable,
  so omitting it succeeds invisibly.
- `offers.status` has **no CHECK constraint** — never use it as a gate.
- `"use server"` files may export ONLY async functions.
- Assert CONSTRUCTS in proofs, never spellings; negative-control every assertion
  and CONFIRM the control actually applied before believing it.
- `scripts/tenant-scope-guard.ts` scans RAW SOURCE with a 500-char window after
  `.from("<table>")` — hoist long payloads above the call, and never name a table
  literally inside a nearby comment.
