# Wave 14 — the four carried items, and the buyer's offer button

## The new ask, audited before anything is built

> the buyer can click a button to submit an offer on a property which is a
> notification to the agent and buyer gets a message that their agent will be in
> touch and a recommended offer

**This is already built and already wired.** Do not rebuild it. The button is
`app/portal/[contactId]/properties/[propertyId]/BuyerOfferToolsCard.tsx:helpMakeOffer`,
the action is `app/actions/buyer-offer-tools.ts:requestOfferHelp`, and it already:

- notifies the assigned agent (`notifyAgent`, `buyer.offer_help_requested`),
- records the click on `client_portal_activity`,
- fires `lib/agents/offer-strategy-producer.ts:produceOfferStrategyBrief`, the
  gated accelerator that drafts the recommended offer into
  `agent_client_messages` for the agent to approve.

The gating is CORRECT and must survive: the recommendation goes to the agent for
approval, not straight to the buyer. That is this product's egress contract.

### What it promises and does not keep — three defects, one class

Each is the same shape: **the path reports success while doing nothing.**

**W1 — the recommendation is not about the property the buyer clicked.**
`requestOfferHelp` receives `propertyId` and `propertyAddress`, uses them for the
agent's notification text, and then calls
`produceOfferStrategyBrief(brokerageId, contactId)` — which takes **no property
at all**. It builds its brief from the buyer's SAVED-PROPERTIES list. So a buyer
who clicks "help me make an offer" on 123 Oak gets a brief about their saved set,
which may not include 123 Oak. The agent is told "the offer plan is being
prepared" for a specific address and receives a plan about something else.

**W2 — the second request silently produces nothing.**
The brief is idempotent on `entity_id = contactId` ("one offer-strategy brief per
buyer journey"). Per BUYER, not per property. The button is per PROPERTY. So the
first click produces a brief and every later click on any other home returns
`proposed: 0` → `accelerated: false` — while the toast still tells the buyer
"Your agent is preparing your offer plan. They'll reach out with a recommended
price and terms." Nothing is being prepared. `accelerated` is returned to the
caller and the caller ignores it.

Idempotency itself is right and must be kept — re-clicking the same property must
not spam the agent. The KEY is what is wrong.

**W3 — the buyer's "message" is a toast, and toasts do not survive a refresh.**
The owner asked that the buyer *get a message*. What exists is a transient toast.
Nothing writes to the buyer's portal message thread, so a buyer who navigates
away has no record that they asked, and no reply thread to watch. Verified: no
`client_portal_messages` write anywhere on this path.

### Also on this path, same class

- `requestOfferHelp` wraps the `client_portal_activity` insert in
  `try { … } catch { /* non-critical */ }`. **supabase-js RESOLVES a refused
  write**, so the catch never fires and the error is dropped on the floor
  regardless. The high-intent signal the agent's pipeline reads can vanish
  silently.
- `produceOfferStrategyBrief` reads the contact with `const { data: c }` and no
  `error`. A refused read returns `{ proposed: 0 }`, which the caller reports as
  "not accelerated" — indistinguishable from "this buyer has no saved homes".

---

## The four carried items

**C1 — `seedTransactionMilestones` has no caller and a docstring that says it does.**
`lib/kernel/transactions.ts:458`. Its own comment reads "Called by offer-bridge
internally, but exposed here for idempotent retry." Grep finds exactly two
references: the definition and the `lib/kernel/index.ts` barrel re-export. The
bridge does NOT call it — the live seeding path is
`milestone-service:seedJourneyMilestones`. So the docstring describes a wiring
that does not exist, which is worse than no comment: it is the reason nobody
noticed. Decide by reading BOTH: either it duplicates the live seeder (name the
survivor, merge anything it holds that the survivor lacks, then delete) or it is
the retry entry point it claims to be and nothing calls it (wire it). "No caller"
is not a deletion rationale.

**C2 — `runClosingOrchestration` reads five tables and checks `error` on one.**
`lib/transactions/closing-orchestration.ts` — `const { data: txns }` at :367,
`const { data: openRows }` at :439, `const { data: lostTxns }` at :541 all drop
the error. supabase-js resolves a refused query, so a denied `transactions` read
becomes an empty list and the orchestration reports "nothing to do" — on the lane
that drives closings. Pre-rollout the tables are EMPTY, so this cannot be caught
by looking at output.

**C3 — the `tours` RLS policy can never match.** `tours_agent_own` is
`(agent_id = auth.uid())`, but `tours.agent_id` is a FOREIGN KEY TO `agents`
(verified against the live schema) and `auth.uid()` is a `users.id`. Disjoint id
spaces. Only `tours_broker_admin` grants anything, so an ordinary agent cannot
read their own tours at all. **DDL — mine, not an agent's.**

**C4 — `canBuyerSubmitOffer` vs `canBuyerSubmitOffers`.** Singular is the pending
LIMIT gate; plural is the lifecycle ELIGIBILITY gate. Both are real and both are
now enforced at `createOffer`. The names differ by one character and mean
different things. The rename is blocked only on an orphan-export re-baseline,
which must be taken deliberately rather than to make a guard pass.

---

## Rules (unchanged)

- DUPLICATE → read BOTH, MERGE onto the survivor, THEN delete naming it
  `file.ts:functionName`. NOT a duplicate → wire it or finish it. **"No caller"
  is never a deletion reason.**
- supabase-js RESOLVES a refused query — destructure `error`; gates fail CLOSED.
  A bare `try/catch` around a supabase call catches NOTHING.
- Pre-rollout the tables are EMPTY: "nothing came back" is never health.
- `agents.id` / `users.id` / `contacts.id` are DISJOINT — resolve, never `??`.
- `activities.brokerage_id` is NOT NULL with no default; `entity_id` is nullable
  so omitting it succeeds invisibly.
- `offers.status` has **no CHECK constraint** — never use it as a gate.
- `"use server"` files may export ONLY async functions.
- The agent approves before a client sees anything. Do not "fix" W1–W3 by
  shipping the recommendation straight to the buyer.
- Assert CONSTRUCTS in proofs, never spellings; negative-control every assertion
  and CONFIRM the control applied before believing it.
