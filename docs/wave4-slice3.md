# Wave 4 — Slice 3 orphan burn-down (`"use server"` action modules)

38 files, 61 category-C orphaned exports. Every file carries `"use server"`, so every
export is a publicly reachable HTTP endpoint.

Method (owner's): duplicate → merge then delete naming the survivor; not a duplicate →
wire it to its surface, or finish it, or record precisely what finishing needs.
"No caller" is never a deletion rationale.

**Typecheck: NOT RUN** (forbidden in this slice; orchestrator runs one centrally).
Parse-only checks via `esbuild.transformSync`.

## Exact orphan roster (from `scripts/orphan-export-guard.ts --list`)

| file | orphaned exports |
|---|---|
| app/actions/financial-kernel.ts | loadAgentFinancialSummaryAction, loadFinancialWorkspaceAction |
| app/actions/seller-offers.ts | getOffersForListing, recordSellerView |
| app/actions/portal-seller.ts | getSellerDashboardData, getSellerOffers |
| app/actions/lead-signal-ingest.ts | ingestPredictiveSellerSignalAction |
| app/actions/lead-assignment/assign-lead.ts | claimLeadAction |
| app/actions/buyer-offers.ts | getBuyerOffers |
| app/actions/buyer-move.ts | getBuyerMoveCaseAction |
| app/actions/ai-client-gifting.ts | aiPlanBulkGifting, getGiftAnalytics |
| app/actions/campaign-sequences.ts | cancelEnrollment, getSequenceSteps |
| app/actions/video-generation.ts | createAvatarVideo, queueVideoGeneration |
| app/actions/superadmin/platform-controls.ts | getPlatformControlsAction |
| app/actions/superadmin/connector-healing.ts | listPendingProposalsAction, listRecentProposalsAction |
| app/actions/content-studio.ts | saveContentIdea |
| app/actions/content-compliance.ts | quickCheck, validateContentInput |
| app/actions/ai-review-automation.ts | aiCreateRecoveryPlan, aiSetupReviewMonitoring |
| app/actions/ai-offer-creation.ts | submitCompleteOffer |
| app/actions/ai-listing-presentation.ts | generateBrochureContent |
| app/actions/ai-cma.ts | getAIPriceAdjustmentRecommendation |
| app/actions/ai-auto-response.ts | trackBehavioralEvent, updateAutoResponseSettings |
| app/actions/admin/create-subscriber.ts | retrySubscriberInvite |
| lib/ads/facebook-audience-sync.ts | getAudienceSyncHistory, loadFacebookAudiences |
| app/actions/vendor-invite.ts | inviteVendorToPlatformAction, revokeVendorInviteAction |
| app/actions/transactions.ts | setMilestoneClientVisibility |
| app/actions/transaction-inspections.ts | declineInspectionQuoteAction, getInspectionsAction |
| app/actions/social-share.ts | canAgentSharePost, getAgentShareHistory |
| app/actions/podcast-generation.ts | getPodcastAnalytics, getVideoScriptsLibrary |
| app/actions/partner-orders.ts | updateTitleOrderStatus |
| app/actions/onboarding/training.ts | recordVideoProgress |
| app/actions/negotiation-strategy.ts | recordStrategyOutcomeAction |
| app/actions/marketing-cadence-policy.ts | getMyMarketingCadencePolicies |
| app/actions/lifecycle-promo-policy.ts | getMyLifecyclePromoPolicy |
| app/actions/inbox.ts | getInboxMessages, markInboxRead |
| app/actions/crm.ts | updateContactStage |
| app/actions/copilot.ts | createTransactionMilestone, handleCoachingSessionBooked, handleMorningKickoff, handleSuggestionAccepted |
| app/actions/communications.ts | getRecentCommunications |
| app/actions/brand-template-registry.ts | batchClassifyTemplatesAction, batchGetBrandRequirementsAction |
| app/actions/assistant.ts | handleAssistantQuery, handleAutomationTriggered, handleTaskDelegated |
| app/actions/academy.ts | addTemplateFeedback, getTemplateFeedback |

---

## Ledger

### Verification of the inherited flags (done first)

**Flag: "anyone can accept or reject any offer via `submitOffer` / `withdrawOffer` /
`recordSellerResponse` in `app/actions/seller-offers.ts`."**

Verified — **the class is real, the file was wrong.** `app/actions/seller-offers.ts` contains
none of those three functions and is already fully gated (`requireCaller()` +
`verifyListingInCallerBrokerage()` on every writer). A second, differently-shaped search
(`grep -rn "export async function submitOffer\|withdrawOffer\|recordSellerResponse"`)
located them in **`app/actions/buyer-offer/track-offer-lifecycle.ts`**, where all three were
unauthenticated `"use server"` exports on the service client taking a caller-supplied
`userId`. See the entry for that file below.

**Flag: `startOfferDraft` has a forgeable `actor_user_id` on the service client.**
Verified true, plus eight more unauthenticated exports in the same file. See
`app/actions/buyer-offers.ts` below.

---

### `app/actions/buyer-offer/track-offer-lifecycle.ts` — **hardened** (not in the assigned 38; reached via the inherited flag)

**SECURITY FINDING (critical) — anyone could accept, reject or kill any offer on the platform.**

Three `"use server"` exports — `submitOffer`, `withdrawOffer`, `recordSellerResponse` —
authenticated **nothing** while running on `createServiceClient()` (RLS bypassed). The only
"identity" was a `userId` uuid handed in by the caller, used to look up a `brokerage_id`
for the audit row via `?? null`, so the row could be filed under any tenant or under NULL.

Concretely, with only an offer uuid an unauthenticated caller could:
- `recordSellerResponse(offerId, "ACCEPTED")` — **accept any PENDING offer in any tenant.**
  `ACCEPTED`/`REJECTED` are terminal states here, and the activity rows this writes are the
  source `getOfferLifecycleState` derives from, which `buyer-offer/convert-to-transaction.ts`
  and `buyer-offer/handle-multi-offer.ts` both gate on — so a forged acceptance propagates
  into the transaction lane.
- `withdrawOffer(offerId, …, reason)` — kill any live offer (terminal `WITHDRAWN`) with an
  attacker-authored reason on the permanent record.
- `submitOffer(offerId)` — move any draft to PENDING.

**Fixed:** all three now call `requireOfferActor(offerId)`, the gate **already present in
this file** (previously used only by `markOfferExpired`). It proves a session and takes the
tenant from `offers.brokerage_id`, never the caller. `userId` params retained and ignored
(house pattern) so any future call site keeps type-checking. The three `users` lookups that
derived `brokerage_id` from the caller-named id are deleted; `agent_id` still resolves
through `resolveAgentId` (agents.id ≠ users.id).

Callers checked before gating: none of the three has any caller anywhere in the tree, and
`grep` over `app/api/cron/`, `app/api/webhooks/` and the workflow-orchestrator chains found
no unattended lane touching them. Nothing to break.

**Deliberately NOT gated: `getOfferLifecycleState`.** It has a real unattended caller —
`lib/workflow-orchestrator/chains/compliance-transaction-auto-create.ts` reaches it through
`convertOfferToTransaction`, and that chain runs without a session. Per hard-won lesson #1 a
session gate there would silently break the compliance→transaction auto-create chain. It is
a read requiring possession of a specific offer uuid; left open, recorded here.

---

### `app/actions/buyer-offers.ts` — orphans `getBuyerOffers`; **whole module hardened (9 exports)**

`getBuyerOffers` itself was already gated by an earlier wave (`requireContactAccess`) and is
correct. But the flag on `startOfferDraft` was the visible edge of a module in which
**every other export was an unauthenticated service-client endpoint**.

**SECURITY FINDING (critical) — `recordOfferOutcome`: the second "anyone can accept any
offer".** No auth at all, and its first statement was
`.from("offers").update({ status }).eq("id", offerId)` — filtered on the offer uuid **alone**,
not even by the caller-supplied `brokerageId`. Any unauthenticated caller with an offer uuid
could set it `accepted`/`rejected`/`countered` in any tenant, then have `emitLifecycleTransition`
drive that buyer BUYER_OFFER_SUBMITTED → BUYER_UNDER_CONTRACT under a named agent's identity,
and insert a `strategy_outcomes` row — poisoning the corpus that
`getOrGenerateStrategyRecommendation` reads back to price future offers.

**SECURITY FINDING (high) — `createOffer` authenticated but never authorized.** It called
`auth.getUser()`, then ignored the result: `contactId`, `brokerageId` and `agentUserId` all
came from the caller. Any signed-in user (including a buyer with only a portal login) could
create a binding offer on another brokerage's contact under another agent's identity. Worse,
the System J3.1 financial-verification gate was querying `buyer_financial_profiles` on the
caller-named `(contact_id, brokerage_id)` pair — naming a brokerage where that contact id had
a verified profile satisfied the gate for a contact who had none.

Full per-export disposition:

| export | was | now |
|---|---|---|
| `startOfferDraft` | forged `brokerage_id` + `actor_user_id` into `lifecycle_events` | `requireStaffOnContact`; actor = session, tenant = contact row |
| `getConnectedEsignProvider` | open read of ANY brokerage's connected e-sign vendor + account name | tenant = caller's own |
| `searchListingsByAddress` | open cross-tenant inventory + asking-price search | tenant = caller's own |
| `resolveFormSource` | open read of a named contact's uploaded documents + e-sign account | `requireStaffOnContact`; also adds the missing `brokerage_id` anchor on `client_documents`; fails CLOSED to the manual path |
| `getOrGenerateStrategyRecommendation` | open, burns a paid **Claude Opus** call per miss, reads the named brokerage's last 10 offer prices + strategy-outcome history, INSERTs under a caller-named agent | `requireStaffOnContact`; a `listingId` is honoured only if same-tenant |
| `createOffer` | see above | `requireStaffOnContact`; `form.listing_id` must be same-tenant or refused |
| `confirmSigningOrderAction` | open; rewrites WHO LEGALLY SIGNS, and it is the gate `sendOfferForESign` reads | `requireOfferInCallerBrokerage`; update now tenant-anchored |
| `sendOfferForESign` | open; flips any offer to `esign_status:"sent"` | `requireOfferInCallerBrokerage`; `contactId` now read from the OFFER row |
| `recordOfferOutcome` | see above | `requireOfferInCallerBrokerage`; every write tenant-anchored; `statusError` destructured (a refused write used to report success) |

Three new module-private helpers (NOT exported — a `"use server"` file may only export async
functions, and exporting these would mint three more endpoints): `requireStaffOnContact`,
`requireCallerBrokerage`, `requireOfferInCallerBrokerage`.

Notes on the details:
- Authority is read from `user_type` (`users.role` is RETIRED — 19/23 live rows NULL).
- `requireContactAccess` deliberately also admits the contact themselves, which is right for
  the portal READ `getBuyerOffers` but wrong for these agent-only writes — hence the
  stronger `requireStaffOnContact`.
- `offers.contact_id` is nullable. Taking `contactId` from the offer row means it can be
  null, so the two `contacts` lookups in `sendOfferForESign` and the lifecycle transition in
  `recordOfferOutcome` are now skipped rather than passed a null id (lesson #8 — a coerced
  `""` is a `22P02`, not an empty result).
- `recordOfferOutcome` no longer files a `strategy_outcomes` row against a recommendation it
  could not read in-tenant; the offer status change and lifecycle transition still stand.
- **No unattended callers exist for this module** (`grep` over `app/api/cron/`,
  `app/api/webhooks/`, workers). Its one API-route caller,
  `app/api/form-wizard/resolve-provider/route.ts`, already requires a session — and it was
  passing `brokerageId` straight from a query param into `getConnectedEsignProvider`, which
  the gate now overrides with the caller's own tenant.
- Call-site signatures unchanged (params retained, ignored, prefixed `_`), so
  `offers-client.tsx`, `offer-form-wizard.tsx`, `offer-initiation-flow.tsx`,
  `strategy-advisor.tsx`, `FormWizard.tsx`, `offers/new/page.tsx` and the resolve-provider
  route all keep compiling. `scripts/doc-kernel-simulator.ts` greps this file for
  `needsSigningOrder` / `legal_first_name` / `confirmSigningOrderAction` — all three strings
  preserved.

---

### `app/actions/superadmin/connector-healing.ts` — orphans `listPendingProposalsAction`, `listRecentProposalsAction` → **DUPLICATE, merged and WIRED**

Both orphans are the action-shaped twins of two SELECTs inlined in
`app/dashboard/superadmin/connector-healing/page.tsx`. Survivor: **the actions**
(`app/actions/superadmin/connector-healing.ts:listPendingProposalsAction` and
`:listRecentProposalsAction`) — they are gated, reusable, and the approve/reject buttons on
that same page already come from this module. Nothing deleted; the page's two inline queries
are replaced by calls to them.

**Merged from the loser (the page's inline query) onto the survivor**, before wiring:
- `.neq("status", "pending")` on `listRecentProposalsAction`. Without it the action returned
  the pending rows a second time, so "recent history" would have echoed the actionable queue
  rendered directly above it. This is the concrete drift the duplication caused.
- default `limit` 50 → 25, matching the page.
- `failure_signature` kept from the action side (the page's version dropped it; it is what
  tells an operator whether two proposals are the same underlying breakage).

**SECURITY FINDING (medium) — endpoint gate was weaker than the page gate.** The module gated
on `user_type === "superadmin" || isPlatformStaff(platform_role)`, and `PLATFORM_STAFF_ROLES`
is `["superadmin","admin","marketing","support"]`. But the capability matrix
(`lib/platform/platform-staff-roster.ts`) grants `providers` only to `superadmin` and `admin`.
So a **marketing or support platform employee** was redirected off the page by
`requirePlatformCapability("providers")` yet could call these `"use server"` exports directly
to read the queue (vendor doc URLs, raw `failure_sample`, `proposal_payload`) and to
**approve or reject** proposals. Separately, `isPlatformStaff` never consulted the per-role
capability OVERRIDES a superadmin may have set, so a revoked `providers` grant had no effect
on these endpoints.

**Fixed:** the local `assertPlatformStaff` is replaced by `assertProvidersCapability`, which
delegates to `requirePlatformCapability("providers")` — the same gate the page uses — with
`{ requireWrite: true }` on `approveProposalAction` / `rejectProposalAction`. The page keeps
its own gate too (belt and braces), and since the page gate is the *narrower* of the two,
nobody who can currently render the page loses access.

Call sites changed: `app/dashboard/superadmin/connector-healing/page.tsx` (dropped its
`createServiceClient` import and both inline SELECTs).

---

### `app/actions/financial-kernel.ts` — orphans `loadFinancialWorkspaceAction`, `loadAgentFinancialSummaryAction` → **module hardened + both orphans WIRED**

**SECURITY FINDING (critical) — cross-tenant read of any agent's complete financial record.**
Two compounding defects, both in this wrapper:

1. **The caller could replace the session's tenant.** `resolveFinancialContext(brokerageId?)`
   ended with `brokerageId: brokerageId ?? ctx.brokerageId` — a caller-supplied brokerage id
   silently overrode the session's own. Its consumers,
   `loadAgentFinancialDashboardSummaryAction` and `loadAgentProfitLossSummaryAction`, are
   `"use server"` exports taking `{ agentId, brokerageId? }` straight from the client, so the
   kernel's single tenant filter (`loadAgentFinancialSummary`'s
   `.eq("brokerage_id", ctx.brokerageId)`) resolved in the attacker's favour.
2. **The `agentId` was never validated at all.** `lib/kernel/financial.ts:loadAgentFinancialDashboardSummary`
   fans out **eight** queries on the SERVICE client and **six filter on `agent_id` alone**,
   with no brokerage anchor: `business_expenses` (amount, description, **receipt_url**),
   `agent_commissions` (gross commission, agent commission, split %),
   `commission_distributions`, the commission trend series, `agent_commission_profiles`, and
   `agents.select("*")`. So any authenticated user could name any agent uuid and read that
   agent's entire compensation record and expense receipts. Defect 2 stands on its own —
   fixing the tenant override alone would not have closed it.

**Fixed, in the action layer (where authorization belongs — `lib/kernel/financial.ts` is not
in this slice and its kernel functions are correctly "trust the ctx you are handed"):**
- The tenant override is deleted. `_brokerageId` is accepted and ignored; every existing call
  site already passes the caller's own.
- New module-private `authorizeAgentScope(ctx, agentId)`, applied to all three `agentId`-taking
  exports (`loadAgentFinancialDashboardSummaryAction`, `loadAgentProfitLossSummaryAction`, and
  the orphan `loadAgentFinancialSummaryAction`). It requires the named agent to be in the
  caller's brokerage AND the caller to be either that agent or a broker/admin/superadmin —
  an agent may not read a peer's P&L. It destructures `error` and fails CLOSED.
- `ctx.agentId === agentId` compares `agents.id` to `agents.id`; `ctx.userId` is never
  substituted (disjoint id spaces).

Verified before gating: all three existing call sites (`app/dashboard/financials/agent/page.tsx`,
`app/dashboard/financials/agent/agent-financials-client.tsx`,
`app/actions/ai-financial-management.ts`) pass the caller's own `agentId` from
`getAgentContext()`, so the self-or-broker rule breaks none of them. No cron/webhook/worker
caller exists for this module.

**Both orphans wired into `app/dashboard/financials/page.tsx` (Financial Command):**
- `loadFinancialWorkspaceAction` is the kernel's command #1 — it verifies the actor against
  `agents`/`users` and resolves `accessLevel` (personal | team | brokerage | system). The page
  now runs it before rendering any money, and an identity failure renders an honest "we
  couldn't verify your financial identity" card instead of zeroes.
- That `accessLevel` now drives navigation. `app/dashboard/financials/team` and
  `app/dashboard/financials/brokerage` both exist but **Financial Command linked to neither**,
  so a team lead or broker landing there had no route to the view they are entitled to unless
  they knew the URL. Those entry points now render for `team`/`brokerage`/`system` access.
- `loadAgentFinancialSummaryAction` replaces the page's private YTD computation. The page was
  summing `commission_splits.agent_amount` where `status='paid'`, while
  `/dashboard/financials/agent` reports YTD from `agent_commissions` through the kernel —
  **two numbers for one fact inside one section**. Survivor:
  `lib/kernel/financial.ts:loadAgentFinancialSummary` (via
  `app/actions/financial-kernel.ts:loadAgentFinancialSummaryAction`). The card now shows YTD
  agent net, closed-deal count and GCI from that one source. If the summary cannot load the
  card shows "—", never `$0` — a fabricated zero there reads as "you have earned nothing".

Call sites changed: `app/dashboard/financials/page.tsx` (deleted the `commission_splits` YTD
query and its `totalYTD` reduce; added the two kernel calls and the access-level surfaces).

---

### `app/actions/transactions.ts` — orphan `setMilestoneClientVisibility` → **DUPLICATE, WIRED (survivor is the orphan)**

`app/dashboard/transactions/[id]/transaction-detail-client.tsx` had a Switch that ran a **raw
browser-side Supabase update** against `transaction_milestones.is_client_visible`, while the
server action written for exactly that job sat orphaned.

Survivor: **`app/actions/transactions.ts:setMilestoneClientVisibility`**. Loser: the inline
browser-client `.update({ is_client_visible })` in the component (deleted; its optimistic
rollback is kept, now driven by the action's `{ success, error }`).

Why the action is the survivor — two capabilities the inline version could not have:
- it validates the milestone id (`isValidUUID`) before writing;
- it goes through `lib/application/transactions.ts:updateMilestone`, which calls
  `revalidatePath("/dashboard/transactions")`. This flag is read by server-rendered surfaces —
  `app/portal/[contactId]/buyer-home.tsx`, `seller-home.tsx`, `journey/page.tsx`,
  `app/api/portal/ai-chat/route.ts` (which uses `.eq("is_client_visible", true)` as its "never
  expose hidden milestones" gate) — so an un-revalidated write left the client portal showing
  the old visibility.

RLS is confirmed enabled on `transaction_milestones` (`pg_class.relrowsecurity = true`), and
the service layer uses the cookie client, so the write stays RLS-covered; the change is about
one write path and correct revalidation, not about adding a gate.

Call sites changed: `app/dashboard/transactions/[id]/transaction-detail-client.tsx` (import +
the Switch handler).

**Not reached in this file:** the other 57 exports. `transactions.ts` is a thin delegation
layer over `lib/application/transactions.ts` / `lib/kernel/transactions.ts`, and the service
layer uses the cookie client (RLS-covered) rather than the service client — so it is not the
open-service-client shape that the other findings in this slice share. It still deserves its
own pass: several exports (`closeTransaction` and friends) accept `brokerageId` / `agentId`
as parameters, and I did not verify each against the session.

---

### `app/actions/copilot.ts` — orphans `createTransactionMilestone`, `handleSuggestionAccepted`, `handleCoachingSessionBooked`, `handleMorningKickoff`

#### `createTransactionMilestone` → **FINISHED (it was reporting success without doing the thing)**

**DEFECT (high) — every milestone this created was an orphan attached to nothing.** The insert
never set `transaction_id`, and `params.listing_id` — the only thing tying the request to any
deal — was accepted and then **never read**. There is no `listing_id` column on
`transaction_milestones` (verified against the live schema), and `transaction_id` is NULLABLE
there, so Postgres accepted the row without complaint. The milestone was therefore invisible
to the transaction detail page, to the portal journey, and to `checkOverdueMilestones` — while
the action returned `{ success: true, milestone: data }`. `params.responsible_party` was
likewise accepted and silently dropped (no such column).

**Finished:** resolves the listing to its most recent transaction **in the caller's brokerage**
and sets `transaction_id`. A listing with no transaction is now an explicit refusal ("a
milestone needs a deal to hang on"), not a silent orphan. The transaction lookup destructures
`error`, so an RLS refusal is reported as a refusal rather than as "no transaction exists".
`responsible_party` is now documented in the signature as unsupported and ignored, because a
caller passing it today believes an owner was recorded. Live schema verified first
(`information_schema.columns` on `transaction_milestones` and `transactions`).

#### The three `handle*` event handlers → **hardened; their wiring precisely specified**

**SECURITY FINDING (high) — three unauthenticated endpoints writing on a named user's behalf.**
All three take `payload: any`, read a `user_id` out of it, and act as that user, with no
session check whatsoever:
- `handleMorningKickoff` — reads that user's task list and **delivers them a notification**
  (both a read of another agent's day and a notification-spoofing endpoint).
- `handleCoachingSessionBooked` — inserts a `calendar_events` row on that agent's calendar
  plus a `tasks` row, with an attacker-chosen `coach_id` in `attendees`.
- `handleSuggestionAccepted` — accepts any suggestion by id and stamps `acted_by` with a
  caller-chosen user.

They are named "called by orchestrator", but `lib/orchestrator/internal.ts:EVENT_HANDLERS`
states in its own header that the map **is not currently dispatched**, and none of these three
appears in it at all (only `generate7DayPlan` from this file does). So their only reachable
entry point was the HTTP endpoint `"use server"` gives them.

**Fixed:** all three now call the shared `authorizeForUser`. Verified before gating — `grep`
over `app/api/cron/`, `app/api/webhooks/` and the orchestrator found **no unattended caller**
for any of the three, so nothing is turned away today.

**What finishing the wiring needs (recorded, deliberately not half-done):** when the
orchestrator is activated it must NOT call these exports. `emitEventFromCron` runs with a
service credential and no session, so the gate would refuse it — the exact defect hard-won
lesson #1 describes. The unattended lane needs its own door: lift each body into a plain
(non-`"use server"`) module under `lib/copilot/` taking an **injected** Supabase client,
register that function in `EVENT_HANDLERS`, and leave these exports as the gated human-facing
wrappers. A comment block at the top of the handler section says exactly this.

---

### `app/actions/assistant.ts` — orphans `handleAssistantQuery`, `handleAutomationTriggered`, `handleTaskDelegated` → **already gated; gate DE-DUPLICATED**

All three were hardened by an earlier wave with a file-private `authorizeForUser`. Same
orphan class as copilot's handlers and the same unwired-orchestrator story
(`generateAssistantSuggestions` from this file IS in `EVENT_HANDLERS`; these three are not).

Duplicate resolved: the private `authorizeForUser` here and the *missing* equivalent in
`copilot.ts` are now one function — **survivor `lib/auth/authorize-for-user.ts:authorizeForUser`**
(new plain module). The local copy in `assistant.ts` is deleted; call sites unchanged
(`{ ok, error }` contract preserved, so no caller's obligations changed).

Two defects fixed at the survivor rather than ported:
- **Both reads now destructure `error`.** The original used bare `const { data }`, so a
  refused/failed query arrived as `data: null` and was indistinguishable from "this user has
  no row" — in a gate those must not be the same answer. It now fails CLOSED on either.
- **A missing `targetUserId` no longer falls through by accident.** `if (targetUserId && …)`
  meant an absent target skipped the self-check and landed on the role check; an unstated
  target now explicitly requires the act-for-others role.

Kept from the original: authority read from `user_type`, never the RETIRED `users.role`. The
new module is deliberately NOT `"use server"` and does NOT import `server-only`, and it
reaches the Supabase server client through a dynamic `await import(...)` — the
`lib/kernel/crm.ts` pattern — so a `scripts/*-simulator.ts` that transitively imports it
cannot die at load with "This module cannot be imported from a Client Component module"
(hard-won lesson #2).


---

### `app/actions/seller-offers.ts` — orphans `getOffersForListing`, `recordSellerView` → **verified already hardened; a DEAD-LINK defect found; not wired**

Contrary to the inherited flag, this module is fully gated: every writer (`acceptOffer`,
`sendCounterOffer`, `rejectOffer`, `generateSellerPortalLink`, `triggerOfferComparison`,
`analyzeOffer`, `analyzeMultipleOffers`) runs `requireCaller()` +
`verifyListingInCallerBrokerage()`, and both orphans are gated too — `getOffersForListing`
with the same pair, `recordSellerView` with a two-door check (agent-in-brokerage OR
seller-self by `contact_user_id`/email). Nothing to harden.

**DEFECT FOUND (high, not fixed) — "Copy seller portal link" hands the agent a dead URL.**
`generateSellerPortalLink` mints a 32-byte token, writes it into every active offer's
`ai_extracted_data.seller_portal_token` with a 7-day expiry, and returns
`${NEXT_PUBLIC_APP_URL}/seller/offers/${listingId}?token=…`. Verified against the tree:

- **there is no `app/seller` directory at all** — that route 404s;
- **nothing anywhere reads `seller_portal_token` or `seller_portal_expires_at`** (grep across
  `app/` and `lib/` returns only the three writing lines in this file).

So the button in `app/dashboard/listings/[id]/offers/offers-manager-client.tsx:221` reports
"Seller portal link copied — expires <date>", the agent sends it to their seller, and the
seller gets a 404. This is the "reports success without doing the thing" class.

`recordSellerView` is the orphan that belongs to that missing page — and note it currently
requires an authenticated session (`auth.getUser()`), which a bearer-token visitor does not
have. **What finishing needs:** (1) a `lib/offers/seller-portal-token.ts` verifier checking
token + expiry against the offers' jsonb; (2) `app/seller/offers/[listingId]/page.tsx`
rendering the offers read-only for a valid token (the existing `OFFER_LIST_COLUMNS` carries no
buyer PII, which is the right shape); (3) a **token door** on `recordSellerView` alongside the
two session doors — per hard-won lesson #1 the unattended/anonymous caller needs its own
credential path, and here the token IS the credential. I did not build this: it is a new
PII-bearing public surface and deserves its own deliberate pass, not a rushed one at the end
of a slice. The alternative — repointing the link at the existing `/portal/[contactId]/offers`
— changes the product from "no-login share" to "seller must have a portal account", which is a
product decision, not a cleanup.

`getOffersForListing` is the action-shaped twin of the inline RSC read in
`app/dashboard/listings/[id]/offers/page.tsx` (which uses the cookie client, so RLS-covered
and safe). They have drifted — the action omits `form_source` and excludes rejected offers;
the page includes both. **Not merged, and I want to be explicit that this is unfinished, not
"fine":** `offers-manager-client.tsx` mutates its `offers` state optimistically after every
accept/reject/counter and never refetches, so a counter created by a colleague, or the
server-side fields `acceptOffer` writes, are invisible until a full reload. The right finish
is to align `getOffersForListing` to the page's column set (add `form_source`, make the
rejected filter opt-in) and use it for BOTH the RSC read and a post-action reconcile in the
client. I ran out of slice before doing it.

---

### `app/actions/portal-seller.ts` — orphans `getSellerDashboardData`, `getSellerOffers` → **verified already hardened; not wired**

Every export goes through a `requireContactAccess` gate that resolves the tenant from the
contact row. Both orphans are correct as written and I found no defect in them.

Neither is wired because `app/portal/[contactId]/seller-home.tsx` composes the same data from
the lower-level `lib/portal/resolve-seller-context` helpers directly (`resolveSellerContext` +
`getShowingStats` + `getRecentFeedback` + `getOfferSummary`) — which is precisely what
`getSellerDashboardData` does in one gated call. That is a genuine duplicate-by-composition,
survivor `app/actions/portal-seller.ts:getSellerDashboardData`.

`getSellerOffers` has the stronger case: `app/portal/[contactId]/offers/page.tsx`'s SELLER
branch inlines `select("*, buyer:contacts(*)")` — **it hands the seller the buyer's entire
contact record**, where `getSellerOffers` selects an explicit, minimal column set. That page
also reads three fields that do not exist on the rows it has (`listing.price` — the column is
`list_price`; `offer.buyer?.name`; `offer.expires_at` — the column is `response_deadline`), so
its "% vs list" is `NaN` and its expiry badge never renders. Wiring it to `getSellerOffers`
fixes the PII leak and those three fields together. **Not done** — that page is ~600 lines of
branching JSX and a rushed rewire is exactly how the `listing.price` class of bug gets made
again. Recorded as the next concrete task on this file.

---

### `lib/ads/facebook-audience-sync.ts` — orphans `loadFacebookAudiences`, `getAudienceSyncHistory` → **verified intact; NOT touched**

Confirmed as instructed: the module is session-gated (`resolveAdsActor` + `canAccessFeature`)
and the nightly cron `app/api/cron/sync-facebook-audiences/route.ts` still imports
`syncAudience as kernelSyncAudience` from `lib/kernel/ads` — the kernel command directly, NOT
the action. **I made no edit to this file or that cron**, so the unattended door is unchanged.

Both orphans are reads that the ads workspace already satisfies another way:
`app/dashboard/campaigns/ads/page.tsx` loads `workspace.audiences` through the kernel and
passes them to the client, and the embedded `audience_sync_runs` come with them.
`getAudienceSyncHistory`'s own comment says as much. What is actually missing is a UI: the
client at `ads-dashboard-client.tsx:1061` reads only `audience.audience_sync_runs?.[0]` — the
latest run — so the full history is fetched and then thrown away.
`getAudienceSyncHistory` is the door for a "view sync history" affordance that was never built,
and `loadFacebookAudiences` is the client-side refresh door for a list the client currently
only mutates optimistically after create/sync/approve/delete. Left as-is with that reasoning.

---

### `app/actions/lead-signal-ingest.ts` — orphan `ingestPredictiveSellerSignalAction` → **verified; NOT touched**

Confirmed the earlier wave's hardening is in place (fail-closed tenant gate on all three
exports before any delta is built). Confirmed the recorded follow-up is still outstanding:
`app/api/cron/lead-scraping/route.ts` does **not** import `applySignalDelta` or any of this
module's exports. The library entry point `lib/lead-intelligence/signal-extensions.ts:applySignalDelta`
is exported and callable, and the file's own comment (line ~144) already names it as the door
the unattended pipeline should use. I did not add that wiring: choosing WHERE in a ~40-import
scraping cron the signal should be emitted, and with what dedupe key, is a lead-pipeline
decision I could not make safely at the end of this slice. The door exists; the caller does not.

---

## Files NOT reached

Fully untouched — no read, no triage beyond the auth-primitive census below:

`app/actions/lead-assignment/assign-lead.ts` · `app/actions/buyer-move.ts` ·
`app/actions/ai-client-gifting.ts` · `app/actions/campaign-sequences.ts` ·
`app/actions/video-generation.ts` · `app/actions/superadmin/platform-controls.ts` ·
`app/actions/content-studio.ts` · `app/actions/content-compliance.ts` ·
`app/actions/ai-review-automation.ts` · `app/actions/ai-offer-creation.ts` ·
`app/actions/ai-listing-presentation.ts` · `app/actions/ai-cma.ts` ·
`app/actions/ai-auto-response.ts` · `app/actions/admin/create-subscriber.ts` ·
`app/actions/vendor-invite.ts` · `app/actions/transaction-inspections.ts` ·
`app/actions/social-share.ts` · `app/actions/podcast-generation.ts` ·
`app/actions/partner-orders.ts` · `app/actions/onboarding/training.ts` ·
`app/actions/negotiation-strategy.ts` · `app/actions/marketing-cadence-policy.ts` ·
`app/actions/lifecycle-promo-policy.ts` · `app/actions/inbox.ts` · `app/actions/crm.ts` ·
`app/actions/communications.ts` · `app/actions/brand-template-registry.ts` ·
`app/actions/academy.ts`

### Triage census for the next agent (auth primitives vs exports)

Counted with
`grep -cE "getAgentContext|auth\.getUser|requireAuth|resolveWriteContext|requirePlatformCapability|requireWriteContext|requireContactAccess|getSession|requireSuperadmin|requireCaller"`.
A low ratio is a hint, not proof — confirm with a second, differently-shaped search before
acting on it (hard-won lesson #6).

**Start here — lowest authority-per-export:**

| file | exports | auth primitives | `createServiceClient` uses |
|---|---|---|---|
| `app/actions/brand-template-registry.ts` | 12 | 2 | 0 |
| `app/actions/inbox.ts` | 7 | 2 | 0 |
| `app/actions/ai-review-automation.ts` | 6 | 2 | 0 |
| `app/actions/buyer-move.ts` | 4 | 1 | 0 |
| `app/actions/crm.ts` | 11 | 6 | 4 |
| `app/actions/communications.ts` | 11 | 6 | 6 |
| `app/actions/negotiation-strategy.ts` | 7 | 4 | 5 |
| `app/actions/ai-client-gifting.ts` | 7 | 3 | 0 |
| `app/actions/ai-offer-creation.ts` | 12 | 7 | 2 |
| `app/actions/academy.ts` | 7 | 4 | 0 |

Files whose census looks healthy (auth primitives ≥ exports) and which are therefore lower
priority: `video-generation.ts`, `podcast-generation.ts`, `content-studio.ts`,
`content-compliance.ts`, `ai-auto-response.ts`, `transaction-inspections.ts`,
`superadmin/platform-controls.ts`, `onboarding/training.ts`, `lifecycle-promo-policy.ts`,
`partner-orders.ts`, `ai-listing-presentation.ts`, `ai-cma.ts`, `campaign-sequences.ts`.

**Note the two shapes this slice showed are NOT caught by that census:**
1. A file can call `auth.getUser()` and then ignore the result — `buyer-offers.ts:createOffer`
   scored an auth primitive and was still fully forgeable.
2. A gate can be present but *weaker than the page's* — `superadmin/connector-healing.ts`
   scored a primitive and still let `marketing`/`support` staff approve proposals.

---

## Summary of changes

**Files edited (10):**
- `app/actions/buyer-offer/track-offer-lifecycle.ts` — gated 3 endpoints
- `app/actions/buyer-offers.ts` — gated 9 endpoints, 3 new private helpers
- `app/actions/financial-kernel.ts` — removed tenant override, new `authorizeAgentScope` on 3 endpoints
- `app/actions/superadmin/connector-healing.ts` — gate raised to the `providers` capability; `listRecentProposalsAction` merged
- `app/actions/copilot.ts` — `createTransactionMilestone` finished; 3 handlers gated
- `app/actions/assistant.ts` — private gate replaced by the shared one
- `app/dashboard/financials/page.tsx` — both financial orphans wired; `commission_splits` YTD deleted
- `app/dashboard/superadmin/connector-healing/page.tsx` — inline SELECTs replaced by the two orphan actions
- `app/dashboard/transactions/[id]/transaction-detail-client.tsx` — raw browser write replaced by the orphan action
- `docs/wave4-slice3.md` — this file

**File created (1):** `lib/auth/authorize-for-user.ts`

**Deletions:** no file or export deleted. Three blocks of *duplicated logic* removed, each
with a named survivor:
- inline `is_client_visible` update in `transaction-detail-client.tsx` →
  `app/actions/transactions.ts:setMilestoneClientVisibility`
- two inline SELECTs in `connector-healing/page.tsx` →
  `app/actions/superadmin/connector-healing.ts:listPendingProposalsAction` / `:listRecentProposalsAction`
- `commission_splits` YTD sum in `dashboard/financials/page.tsx` →
  `lib/kernel/financial.ts:loadAgentFinancialSummary` (via `app/actions/financial-kernel.ts:loadAgentFinancialSummaryAction`)
- private `authorizeForUser` in `app/actions/assistant.ts` → `lib/auth/authorize-for-user.ts:authorizeForUser`

**Verification:** all 10 edited files parse clean via `esbuild.transformSync`. `tsc` /
`npm run type-check` / `npm run guard` NOT run, per slice instructions.
