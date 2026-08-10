# Wave 6 — Slice 2: 29 `"use server"` action files, 48 category-C orphaned exports

Branch: `claude/settings-consolidation-ui-0cd7lo`

Every export in a `"use server"` file is a publicly reachable HTTP endpoint. Orphan =
no in-repo caller = an endpoint with no UI in front of it and (historically in this
repo) no one who ever exercised its authorization path.

Method: (a) duplicate → merge onto survivor then delete, naming the survivor;
(b) not a duplicate → wire it to its surface, or finish it, or record exactly what
finishing needs. "No caller" is never a deletion rationale.

## Exact orphan roster (from `scripts/orphan-export-guard.ts --list`)

| file | orphans |
|---|---|
| app/actions/copilot.ts | createTransactionMilestone, handleCoachingSessionBooked, handleMorningKickoff, handleSuggestionAccepted |
| app/actions/ai-newsletter.ts | aiPersonalizeNewsletter, manageSubscriberBatch, manageSubscribers |
| app/actions/assistant.ts | handleAssistantQuery, handleAutomationTriggered, handleTaskDelegated |
| app/actions/calculators.ts | calculateHomeValue, emailCalculationResults, getSavedCalculations |
| app/actions/academy.ts | addTemplateFeedback, getTemplateFeedback |
| app/actions/ai-listing-intake.ts | aiOptimizePhotoOrder, runCompleteListingIntake |
| app/actions/ai-review-automation.ts | aiCreateRecoveryPlan, aiSetupReviewMonitoring |
| app/actions/compliance-bridge-actions.ts | emitCompliancePassedAction, loadComplianceBridgeStatusAction |
| app/actions/open-house-automation.ts | handleRSVP, submitFeedback |
| app/actions/podcast-generation.ts | getPodcastAnalytics, getVideoScriptsLibrary |
| app/actions/portal-seller.ts | getSellerDashboardData, getSellerOffers |
| app/actions/seller-offers.ts | getOffersForListing, recordSellerView |
| app/actions/transaction-document-signatures.ts | getTransactionSignatureStatuses, getUnsignedDocumentBlockers |
| app/actions/vendor-invite.ts | inviteVendorToPlatformAction, revokeVendorInviteAction |
| app/actions/admin/create-subscriber.ts | retrySubscriberInvite |
| app/actions/ai-closing-workflow.ts | aiTrackClosingMilestones |
| app/actions/ai-offer-creation.ts | submitCompleteOffer |
| app/actions/buyer-offer/handle-multi-offer.ts | checkDuplicateOffer |
| app/actions/content-prediction.ts | getPredictionAction |
| app/actions/crm.ts | updateContactStage |
| app/actions/lead-assignment/assign-lead.ts | claimLeadAction |
| app/actions/lead-signal-ingest.ts | ingestPredictiveSellerSignalAction |
| app/actions/lifecycle-promo-policy.ts | getMyLifecyclePromoPolicy |
| app/actions/marketing-cadence-policy.ts | getMyMarketingCadencePolicies |
| app/actions/negotiation-strategy.ts | recordStrategyOutcomeAction |
| app/actions/neighbor-notifications.ts | listNeighborCampaignsForListing |
| app/actions/photo-management.ts | getPhotoOrderingRules |
| app/actions/transaction-transparency.ts | markDelaysCommunicated |
| app/actions/video-content.ts | createShortClip |

## Findings log (incremental)

### 1. `app/actions/vendor-invite.ts` — WIRED + 3 defects fixed

Orphans: `inviteVendorToPlatformAction`, `revokeVendorInviteAction`. Verdict (b):
**not a duplicate — it belongs to a surface that never grew the button.**

The vendor portal had an acceptance page (`app/vendor-invite/[token]/accept-form.tsx`
→ `acceptVendorInviteAction`) and a superadmin board that renders
"not invited"/"invite pending" badges (`app/dashboard/superadmin/vendors/page.tsx:258`),
but **nothing on the platform ever called the writer**. So `vendor_invitations`
could only be populated by hand: the whole vendor portal (`/vendor/jobs`,
`/vendor/invoices`, `/vendor/earnings`, …) was reachable in principle and
unreachable in practice, and the superadmin badge lane had no feeder.

