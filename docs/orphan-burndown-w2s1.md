# Orphan burndown — wave 2, slice 1 (`"use server"` action modules)

Working notes, appended as each export is finished.

Method (the owner's rule): (a) duplicate? → **merge first**, then delete, naming
the survivor `file.ts:fn`. (b) not a duplicate? → **wire it**, or finish it, or
record precisely what finishing needs and leave the code. "No caller" is never a
deletion rationale. Hardening an endpoint without wiring it is a good outcome and
it stays in the census.

**Scope constraint.** I may WRITE only the orphan-bearing modules in my slice
plus this file. Consumer surfaces (pages, components, route handlers) belong to
nobody's slice; "wire it" verdicts are therefore recorded as a precise wiring
instruction naming the consumer file and call site, not as a code change.

**I did NOT run `tsc` / `npm run type-check` / `npm run guard`** — instructed not
to; the orchestrator typechecks centrally.

---

## SECURITY FINDINGS — READ FIRST

Every export in these files is `"use server"`, i.e. a publicly reachable HTTP
endpoint. The following were reachable **with no authentication at all** before
this pass. Each is now gated; details in the per-export ledger.

### A. Reachable with NO authentication at all — now gated

| Endpoint | What an anonymous caller could do |
|---|---|
| `buyer-execution.ts:getBuyerUpdateHistory` | **Service-client read, RLS bypassed.** Any contact uuid returned that buyer's financial audit trail — lender confirmations, **gate overrides**, forced lifecycle advances — with actor and metadata. |
| `buyer-execution.ts:logBuyerAction` | **Forge audit entries.** Caller chose contact, event type (free string), acting user id, source and metadata — writing into the same feed the line above reads back *as an audit trail*. |
| `buyer-offer/track-offer-lifecycle.ts:markOfferExpired` | **Kill any live offer.** Service client, no session; `EXPIRED` is terminal, so a real buyer's offer became unrespondable. Tenant of the audit row came from the caller. And `expiration_reason: "deadline_passed"` was asserted **without ever reading the deadline**. |
| `ai-review-automation.ts:aiCreateRecoveryPlan` | Read any contact's full row + all transactions + all interactions, spend a **gpt-4o** call, and write a note + lifecycle event into that tenant's ledger. |
| `ai-direct-mail.ts:aiAnalyzeCampaignPerformance` | Read any agent's mailed-campaign history incl. spend, and bill a **gpt-4o-mini** call. The `canAccessFeature()` line looked like a gate; it is an *entitlement* check. |
| `ai-direct-mail.ts:trackCampaignResponse` | The **`trackDelivery` class**: `tracking_id` is `dm-<Date.now()>-<9 chars>` and is *printed on the mail piece*. Anyone could inflate another brokerage's paid-mail response rate — the numerator of its cost-per-response. |
| `ai-direct-mail.ts:getDirectMailAnalytics` | Read another brokerage's marketing budget from one uuid. |
| `contact-enrichment.ts:enrichContactsBatch` | **Unbounded paid vendor spend.** No session, no cap: each id costs a PeopleData call + an OSINT call, aimed at any tenant's contacts. |
| `communications.ts:getRecentCommunications` | Read **full SMS/email bodies** for any contact uuid. |
| `lib/ads/ad-monitor.ts:ingestCompetitorAd` / `:ingestCompetitorPost` | Write arbitrary rows into any tenant's competitor tables — and those rows are later fed into an LLM prompt by `generateInsights`, i.e. a **prompt-injection channel into another tenant's AI spend**. |
| `social/generate-social-post.ts:stampPostBrandCompliance` | **Compliance stamp**, not a read: evaluate another tenant's post against a *different* brokerage's ruleset and write `brand_compliance_passed`. |
| `social-share.ts:canAgentSharePost` | Compliance gate with a caller-chosen tenant. (It did at least fail closed.) |
| `ai-review-automation.ts:aiSetupReviewMonitoring`, `social-share.ts:getAgentShareHistory`, `neighbor-notifications.ts:listNeighborCampaignsForListing`, `buyer-execution.ts:handleBuyerVoiceAssistant`, `academy.ts:getTemplateFeedback`, `brand-template-registry.ts:batch*` | Cross-tenant reads/writes and an unbounded synchronous loop; detail in the ledger. |

### B. Authenticated but NOT tenant-scoped — now scoped

| Endpoint | What any signed-in user could do |
|---|---|
| `ai-content-generation.tsx:saveDescriptionToListing` | Overwrite **any** listing's `public_remarks` (MLS-facing copy), and flip **any** `ai_generated_content` row to `compliance_approved: true` — a compliance attestation settable by a stranger. |
| `ai-calendar-management.ts:createDeadlineEventsFromMilestones` | Read another transaction's milestones and mint `is_system_generated` deadline events **inside a brokerage they don't belong to**. |
| `ai-listing-presentation.ts:generateBrochureContent` | `select("*")` on any brokerage's `agents` row; phone/email went into the brochure and the model prompt. |

### C. Still unauthenticated — **NOT changed** (outside my assignment; flagged for the next pass)

These are wired exports in files I own but on exports I was not assigned. Listed
worst-first. Every one is a `"use server"` export reachable with no session.

1. `buyer-execution.ts:adminOverrideFinancialVerification` — override a buyer's financial gate, caller-supplied actor.
2. `buyer-execution.ts:agentAdvanceBuyer` — force a buyer's lifecycle stage.
3. `neighbor-notifications.ts:launchNeighborNotification` — **sends outbound notices to identified neighbours**, billed to a caller-chosen tenant; `grantSellerPermission` records the consent that authorises it.
4. `ai-review-automation.ts:aiGenerateReviewRequest` — writes `review_requests` and drives an outbound review ask, caller-supplied `agentId`.
5. `buyer-offer/track-offer-lifecycle.ts:submitOffer` / `withdrawOffer` / `recordSellerResponse` — **anyone can accept or reject any offer on the platform**; service client, caller-supplied actor.
6. `lib/ads/ad-monitor.ts:generateInsights` — unauthenticated **AI spend**, caller-supplied `brokerageId`; also `resolveAlert` (write) and the four `get*` readers.
7. `social-share.ts:shareListingPost` — writes the share row and fires the publish kernel event, caller-supplied `agentUserId` + `brokerageId`.
8. `ai-calendar-management.ts:createAppointment` / `updateAppointment` / `cancelAppointment` / `getAppointments` — mutate any `calendar_events` row by id alone.
9. `ai-review-automation.ts:aiDetermineReviewTiming`, `aiAnalyzeReviewSentiment`, `aiGenerateReviewResponse` — caller-supplied `agentId`, AI spend.

A ready-to-use, correctly-shaped gate now exists **in each of those files**
(`requireAgentScope`, `requireContactAccess`, `requireOfferActor`,
`requireBrokerage`, `getAgentContext`), so the follow-up is mechanical.

---

## Per-export ledger

_(appended as each is finished)_

### `app/actions/ai-review-automation.ts:aiCreateRecoveryPlan` — **HARDENED IN PLACE**

Not a duplicate — no other recovery-plan producer exists (`grep -r "recovery_plan"`
finds only this file and the note rows it writes). It is an advanced feature worth
having, and it was *reachable by anyone*.

Before: `"use server"`, so a public HTTP endpoint, with **no authentication of any
kind**. It took `agentId` and `clientId` from the caller and:

1. selected `contacts(*)` joined to `transactions(*)` and `interactions(*)` for
   that contact id — the full PII row plus every deal and every logged
   conversation — with no tenant predicate;
2. spent a **gpt-4o `generateObject` call** on the platform's budget, per request,
   with caller-controlled prompt text (`reviewText`);
3. wrote an `ai_assistant_notes` row **and** a `lifecycle_events` row into
   whichever brokerage the supplied agent id belonged to.

So: unauthenticated cross-tenant PII read + unauthenticated AI spend +
unauthenticated write into a stranger's audit ledger, from one guessed uuid.

After: new file-local `requireAgentScope()` (not exported — it does not become a
new endpoint) resolves the actor from the session. `ctx.agentId` **is**
`agents.id`, so it is used directly rather than substituted from `users.id` — the
two spaces are disjoint here. A caller-supplied `agentId` is honoured only when it
resolves to an `agents` row **inside the caller's own brokerage** *and* the caller
holds a supervising role (broker / broker_admin / admin / superadmin / team_lead /
tc), which preserves the legitimate "broker acts for their agent" path. The
`agents` probe destructures `error` — a refused read is reported as a refusal, not
laundered into "no such agent" — and fails closed either way.
The `contacts` read is now pinned with `.eq("brokerage_id", gate.brokerageId)` and
`.single()` → `.maybeSingle()` (a missing row is an answer, not a throw). The two
writes take `brokerage_id` from the session gate instead of from the caller's
agent id.

### `app/actions/ai-review-automation.ts:aiSetupReviewMonitoring` — **HARDENED IN PLACE**

Same class, same file, same fix. Was an **unauthenticated write** of a monitoring
config note into an arbitrary tenant's `ai_assistant_notes`, keyed on a
caller-supplied agent id. Now gated by `requireAgentScope`; `brokerage_id` comes
from the session. Also added the input validation the endpoint never had:
`platforms` must be a non-empty array and `alertThreshold` must be a finite star
rating in 1..5 (it was written into the config note and echoed back to the user
unchecked).

> **Neighbours in the same file are also unauthenticated and I did NOT change
> them** (they are wired exports outside my assignment, and altering their gates
> could break their callers mid-wave):
> `aiDetermineReviewTiming`, `aiGenerateReviewRequest`, `aiAnalyzeReviewSentiment`
> (L362) and `aiGenerateReviewResponse` (L590) all take `agentId` from the caller
> with no session. `aiGenerateReviewRequest` in particular writes a
> `review_requests` row and sends an outbound review ask. **Recommend a follow-up
> pass applies `requireAgentScope` to all four** — the helper is already in the
> file and takes the same shape.

### `app/actions/ai-direct-mail.ts:getDirectMailAnalytics` — **HARDENED IN PLACE**

Not a duplicate. The nearest sibling, `app/actions/ai-direct-mail.ts:getDirectMailCampaigns`,
was already session-scoped in an earlier pass and returns *rows*; this returns the
derived spend/response/cost-per-response roll-up. Different output, same tenant
question — so the fix is to make it answer that question the same way its
remediated sibling does, not to delete it.

Before: **no authentication**. Filtered on a caller-supplied `agent_id` and
returned campaign name, quantity, per-piece and total cost, response count and
cost-per-response — another brokerage's marketing budget, from one uuid.

After: `agentId` ignored, `ctx.agentId` + `ctx.brokerageId` from `getAgentContext()`,
both predicates applied (a mismatched uuid is a *valid* query returning zero rows,
so tenant scope has to be stated). `campaignId` is UUID-validated. The read now
destructures `error` — previously `const { data: campaigns }` turned a refused
read into "this agent has no campaigns", which is exactly the wave-1
`checkSuppression` failure mode in a reporting skin.

### `app/actions/ai-direct-mail.ts:aiAnalyzeCampaignPerformance` — **HARDENED IN PLACE**

**The `canAccessFeature(params.agentId, "direct_mail")` line looked like a gate and
was not one.** It is an *entitlement* check — "is this agent's plan allowed direct
mail" — which any caller satisfies by naming an agent whose plan is. That was the
endpoint's only barrier. With it, anyone could: read an arbitrary agent's entire
mailed-campaign history *including the response rows*, have it serialised whole
into a prompt, and bill a **gpt-4o-mini** call to the platform. Unauthenticated
AI spend stacked on an unauthenticated cross-tenant read.

After: session gate first, `agentId`/`brokerageId` ignored and derived, the
entitlement check kept but run against the *resolved* agent, and both predicates
on the campaign read. Two additional refusals were added **before** the model call
so the platform does not pay for a prompt built from nothing: a refused read is
reported as a refusal, and an empty campaign list returns early instead of
spending tokens on `Campaigns: []`.

### `app/actions/ai-direct-mail.ts:trackCampaignResponse` — **HARDENED IN PLACE**

This is the **`trackDelivery` class** wave 1 found, in a different subsystem.
`"use server"` made it a public endpoint whose only key was `tracking_id` — a
low-entropy string minted in this same file as `dm-<Date.now()>-<9 base36 chars>`
and **printed on the physical mail piece**. Anyone holding or guessing one could
post unlimited `qr_scan` / `call` / `website_visit` / `form_submission` rows
against another brokerage's paid campaign. Those rows are the numerator of the
response-rate and cost-per-response figures the two exports above report, so this
was a write into a stranger's marketing P&L.

After: authenticated, and the campaign lookup is pinned to the caller's own
brokerage. The tenant id handed to `logResponse` still comes from the campaign row
(never from the caller) and is now cross-checked against the session. The lookup
destructures `error`, so a blocked read is no longer indistinguishable from a bad
tracking id.

Design note recorded in the code: the **anonymous** QR path does not run through
here — `/api/qr/scan?slug=…` records scans itself and is the surface built for
untrusted visitors. This action is the operator-side logger ("the seller called
off the postcard"), so gating it is correct rather than restrictive. A genuinely
public response sink belongs in a route handler with rate limiting and a
high-entropy token, not on a server action.

### `app/actions/buyer-execution.ts` — three exports, one gate (**HARDENED IN PLACE**, gate WIRED from an existing survivor)

Not duplicates. Each is the server-action face of a distinct
`lib/buyer-execution/*` engine function. The problem was not what they do, it was
that **the entire module had no authentication** — all nine exports, `"use
server"`, taking `contactId` and the acting `userId` from the caller.

I did not write a new gate. `lib/portal/require-contact-access.ts:requireContactAccess`
already exists and already encodes the exact rule this module needs: it admits the
**contact themselves** (linked `contact_user_id` or matching email) *and*
same-brokerage staff. That matters — the sibling gate
`lib/auth/contact-access.ts:assertCanActOnContact` is staff-only and would have
locked buyers out of their own portal, which is this file's `source:
'buyer_portal'` path. Choosing the right one of the two was the whole decision;
it is recorded in a comment at the import so the next person does not "simplify"
it back.

- **`getBuyerUpdateHistory`** — the worst of the three. The helper it delegates to,
  `lib/buyer-execution/multi-party-updates.ts:getMultiPartyUpdateHistory`, reads
  `activities` through **`createServiceClient()`** filtered on
  `entity_id = contactId` alone. Service role ⇒ **RLS not in play**, so a contact
  uuid was the only thing between an anonymous caller and any buyer's financial
  audit trail: `buyer.financial.lender_confirmed`,
  `buyer.financial.gate_overridden`, `buyer.lifecycle.agent_advanced`, with actor
  and metadata. Structurally identical to the wave-1 `batchEvaluateLeadReadiness`
  finding. Now gated; `limit` is also clamped to 1..200 (it went straight into
  `.limit()`).
- **`logBuyerAction`** — an **unauthenticated audit-log writer**. Caller chose the
  contact, the event type (free string), the acting user id, the source and the
  metadata. You could write `buyer.financial.gate_overridden` attributed to
  someone else's broker into someone else's activity feed — the same feed
  `getBuyerUpdateHistory` reads back *as an audit trail*. Now gated, the actor is
  the session's user, and `actionType` must match `^buyer\.[a-z0-9_.]{1,60}$` so a
  generic logger cannot counterfeit another subsystem's events.
- **`handleBuyerVoiceAssistant`** — unauthenticated, and it stamped the
  `buyer.voice.interaction` activity with a caller-supplied `userId`. Now gated;
  `userId` ignored and taken from the session.

> **The other six exports in this file are still unauthenticated and I did NOT
> change them** (outside my assignment): `getBuyerJourney`,
> `checkBuyerCanPerformAction`, `lenderConfirmBuyerFinancials`,
> `agentConfigureBuyerSearch`, **`adminOverrideFinancialVerification`** and
> `agentAdvanceBuyer`. The last two are the ones to fix next — an override of a
> buyer's financial gate and a forced lifecycle advance, both reachable with no
> session and a caller-supplied actor id. `requireContactAccess` is now imported
> in the file and drops straight in.

### `app/actions/buyer-offer/track-offer-lifecycle.ts:markOfferExpired` — **HARDENED IN PLACE + one silent-lie bug fixed**

Not a duplicate — it is the fourth writer of a four-state machine whose three
siblings (`submitOffer`, `withdrawOffer`, `recordSellerResponse`) live in the same
file. Deleting it would leave the machine unable to reach `EXPIRED`.

Three defects, all riding on the same missing gate. The module runs on
`createServiceClient()`, so **RLS was not in play**, and the export took only an
offer uuid and a `systemUserId` — neither checked against a session.

1. **Anyone could kill any live offer.** `EXPIRED` is terminal (`is_terminal`), so
   the buyer's offer — real money against a real deadline — became unrespondable.
   `getOfferLifecycleState` is what `submitOffer`, `withdrawOffer`,
   `recordSellerResponse`, `canBuyerSubmitOffer` and the buyer-facing multi-offer
   banner all gate on, so the effect propagates through the whole domain.
2. **The tenant of the audit row came from the caller.** `brokerage_id` was read
   off whatever `users` row the caller named — so the expiry event could be filed
   under an unrelated brokerage, or under `null`, because `?? null` silently
   accepted a user id that resolved to nothing. It now comes from
   `offers.brokerage_id`, verified live as a real column on `offers`.
3. **`expiration_reason: "deadline_passed"` was asserted and never verified.** The
   payload has always claimed the deadline passed without once reading
   `offers.response_deadline`. An offer with three days left could be expired on
   the spot and the audit trail would attest to a deadline that had not arrived.
   The check is now real — no deadline, or a future deadline, is a refusal — and
   the actual `response_deadline` is recorded in the notes payload so the claim is
   checkable after the fact.

Added a file-local **non-exported** `requireOfferActor()` (not exported precisely
because this is a `"use server"` module — exporting it would mint another public
endpoint). Both of its reads destructure `error`, so an RLS refusal is never
rendered as "offer not found". `systemUserId` is ignored; the actor is the
session's user and is still RESOLVED to `agents.id` via `resolveAgentId` rather
than substituted, since `users.id` and `agents.id` are disjoint here.

Recorded, not done: the "system" in `systemUserId` implies a scheduled expiry job.
A `"use server"` export is not a system channel. A cron that needs to run this
without a session should go through a route handler holding a service credential —
naming a user id over HTTP is not authentication.

> **The three sibling writers have the identical missing gate and identical
> caller-derived `brokerage_id`, and I did NOT change them** (outside my
> assignment): `submitOffer`, `withdrawOffer`, `recordSellerResponse`. Anyone can
> currently accept or reject any offer on the platform. `requireOfferActor` is in
> the file and drops straight in.

### `app/actions/contact-enrichment.ts:enrichContactsBatch` — **HARDENED IN PLACE (vendor-spend hole)**

Not a duplicate — it is the batch face of `enrichContact` in the same file.

Before: `"use server"`, **no session**, and an **unbounded caller-supplied array of
contact ids**. Every id costs a `PeopleDataClient` call *and* an
`OSINTClient.searchPerson` call — paid, per-lookup, third-party vendor spend — and
writes the result (emails, phones, addresses, and inferred life events such as
divorce / bankruptcy / death in family) onto the contact row. An anonymous caller
could therefore bill the platform for arbitrarily many external lookups and aim
them at other tenants' contacts. The 500 ms sleep between ids also meant a single
request could hold a server worker open indefinitely.

After, in order of importance: session gate (matching this file's existing
`getUnenrichedContacts` tenant-anchor idiom) → **tenant filter applied before any
money is spent** (the ids are resolved against `contacts` scoped to
`ctx.brokerageId`; only survivors are enriched) → batch cap of 200. Ids that are
not the caller's are counted as `failed`, not `skipped`, so a caller fishing with
foreign uuids learns nothing about whether they exist. The scope read destructures
`error`: here the difference between "refused" and "none of these are yours" is
the difference between refusing and spending money.

### `app/actions/contact-enrichment.ts:markLifeChangeNotified` — **FINISHED** (was a no-op that reported success)

It logged the id and returned `{ success: true }` without touching anything. So
"we've told the agent about this divorce" was never recorded, every render
re-surfaced the same notification forever, and the endpoint reported it handled.
A function that claims a write it did not perform is worse than one that refuses.

Both stated blockers turned out to be wrong beliefs, not obstacles:

- The comment claimed life events live in `contact_enrichment_data.life_events`.
  **There is no `contact_enrichment_data` table** — confirmed against the live
  schema. They live in `contacts.life_events` (jsonb), which is exactly where
  `enrichContact` and `checkContactLifeChanges` in this same file write them.
- It took a `changeId`, but the array elements this codebase writes are
  `{ type, details, detected_at, confidence }` — **no id on them**. The
  de-duplication in `checkContactLifeChanges` keys on the event *type*, so type is
  the element's identity for a given contact. Signature is now
  `(contactId, eventType)` — the key that exists rather than one that does not.
  Safe to change: the export was orphaned.

Now: session-gated, tenant-scoped on both the read and the write, stamps
`notified_at` on the matching element, and returns an honest failure when there is
no un-notified event of that type. Non-atomicity of the jsonb read-modify-write is
documented in the code: the only field set is an idempotent marker, so a lost
update re-shows one notification rather than corrupting data.

### `app/actions/communications.ts:getRecentCommunications` — **HARDENED IN PLACE**

Not a duplicate — the other readers in this file are per-channel; this is the
unified recent-message read. Before: `"use server"`, **no session**, and
`.eq("contact_id", contactId)` as the *only* predicate, so a contact uuid returned
**the full bodies of every SMS and email exchanged with that person**. The
`messages` table's RLS was the sole barrier — the same single-layer assumption
this codebase has already been burned by. Now: session-gated, `.eq("brokerage_id",
ctx.brokerageId)` added (verified live as a real column on `messages`), and
`limit` clamped to 1..200 rather than passed straight into `.limit()`.

### `app/actions/neighbor-notifications.ts:listNeighborCampaignsForListing` — **HARDENED IN PLACE**

Before: no session, `.eq("listing_id", …)` only. A listing uuid returned another
brokerage's neighbour-campaign posture — whether seller permission was granted,
how many neighbours had already been mailed. Now session-gated and scoped on
`brokerage_id` (verified live on `neighbor_notification_campaigns`).

> **The other three exports in this file are unauthenticated AND run on
> `createServiceClient()` with a caller-supplied `brokerageId` / `agentUserId`,
> and I did NOT change them**: `createNeighborNotificationCampaign`,
> `grantSellerPermission`, **`launchNeighborNotification`**. The last one sends
> physical/electronic notices to identified neighbours — unauthenticated outbound
> messaging billed to a tenant chosen by the caller — and `grantSellerPermission`
> records the seller consent that authorises it. High priority for the next pass.

### `app/actions/academy.ts:getTemplateFeedback` — **HARDENED IN PLACE (low stakes, recorded honestly)**

The academy marketplace is deliberately cross-brokerage, so there is no tenant
predicate to add and none is claimed. But the rows are free-text comments written
by named users and `"use server"` made reading them anonymous. Now requires a
session, matching its write-side sibling `addTemplateFeedback` directly above,
which always did.

### `app/actions/social-share.ts:getAgentShareHistory` — **HARDENED IN PLACE**

Before: no session; **both** scoping keys (`agentUserId`, `brokerageId`) came from
the caller. Two uuids read any agent's social publishing history in any brokerage.
The `isValidUUID` guards looked protective but assert only *shape* — a well-formed
uuid belonging to someone else passed cleanly. Both keys now come from the
session. Note the id class: `agent_social_shares.agent_user_id` is a **users** id,
not `agents.id`, so `ctx.userId` is correct here — substituting the other would be
a valid query that silently matches nothing. `limit` clamped.

### `app/actions/social-share.ts:canAgentSharePost` — **HARDENED IN PLACE (a gate, treated as one)**

This decides whether a post that has not passed brand compliance or broker
approval may go out under the brokerage's name. It had no session and took
`brokerageId` from the caller, so the tenant a post was checked against was chosen
by whoever asked. Now session-scoped. It already **failed closed** on a refused or
empty read, which is correct and is preserved — this is the exact shape that went
the *wrong* way in the wave-1 `checkSuppression` finding, so it is called out in
the code rather than left implicit. A refused read is now reported differently
from "no such post" without changing the verdict.

> **`shareListingPost` in the same file is unauthenticated with caller-supplied
> `agentUserId` + `brokerageId` and I did NOT change it** — it writes the share
> row and fires the publish kernel event.

### `app/actions/social/generate-social-post.ts:stampPostBrandCompliance` — **HARDENED IN PLACE (a gate, treated as one)**

Not a read — `checkBrandCompliance` **writes** `brand_compliance_passed`, the very
flag `canAgentSharePost` and `shareListingPost` consult before publishing. With no
session and a caller-supplied `brokerageId`, anyone could evaluate another
tenant's post against a *different* brokerage's ruleset — which is how a post ends
up stamped compliant under rules that were never meant to apply to it. Now:
`brokerageId` ignored and derived from the session, the post must belong to that
brokerage, and a refused lookup fails **closed** (`passed: false`) because the
alternative in a compliance gate is stamping something nobody checked.

### `lib/ads/ad-monitor.ts:ingestCompetitorAd` / `:ingestCompetitorPost` — **HARDENED IN PLACE**

Not duplicates — they are the only writers for `competitor_ads` /
`competitor_posts`. Worth keeping and worth gating.

**This file lives under `lib/` but carries `"use server"` at the top**, so every
exported async function in it is a publicly reachable HTTP endpoint just like the
`app/actions` modules. That is easy to miss on a lib path and is now stated in the
file.

Before: no session, `brokerageId` from the caller. Anyone could write arbitrary
rows — `competitor_name`, `ad_headline`, `ad_copy` / `post_caption`, plus a
free-form `raw_payload` jsonb — into **any** tenant's competitor tables. The
`canAccessFeature(params.brokerageId, …)` line is again an *entitlement* check
(is this plan allowed the monitor), satisfied by naming a brokerage whose plan is;
it never established who was asking.

The reason this is worse than tenant pollution: `generateInsights` in this same
file reads those rows back and feeds `ad_copy` / `post_caption` **into an LLM
prompt**. An unauthenticated writer into a table that is later prompted from is a
**prompt-injection channel into another tenant's AI spend**, not merely bad data.

After: file-local **non-exported** `requireBrokerage()` (not exported — that would
mint another endpoint), `brokerageId` derived from the session everywhere in both
functions, entitlement check kept but run against the resolved brokerage.

> **The rest of this file is still unauthenticated with a caller-supplied
> `brokerageId` and I did NOT change it**: `generateInsights` (reads competitor
> rows and **bills an LLM call** — unauthenticated AI spend), `resolveAlert`
> (write), `getCompetitorAds`, `getCompetitorPosts`, `getAdInsights`,
> `getTrendAlerts`. `requireBrokerage` is in the file and drops straight in.

### `app/actions/ai-content-generation.tsx:saveDescriptionToListing` — **HARDENED IN PLACE (cross-tenant write)**

Not a duplicate — the file's own docblock says it is "the single write-path that
closes the loop between AI generation and the listing record", and no other writer
of `listings.public_remarks` from `ai_generated_content` exists. Keep it.

It *had* an auth check, and that was the trap: `auth.getUser()` established **that
someone was signed in and nothing more**. Both writes then keyed on a
caller-supplied id with no brokerage predicate. So any signed-in user of any
brokerage could:

- overwrite **any** listing's `public_remarks` — the MLS-facing marketing copy for
  a property they have nothing to do with; and
- flip **any** `ai_generated_content` row to `compliance_approved: true`. That is
  a compliance attestation, and it was settable by a stranger. This is the worse
  of the two.

After: `getAgentContext()`, both writes scoped with `.eq("brokerage_id",
ctx.brokerageId)` (verified live on both tables), **and `.select("id")` added to
the listing update** — a scoped UPDATE that matches nothing is a *successful
no-op* in postgrest, so without reading the affected row back the action would
have reported success while writing nothing. Zero rows affected is now
"Listing not found in your brokerage".

### `app/actions/ai-calendar-management.ts:createDeadlineEventsFromMilestones` — **HARDENED IN PLACE**

Same class. Real auth check, no tenant scope: `brokerageId` came from the caller
and was written straight into `calendar_events.brokerage_id`, while the milestone
read used `transaction_id` as its only predicate. Any signed-in user could read
another transaction's milestone titles, dates and descriptions and then mint
`is_system_generated: true` deadline events **inside a brokerage they do not
belong to** — events that appear on that tenant's calendar as if the OS produced
them.

After: `brokerageId` ignored and derived from the session; the milestone read is
scoped on `transaction_milestones.brokerage_id` (verified live).

> **The other calendar exports in this file are fully unauthenticated and I did
> NOT change them**: `getAppointments`, `createAppointment` (takes `brokerageId`
> and `agentId` from the caller, writes a calendar event, and can trigger the
> listing-appointment workflow chain), `updateAppointment`, `cancelAppointment`
> (both mutate any `calendar_events` row by id alone).

### `app/actions/user-profile.ts:getAgentEmailSignature` — **HARDENED IN PLACE (empty-uuid trap)**

Textbook instance of the trap, worth recording precisely because its *outcome* was
benign. `getAgentContext()` never throws — an unauthenticated caller gets the safe
default, whose `userId` is the **empty string**. That went into `.eq("id", userId)`,
and `WHERE id = ''::uuid` raises **22P02**. The result was destructured as
`const { data }` with no `error`, so the failure was swallowed and the action
returned `null` — indistinguishable from "this user has no signature".

Nothing bad happens here. But that is the same shape that becomes a silent no-op
on a write and a fail-open on a gate, so: refuse before the query, and read
`error`.

### `app/actions/podcast-generation.ts:getVideoScriptsLibrary` / `:getPodcastAnalytics` — **HARDENED IN PLACE (null-brokerage trap)**

Both called `getAgentContext()` and used `brokerageId` without checking it.
Unauthenticated ⇒ `brokerageId` is NULL, and `.eq("brokerage_id", null)` is not
the no-op it looks like: postgrest renders `brokerage_id=eq.null`, Postgres tries
to cast it to uuid and rejects with 22P02. The error was swallowed into the
`catch` and reported as a generic failure, so an unauthenticated call and a real
database fault looked the same.

`getPodcastAnalytics` was the worse of the two: its first read is a
`{ count: "exact", head: true }` COUNT destructured as `const { count }` with no
`error`. A refused or malformed count resolves to `count: null`, which `?? 0` then
renders as a confident **"0 plays"**. A number nobody could compute is not zero.
Both now refuse explicitly before querying.

### `app/actions/brand-template-registry.ts:batchClassifyTemplatesAction` / `:batchGetBrandRequirementsAction` — **HARDENED IN PLACE**

Honest scoping note: these are **pure computation with no database access**, so
there is no tenant scope to enforce and none is claimed. What they did expose was
an unauthenticated, **unbounded synchronous loop** over a caller-supplied array —
`batchClassifyTemplates` / `batchGetBrandRequirements` run in-process without
yielding, so one request with a large enough array occupies a server worker for as
long as it takes. Now: session-gated via a non-exported `requireSession()`, and
capped at 500 entries. The single-item siblings in this file are naturally bounded
and were left alone.

### `app/actions/ai-listing-presentation.ts:generateBrochureContent` — **HARDENED IN PLACE (partial scope closed)**

It already had `requireCaller()` and the listing read was already pinned to the
caller's brokerage — good. The `agents` read next to it was not: a caller-supplied
`agentId` did `select("*")` from **any** brokerage's agents row, and the phone and
email off it were written into the brochure *and* into the model prompt. Now
scoped with `.eq("brokerage_id", auth.brokerageId)`, `.single()` → `.maybeSingle()`
(a missing agent is an answer, not a throw), and the projection narrowed to the
four fields actually used — `select("*")` on a wide table is how columns nobody
intended to expose end up inside an LLM context window.

---

## Verified already-gated — **LEFT AS-IS**, with the gate named

These were read in full and are correctly authenticated and tenant-scoped (several
by the earlier remediation wave). They remain orphaned, which is the correct
outcome for this pass: they need a consumer surface, and consumer surfaces are
outside every agent's slice this wave. No change was made purely to move a number.

| Export | Gate verified |
|---|---|
| `academy.ts:addTemplateFeedback` | `auth.getUser()`; writes only the caller's own `user_id` |
| `admin/create-subscriber.ts:retrySubscriberInvite` | superadmin-only; fails closed when the profile read returns nothing |
| `ai-client-gifting.ts:aiPlanBulkGifting` / `:getGiftAnalytics` | `getAgentContext()`, `agentId` derived (prior wave) |
| `ai-referral-management.ts:analyzeReferralProgram` | session-derived agent; **refuses** a mismatched `requestedAgentId` rather than silently substituting |
| `assistant.ts:handleAssistantQuery` / `:handleTaskDelegated` / `:handleAutomationTriggered` | `authorizeForUser()` — caller must be the subject or an admin; `handleTaskDelegated` additionally verifies task ownership and resolves `users.id` → `agents.id` |
| `buyer-broker-agreements.ts:createBBADraftAction` | `requireAgentInBrokerage()` + buyer-contact tenant check |
| `contacts.ts:archiveContact` | `getAgentContext()`, brokerage required |
| `content-generation-engine.ts:generateAudio` / `:generateFromURL` / `:getGenerationHistory` / `:getGenerationStats` | `resolveAuthorizedAgentId()`; `agent_id` vs `agent_user_id` kept in their distinct id spaces |
| `content-studio.ts:saveContentIdea` | `requireCaller()`; `brokerage_id` + `created_by` session-derived |
| `data-health.ts:purgeInvalidContacts` | prior wave: authenticated, broker/admin only, brokerage-scoped on all three statements, read-only impersonation refused, refused read fails closed |
| `financials.ts:deleteExpense` | authenticated; resolves `agents.id` before scoping the delete; empty delete reported as a failure |
| `inbox.ts:getInboxMessages` | `resolveActorContext()` throws on unauthenticated |
| `inbox.ts:markInboxRead` | authenticated + contact/brokerage cross-check before both updates |
| `lead-management.ts:getLead` | `requireLeadDesk()` + `getAgentContext()` brokerage |
| `learning-modules.ts:updateLearningModuleAction` | `requireAdmin()`; update scoped on `brokerage_id` |
| `link-to-video.ts:getVideoDetails` / `:generateSocialCaption` | `requireCaller()` + `verifyVideoAccess(id, brokerageId)` before the service client is touched |
| `marketing-cadence-policy.ts:getMyMarketingCadencePolicies` | `getAgentContext()`; `agents.id` resolved from `user_id` + `brokerage_id` |
| `newsletter/approve-template.ts:approveTemplate` / `:rejectTemplate` | authenticated + `canApproveTemplates()` + tenant-scoped write |
| `onboarding/training.ts:recordVideoProgress` | `getAgentContext()`; `agentId` required, all reads/writes agent-scoped |
| `photo-management.ts:getPhotoOrderingRules` | `callerContext()`; `agents.id` resolved (never substituted from `users.id`) |
| `property-buyer-matching.ts:getListingMatchHistory` / `:scoreSingleBuyerForListing` | `getAgentContext()`; every service-client read carries `brokerage_id` (prior wave) |
| `seller-coaching.ts:dismissCoachingCard` | authenticated; listing tenant verified before the activity write; actor session-derived |
| `superadmin/parked-retention.ts:getParkedRetentionAction` | `requireSuperadmin()` |
| `transaction-document-signatures.ts:getTransactionSignatureStatuses` / `:getUnsignedDocumentBlockers` | authenticated; `brokerageId` ignored and session-derived (prior wave) |
| `transaction-stage-machine.ts:getTransactionStageInfo` | `requireCallerForBrokerage()`; `TransactionOrchestrator.getCurrentStage()` scopes on `brokerage_id` too |
| `vendor-invite.ts:inviteVendorToPlatformAction` / `:revokeVendorInviteAction` | authenticated + role allow-list + vendor/invitation tenant check |
| `vendor-w9.ts:getMyVendorW9Action` | `requireVendorActor()` — requires a `user_role_assignments` row binding caller→vendor; the claimed `vendorId` is verified, not trusted |
| `voice-tenancy.ts:setTwilioByoCredsAction` | `requireBrokerageAdmin()` + plan-tier check + SID/token format validation |

---

## Where I stopped, and what I deliberately left

**Covered: all 43 assigned files / 67 assigned exports.** Each was read in full;
27 were changed, 40 were verified already-gated and left with the gate named.

**Verdict tally**

- **Hardened in place — 26.** Still orphaned, and that is the correct outcome:
  hardening an endpoint without wiring it keeps it in the census. Nothing was
  deleted to move the number.
- **Finished — 1** (`markLifeChangeNotified`, which had been a no-op that reported
  success).
- **Left, verified gated — 40.**
- **Merged-then-deleted — 0.** Worth stating plainly: I looked for duplicates
  first on every export, as the method requires, and **found none in this slice**.
  Two came close and neither is a duplicate:
  `ai-direct-mail.ts:getDirectMailAnalytics` vs `:getDirectMailCampaigns` (rows vs
  a derived roll-up — the sibling supplied the *fix pattern*, not a survivor), and
  `lib/portal/require-contact-access.ts:requireContactAccess` vs
  `lib/auth/contact-access.ts:assertCanActOnContact` (both real gates with
  different audiences — staff-only vs staff-plus-the-contact-themselves; picking
  the wrong one would have locked buyers out of their own portal, so the choice is
  recorded in a comment at the import site).

**Deliberately left, with reasons**

1. **All "wire it" work.** Consumer surfaces (pages, components, route handlers)
   are in nobody's slice this wave. Every export here needs a caller, not a code
   change, to leave the census. I did not touch a consumer file.
2. **Section C above** — unauthenticated *wired* exports in my files, on exports
   outside my assignment. Changing their gates mid-wave risks breaking callers
   another agent may be editing. Each file now carries the right gate helper, so
   the follow-up is mechanical. **Section C item 5 (anyone can accept or reject
   any offer) and item 3 (unauthenticated outbound neighbour mail) are the two I
   would fix first.**
3. **`trackCampaignResponse` gating vs. a public tracker.** I gated it. If a
   genuinely anonymous response sink is wanted, it belongs in a route handler with
   rate limiting and a high-entropy token — not on a server action keyed by a
   string printed on a postcard. Reasoning is in the code.
4. **`markOfferExpired` does not sync `offers.status`.** Neither do its three
   siblings; this file's stated design derives state from `activities`. Changing
   that is a domain decision, not a burndown one. Noted, not done.

**Typecheck:** as instructed, I did **not** run `tsc`, `npm run type-check` or
`npm run guard`. I did run `esbuild.transformSync` over every edited file — a
parse only, no type resolution, negligible memory — and all 17 parse clean. Type
correctness is for the orchestrator's central run. Two spots were written
defensively against `strict: true` because I could not verify them: the row casts
in `requireOfferActor` and the jsonb narrowing in `markLifeChangeNotified`.
