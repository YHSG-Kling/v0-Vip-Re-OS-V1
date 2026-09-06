# Wave 15 — the items still showing open

Short wave. Everything here was named honestly in a previous ledger rather than
quietly dropped, and every claim below was re-verified today. One of them is a
**regression I introduced in wave 14** and it is listed first.

## W15-1 — I gated `requestOfferHelp` against a rule the portal does not use

Wave 14 added `requireContactAccess` to `requestOfferHelp` because it writes to a
buyer-visible thread with the service client. Correct in principle, wrong in
extent: **`requireContactAccess` recognises a buyer by two facts, and the portal
layout recognises them by four.**

`lib/portal/require-contact-access.ts` grants `isContactSelf` on:

1. `contacts.contact_user_id === auth user id`, or
2. `contacts.email === auth user email` (case-folded).

`app/portal/[contactId]/layout.tsx` additionally grants access on an **accepted,
unexpired `portal_contact_invites` row matching the caller's email** (its "Rule
4"). An invited buyer whose invite address differs from the address on their
contact record — which is the ordinary case when an agent invites someone at
their work address, or the contact row predates the invite — **passes the layout,
sees the portal, and is then refused by the button.** They can read the page and
not use it.

The fix is to make the shared gate recognise what the portal already recognises.
It must stay a NARROWING of the layout, never a widening: accepted status and
unexpired only, and the read must destructure `error` — the layout's own invite
read drops it, so a refused read there currently reads as "no invite".

## W15-2 — four sibling portal actions still ungated, and all four lie on failure

`app/actions/buyer-offer-tools.ts` exports five buyer-facing actions.
`requestOfferHelp` was gated and made honest in wave 14. The other four were not:

| action | gated? | reports success when the agent was never told? |
|---|---|---|
| `signalAffordabilityChecked` (:133) | no | yes |
| `analyzeAddressForBuyer` (:279) | no | yes |
| `requestComparisonReview` (:335) | no | yes |
| `requestPreApprovalRefresh` (:376) | no | yes |

Two defects, one file:

- **Ungated.** Each takes a bare `contactId` and reads/writes through the service
  client, so any authenticated user can fire them for any contact in the
  database — recording activity on, and raising notifications about, someone
  else's client.
- **`await notifyAgent(...)` then `return { success: true }`.** `notifyAgent`
  already returns `{ ok, reason }` (wave 14 changed it) and all four discard it,
  so the toast says "Your agent has been notified" when nothing was delivered.
  This is the exact shape wave 14 removed from the fifth action.

`requestOfferHelp` is the model to follow — gate, then derive what the user is
told from what actually happened.

## W15-3 — 7 of 11 `client_portal_activity` writes are invisible to the agent

Verified against the live policy (`047-client-portal-activity.sql`), not assumed.
The SELECT policy grants on:

- platform admin — everything;
- lead-visible role **AND `has_brokerage_access(brokerage_id)`**;
- agent role **AND `agent_id IS NOT NULL` AND `agent_id = current_user_agent_id()`**;
- the contact themselves, via a `contacts.contact_user_id` join.

So a row written with `brokerage_id` and `agent_id` NULL is readable **only by the
contact themselves and platform admins.** The agent it exists to inform cannot
see it, and neither can their broker.

Eleven call sites write this table; **seven omit `brokerage_id`**:
`portal-offer-decision.ts`, `contact-details.ts`, `showings.ts`,
`collaborative-search.ts`, `portal-nl-search.ts`,
`lib/intelligence/daily-briefing-generator.ts`,
`lib/kernel/client-story-drafts.ts`. (`journey-tasks.ts`, `portal-seller.ts` and
`buyer-offer-tools.ts` already stamp it.)

Both columns are live and nullable — so the writes succeed, which is precisely
why nobody noticed.

## Recorded, NOT to be invented in this wave

- **`transaction_milestone_templates` / `milestone_template_items` now have no
  reader at all.** Wave 14 removed the only one, correctly: it could never
  produce a completable milestone. Brokerage-configurable milestone templates
  may be a wanted capability, but building it needs a WRITER, an admin surface
  and a seeder that stamps canonical `milestone_type` — that is a feature, not a
  loop to close, and it needs an owner decision rather than a guess.
- Legacy SQL in `scripts/330-*` and `scripts/360-*` describes
  `client_portal_messages` with `message_type/title/content`, which the live
  schema does not have. Stale and misleading; no DDL touched.
- `docs/wave14-audit.md` still describes C1/C2/C4 as open. Superseded by
  `docs/wave14-outcome` in the commit body; not rewritten.

## Rules (unchanged)

- DUPLICATE → read BOTH, MERGE onto the survivor, THEN delete naming it
  `file.ts:functionName`. NOT a duplicate → wire it or finish it. **"No caller"
  is never a deletion reason.**
- supabase-js RESOLVES a refused query — destructure `error`; a bare `try/catch`
  around a supabase call catches NOTHING. Gates fail CLOSED.
- Pre-rollout the tables are EMPTY: "nothing came back" is never health.
- `agents.id` / `users.id` / `contacts.id` are DISJOINT — resolve, never `??`.
- A gate must never be WIDER than the surface it protects, and never NARROWER
  than the surface that already admits the user — W15-1 is the narrower case.
- Assert CONSTRUCTS in proofs, never spellings; negative-control every assertion
  and CONFIRM the control applied before believing it.