Defects found and fixed in `app/actions/vendor-invite.ts`:
1. **`revokeVendorInviteAction` reported success without revoking.** The update had
   no `.select()`, so `{ok:true}` was returned whenever the statement *executed* —
   including when the `brokerage_id` + `status='pending'` filters matched zero rows.
   Revoking another brokerage's invitation, or an already-accepted one, said
   "revoked" while the token stayed live and usable. Now `.select("id")` + an
   explicit refusal when nothing matched. (defect class 9)
2. **The invite email failure was swallowed.** `inviteUserByEmail` was awaited inside
   a bare `try/catch` and `{ok:true}` was returned regardless; supabase-js resolves
   that call with `{error}` rather than throwing, so even the catch rarely fired.
   The result type now carries `emailSent` / `emailError` / `reused`, and the UI
   distinguishes "email sent" from "row created, link is yours to deliver".
3. **`const { data }` without `error` on the caller/vendor/existing-invite reads.**
   All three now destructure `error`. The existing-invite read was the dangerous
   one: an errored read fell through to "no pending invite", which **mints a second
   live token per retry**. It also gained `.order(created_at desc).limit(1)` —
   `maybeSingle()` throws if two pending rows already exist. (lesson 5)

Consolidation (a): the local `INVITE_ALLOWED_ROLES` set duplicated
`lib/vendors/vendor-scope.ts:VENDOR_INVITE_ROLES`. Survivor is
**`lib/vendors/vendor-scope.ts:canInviteVendors`** — the action now calls it, and
the local copy is gone. The revoke list (leadership-only, genuinely different) stays
local as `REVOKE_ALLOWED_ROLES`.

Wired at: new `app/dashboard/vendors/vendor-portal-invite-panel.tsx`, mounted in the
"Client access" tab of `app/dashboard/vendors/page.tsx` (which also gained the
`vendor_invitations` + `user_role_assignments` reads that feed it). Platform access
(can this vendor sign in) now sits directly above per-client access (what a signed-in
vendor may see).

Left deliberately: `acceptVendorInviteAction` still writes the retired `users.role`
alongside `user_type`. Column is nullable, the write is harmless, and removing a
legacy write is a separate blast radius from this slice.

### 2. `app/actions/admin/create-subscriber.ts` — WIRED + a gate lockout + 2 defects

Orphan: `retrySubscriberInvite`. Verdict (b): **belongs to a surface that reported
the failure and then abandoned it.**

`ManualSubscriberForm` already renders `Invite email FAILED: <reason>` when
`provisionTenantOwner` finishes the tenant but the owner's magic link does not go
out (an "already registered" address is the common path — `lib/kernel/users.ts:869`
tolerates it and still upserts the users row). There was no way to resend, so that
owner simply never got in.

Security findings:
1. **`retrySubscriberInvite` was an unbounded "mail an admin invite for tenant X to
   address Y" primitive.** It took `adminEmail` + `brokerageId` straight from the
   client and asked Supabase to invite that address with
   `user_type:'admin', brokerage_id:<whatever was passed>`, with no check that the
   two had anything to do with each other. Now it requires a `users` row with that
   email ON that brokerage — precisely the state `createSubscriber` leaves behind,
   so every legitimate retry passes — and it mirrors the target's real `user_type`
   instead of asserting `'admin'`.
2. **`await service.auth.admin.inviteUserByEmail(...)` result discarded** →
   `return {success:true}` for sends that never happened. supabase-js resolves that
   call with `{error}`; it does not throw, so the surrounding `try/catch` almost
   never fired. Now the error is read. (defect class 9 — same shape as vendor-invite)
3. **GATE LOCKOUT (pre-existing, live).** `createSubscriber` demanded a literal
   `'superadmin'` resolved off `platform_role ?? user_type ?? role` — including the
   RETIRED `users.role`. Its only caller
   `app/actions/superadmin/manual-subscriber.ts:71` gates on the `'tenants'`
   platform capability (round-19 parity: "platform ADMIN staff provision
   subscribers too"). So a platform admin / marketing / support staffer passed the
   outer door and was refused by the inner one — the documented policy did not
   work. Both `createSubscriber` and `retrySubscriberInvite` now use the canonical
   `lib/platform/staff-action-gate.ts:gateStaffAction("tenants")`. This WIDENS
   `createSubscriber` from superadmin-only to the tenants capability, deliberately,
   to match the gate its only caller already enforces.

The resend is also audited (`auditStaffAction(gate, "subscriber.invite.resent", …)`)
— a staffer mailing a tenant-owner magic link is a cross-tenant act.

Wired at: `app/dashboard/superadmin/brokerages/new/manual-subscriber-form.tsx` — a
"Resend owner invite" button appears in the success panel only when
`inviteSent === false`, and reports the real outcome of the resend.

Verified the identity-class-guard assertions on this file still match (`callerAgentId`
resolve, `agent_id: callerAgentId`, `actor_user_id: callerUser.id`,
`if (auditErr) console.error`) and that `tenant-creation-simulator`'s
"no `.from("users").insert(`" assertion still holds.


### 3. `app/actions/ai-offer-creation.ts:submitCompleteOffer` — DELETED (duplicate)

**Survivor: `app/actions/buyer-offers.ts:createOffer`.**

Established by reading both. `createOffer` is what the live offer wizard uses
(`app/crm/contacts/[contactId]/offers/components/offer-form-wizard.tsx:307`) and is
strictly more complete: financial-verification gate, tenant-checked listing
resolution, `resolveAgentId` (agents.id, never the users.id), `brokerage_id` +
`agent_id` stamped, lifecycle transition + `lifecycle_events`, strategy-recommendation
linkage, form_source / e-sign wiring.

`submitCompleteOffer` was not merely redundant — it was a **live bypass**:
- It **skipped the financial-verification gate** entirely. That gate exists because
  "any client could POST and create an offer for an unverified buyer"; this second
  door reopened exactly that, for any signed-in agent.
- It inserted the `offers` row with **no `brokerage_id` and no `agent_id`**, so the
  resulting offer was invisible to every tenant-scoped offers surface.
- It minted a `transactions` row with `status:'active'` per SUBMITTED offer, before
  any acceptance — one phantom deal in the pipeline per offer.
- Its "offer received" `activities` insert **omitted `brokerage_id` (NOT NULL)** and
  never read `error`, so that notification wrote zero rows while reporting success
  (lesson 8, verbatim).

Nothing was lost. The Dotloop step is `createOfferDotloop`, still exported here and
still reached via `lib/workflow/adapters/send-for-esign.ts:196`. The listing-agent +
seller notification the loser attempted already exists, correctly tenant-stamped, at
the survivor's surface (`offer-form-wizard.tsx:notifyListingSide`). The now-unused
`revalidatePath` import and the `OfferCreationParams` interface went with it.

### 4. `app/actions/buyer-offer/handle-multi-offer.ts:checkDuplicateOffer` — WIRED + gated

**The biggest finding in this slice: the offer lifecycle lane had NO WRITER.**

`buyer.offer.draft.created` on `activities(entity_type='offer', entity_id=<offer>)`
is the event that the entire offer state machine derives `DRAFT` from. Readers:
`track-offer-lifecycle.ts:getOfferLifecycleState`, `lib/buyer-offer/expire-offers.ts`,
`lib/buyer-offer/status-sync.ts`, all of `handle-multi-offer.ts`,
`app/components/offer/multi-offer-status-banner.tsx` (buyer-facing), and the
offer-expiry cron. A repo-wide grep for that string finds only readers — **nothing
has ever written it.**

Consequence, live today: `getOfferLifecycleState` returns `{success:false,
error:"Offer not found"}` for every offer that has ever existed. So the buyer's
multi-offer banner always shows zero active offers, the 3-pending cap
(`MAX_PENDING_OFFERS`) can never bind, `checkDuplicateOffer` can never find a
duplicate, `submitOffer` can never move an offer out of DRAFT (there is no DRAFT),
and `offers.status` can never sync from the lane.

Fixes:
- `app/actions/buyer-offers.ts:createOffer` now emits `buyer.offer.draft.created`
  after a successful insert, with `brokerage_id` supplied explicitly (NOT NULL) and
  `error` read and logged loudly rather than swallowed.
- `createOffer` now calls `checkDuplicateOffer` before inserting, when the offer is
  on one of our own listings (`resolvedListingId`). Blocks only a **live**
  non-terminal offer; `DRAFT` is deliberately excluded so an abandoned draft cannot
  lock a buyer out of a property. External/IDX targets have `listing_id = NULL` and
  no key to dedupe on — property_address dedupe is separate, unbuilt work.

Security finding: **`checkDuplicateOffer` was an unauthenticated cross-tenant probe.**
`"use server"`, `createServiceClient()`, no session check of any kind — anyone with a
contact uuid + listing uuid could ask any tenant's database whether that buyer has a
live offer on that property and get back the offer id and its lifecycle state. Now
gated by a new non-exported `requireContactTenant()` (session + contact-belongs-to-
caller's-brokerage, both reads destructuring `error`, fails closed).
`emitMultiOfferEvent` had its own inline copy of that gate; it now shares this one,
so both halves of the module answer to the same tenant. No unattended caller exists
to strand — verified with `grep -rn` across `app/api/cron/`, `app/api/webhooks/` and
the whole tree: `checkDuplicateOffer` had zero callers of any kind.

### 5. `app/actions/portal-seller.ts` — both orphans WIRED, buyer-PII leak closed

**`getSellerOffers` — SECURITY: buyer PII served to the seller.** It selected
`buyer:contacts(id, first_name, last_name, email, phone)` and returned it to
whoever passed the gate — and that gate deliberately admits the SELLER's own
portal session. A seller is entitled to the offer's terms; the buyer's email and
phone belong to the buyer and routinely to a different brokerage. The surface it
replaces was worse still: `app/portal/[contactId]/offers/page.tsx` ran an inline
`select("*, buyer:contacts(*)")` — the buyer's ENTIRE contact record — for a card
that renders their first name.

Now: a portal (`isContactSelf`) caller gets first name + last initial and no
contact channel at all; staff get the full detail they need to work the deal.

**`select("*")` was hiding three column-name bugs** on that page, each rendering as
plausible missing data with no error (verified against the live schema):
- `offers.close_date` does not exist (`closing_date`) → "Closing Date: TBD", always.
- `offers.expires_at` does not exist (`response_deadline`) → the expiry badge never
  rendered.
- `listings.price` does not exist (`list_price`) → `priceVsList` was `NaN`, printed
  as "NaN% below asking" on the seller's offer card.
- `listings.mortgage_balance` does not exist → `NetSheetCalculator` was fed
  `undefined || 0`; the fiction is removed and it is now an explicit 0.
- `contacts.name` does not exist → "Offer from …" fell through to the literal
  "Buyer A".
`getSellerOffers` selects real columns and aliases them to the names the page
renders, so the page keeps working and now shows real values.

The action also matches the seller's listing on EITHER key
(`seller_contact_id` or `contact_id`) — the page resolved through `contact_id`
while the action used only `seller_contact_id`, which would have read back "no
listing" for listings keyed the other way. And both reads now destructure `error`,
with the page showing "Could not load your offers: <reason>" instead of the
identical-looking "No offers yet".

**`getSellerDashboardData` — the shape bug that made it unwireable.** Its
access-denied branch returned `{listing, transaction, contact, agent, …}`: four
keys that are not fields of `SellerContext`, and none of the five that are
(`contactId`, `contactName`, `metrics`, `transactionId`, `agentId`). Any consumer
destructuring the success shape got `undefined` for every one of them the moment
access was refused. It now returns ONE shape with an explicit `accessDenied` flag,
and `app/portal/[contactId]/seller-home.tsx` uses it in place of its inline
`resolveSellerContext` + `getShowingStats` + `getRecentFeedback` +
`getOfferSummary` block — the same four calls, now behind the same
`requireContactAccess` check every other module on that page already went through.

### 6. `app/actions/seller-offers.ts` — both orphans WIRED (file was already gated)

Confirmed the earlier wave's finding: `requireCaller()` +
`verifyListingInCallerBrokerage()` are on every writer here. Both orphans are reads
/ light writes that were correct but had no surface.

**`recordSellerView` — wired, and made provable.** `offers.seller_viewed_at` is what
the agent-side offers manager reads to tell an agent "your seller has seen this
offer", and this action is its ONLY writer. Nothing called it, so the column was
permanently NULL and the "not yet viewed" state was a constant rather than a fact.
It is now called from the seller portal's Offers page — literally the moment it
describes. The update also gained `.select("id")` and an `error` read; it used to
return `{success:true}` whether or not the stamp landed. Returns `newlyViewed`.

**`getOffersForListing` — wired as the truth-refresh in the agent offers manager.**
`app/dashboard/listings/[id]/offers/offers-manager-client.tsx` patched local React
state after Accept and Reject (`setOffers(prev => prev.filter(...))`, flipping
`is_winning_offer` client-side) and never re-read the server, so the screen asserted
the outcome the caller INTENDED rather than the one the database recorded, and
stayed wrong until a full reload. Accept/Reject now call
`getOffersForListing(listing.id)` — auth + listing-in-caller's-brokerage +
tenant-anchored, the authoritative reader — and a failed refresh raises a visible
"this list may be out of date" banner instead of silently keeping stale rows.
`OFFER_LIST_COLUMNS` gained `listing_id` + `form_source` so a refresh returns the
same shape the page renders.

**Adjacent defect fixed (identity class, lesson 7):**
`app/dashboard/listings/[id]/offers/page.tsx` resolved buyer-agent names by looking
`offers.agent_id` up in `users` by id. `offers.agent_id` is an **agents.id**
(`createOffer` writes it through `resolveAgentId`); identity lives on `users` via
`agents.user_id`. Two disjoint uuid spaces, so the map matched nothing and EVERY
offer displayed its buyer agent as "Unknown". Now resolves agents → users → back to
the agents.id the offer rows carry.

### 7. `app/actions/open-house-automation.ts` — both orphans WIRED; **neither could ever have worked**

Both were hardened in wave 4 slice 2 and both were still unreachable, for the same
structural reason nobody had spotted: **they ran on the session RLS client while
serving anonymous visitors.**

Verified live: the RLS policy on `open_house_invitations`, `open_house_attendees`
and `open_house_rsvp_tracking` is
`brokerage_id IS NULL OR brokerage_id = current_user_brokerage_id()`, and
`inviteContacts` writes invitations with the contact's real `brokerage_id`. For an
anonymous invitee `current_user_brokerage_id()` is NULL, the predicate is false, and
the SELECT is REFUSED — so each function's own honest error path
("Could not look up that invitation" / "Could not look up that visit") was the ONLY
answer either endpoint could ever give the people it was written for. Both now use
`createServiceClient()`, with the credential model spelled out in a docblock: the
unguessable id from the emailed link authorizes the call, not a session — and
`handleRSVP` needs BOTH ids and re-checks that the invitation belongs to that event.

**`submitFeedback` — the 404 at the end of the feedback email.**
`sendFeedbackRequestToAttendee` builds `${NEXT_PUBLIC_APP_URL}/open-house/feedback/${attendeeId}`
and mails it to every visitor (`/api/open-house/request-feedback` exposes the send).
**That route did not exist.** Every attendee who tapped it got a 404 — the exact
class `scripts/wired-surface-guard.ts` was written for. Built
`app/open-house/feedback/[attendeeId]/page.tsx` + `feedback-form.tsx`; the form
surfaces the action's partial-outcome messages verbatim ("your rating was recorded
but the detailed feedback could not be saved") instead of a blanket thank-you.

**`handleRSVP` — no link, no page, so `rsvp_response` was permanently NULL.**
`inviteContacts` mails an AI-written invitation with no RSVP link at all, and the
listing's Marketing tab reports on `open_house_invitations.rsvp_response`. Built
`app/open-house/[eventId]/rsvp/[invitationId]/page.tsx` + `rsvp-buttons.tsx`.

REMAINING WORK, precisely: `inviteContacts` must put
`${NEXT_PUBLIC_APP_URL}/open-house/${eventId}/rsvp/${invitationId}` into the email
body and SMS. It has to go in AFTER the staged invitation insert (that insert mints
the id) and BEFORE the `sendOpenHouseInvitation` call — i.e. between
`open-house-automation.ts` lines ~532 and ~540. Not done here because it means
changing the AI-generated invitation copy contract, which is a content decision.
