# Wave 4 — Slice 1: orphaned `"use server"` endpoints (38 files / 57 exports)

Branch: `claude/settings-consolidation-ui-0cd7lo`. Every file below carries `"use server"`, so
every export is a publicly reachable HTTP endpoint. This document is the durable record —
findings are checkpointed here incrementally.

## Method
(a) duplicate? read both, merge onto survivor, then delete naming `file.ts:fn`.
(b) not a duplicate? wire it to its surface, or finish it as an advanced feature, or record
    exactly what finishing needs. "No caller" is never a deletion rationale.

## Exact orphan inventory (from `scripts/orphan-export-guard.ts --list`)

| file | orphaned exports |
|---|---|
| app/actions/vendor-payments.ts | completeStripeConnectOnboarding, markInvoicePaid |
| app/actions/vendor-portal.ts | uploadVendorJobDocument |
| app/actions/seller-coaching.ts | dismissCoachingCard |
| app/actions/portal-messages.ts | getPortalMessages |
| app/actions/lead-readiness/evaluate-readiness.ts | batchEvaluateLeadReadiness |
| app/actions/contacts.ts | archiveContact |
| app/actions/buyer-offer/track-offer-lifecycle.ts | markOfferExpired |
| app/actions/buyer-broker-agreements.ts | createBBADraftAction |
| app/actions/neighbor-notifications.ts | listNeighborCampaignsForListing |
| app/actions/ai-direct-mail.ts | aiAnalyzeCampaignPerformance, getDirectMailAnalytics, trackCampaignResponse |
| app/actions/video-content.ts | createShortClip |
| app/actions/superadmin/parked-retention.ts | getParkedRetentionAction |
| app/actions/stock-video-upload.ts | deleteStockClip |
| app/actions/content-prediction.ts | getPredictionAction |
| app/actions/ai-voice-transcription.ts | transcribeAudio |
| app/actions/ai-referral-management.ts | analyzeReferralProgram |
| app/actions/ai-newsletter.ts | aiPersonalizeNewsletter, manageSubscriberBatch, manageSubscribers |
| app/actions/ai-listing-intake.ts | aiOptimizePhotoOrder, runCompleteListingIntake |
| app/actions/ai-closing-workflow.ts | aiTrackClosingMilestones |
| app/actions/admin/locations.ts | updateLocationAction |
| lib/listings/tier-assigner.ts | getRequiredDistributions, getTierBudgets, getTierForListing, getTiersForBrokerage |
| lib/ads/ad-monitor.ts | ingestCompetitorAd, ingestCompetitorPost |
| app/actions/vendor-budget.ts | getPlatformVendorBudget |
| app/actions/transaction-transparency.ts | markDelaysCommunicated |
| app/actions/transaction-document-signatures.ts | getTransactionSignatureStatuses, getUnsignedDocumentBlockers |
| app/actions/social-publishing.ts | getSocialAnalytics, handlePostPublished, handleScheduledPost |
| app/actions/photo-management.ts | getPhotoOrderingRules |
| app/actions/open-house.ts | getAgentListings |
| app/actions/onboarding/agent-onboarding-actions.ts | fetchMyOnboardingDashboard |
| app/actions/marketing-studio.ts | generateCampaignContent, updateCampaign |
| app/actions/listing-lifecycle.ts | getListingTasks, sendReviewRequest |
| app/actions/learning-modules.ts | updateLearningModuleAction |
| app/actions/error-handler.ts | assignErrorGroup |
| app/actions/credit-copilot.ts | referToCreditPartner, updateContactCreditStatus |
| app/actions/compliance/manage-required-docs.ts | listTemplateFormOptions |
| app/actions/ce-provider.ts | connectCeProvider |
| app/actions/blog.ts | getBlogPostById, getBlogPosts, getSeoKeywords |
| app/actions/analytics.ts | aggregateValueDelivered, trackLeadValueJourney |

## Findings log

(appended as work proceeds)

---

### 1. `app/actions/vendor-payments.ts` — `completeStripeConnectOnboarding`, `markInvoicePaid` — WIRED BOTH

**`completeStripeConnectOnboarding`** — not a duplicate. A prior slice established the
survivor for the "flip the flag ON" half (`app/api/billing/webhook/route.ts`
`account.updated` → `lib/connections/vendor-stripe.ts:setStripeOnboardingByAccount`)
and already fixed that branch's promote-only hole. Two handoffs were left open; both
are now closed:

- `initiateStripeConnectOnboarding` set `return_url`/`refresh_url` to
  `/vendor/settings?stripe=…`. **`app/vendor/settings/page.tsx` is a 4-line
  `redirect('/settings/general')`** — it drops the query string entirely. A vendor
  finishing Stripe's hosted onboarding landed on an unrelated page and nothing
  reconciled the account. Both URLs now point at `/vendor/earnings`, where the
  Connect UI actually lives.
- `app/vendor/earnings/page.tsx` now reads `?stripe=complete` and calls
  `completeStripeConnectOnboarding(vendorId)` before rendering the Connect banner,
  with a visible success/failure notice, plus an honest message on `?stripe=refresh`
  (expired link). This is the only implementation that can DEMOTE a restricted
  Connect account, and webhooks are eventually consistent (Connect events must be
  separately enabled on the endpoint), so the synchronous reconcile is load-bearing
  on a money path — `initiateVendorPayout` hard-gates on that exact flag before
  `stripe.transfers.create()`.

**ID-SPACE DEFECT FOUND AND FIXED (live-verified, lesson 8) —
`app/vendor/earnings/page.tsx`.** The page resolved the vendor from
`vendor_marketplace_profiles.user_id` and passed that row's `id` as `vendorId` into
`readVendorStripeConnect`, `getVendorEarningsSummary`, `VendorStripeConnect` and
`VendorPayoutButton`. Verified against the live DB (`hrvaqgvukzxfskkcrwbt`):
`vendors` and `vendor_marketplace_profiles` are **separate tables with disjoint id
spaces** — `vendor_earnings.vendor_id`, `vendor_invoices.vendor_id`,
`vendor_payouts.vendor_id` and `user_role_assignments.vendor_id` ALL FK to
`vendors.id`; only `vendor_plans`/`vendor_subscriptions`/`vendor_transactions`/
`vendor_access_logs` FK to the marketplace profile. `vendors` has no `user_id`
column at all. Consequence: the entire vendor earnings surface was inert — earnings,
invoices and payouts always read empty, the Connect banner never resolved the real
credential, and both `requireVendorActor` gates (onboarding + payout) failed for a
legitimate vendor. Now resolved via `user_role_assignments.vendor_id`, matching
every other `/vendor/*` page (dashboard, invoices, documents, connections,
portfolio, reviews) and the Connection Center. The refused-read case is handled
explicitly (lesson 4) so a denial no longer renders as "Vendor profile not found".
Also corrected the wrong header comment in `lib/connections/vendor-stripe.ts` that
said `owner_id=<vendor_marketplace_profiles.id>` — it is `vendors.id`; that comment
is what the page was acting on.

**`markInvoicePaid`** — not a duplicate, and the missing consumer of a live lane.
`app/actions/multi-persona.ts:submitVendorInvoice` (wired to
`app/dashboard/components/vendor-bookings-panel.tsx`) creates
`billed_to='brokerage'` invoices — a vendor billing the brokerage for booked work.
Nothing could mark one paid, and marking paid is the ONLY thing that mints the
`vendor_earnings` row the vendor earnings page shows and `initiateVendorPayout`
draws on. So the marketplace's core money loop had a producer and no consumer:
vendors could be booked, could invoice, and could never be paid through the product.
It is NOT `markVendorChargePaid` (that refuses `billed_to !== 'vendor'` — opposite
direction, mints no earnings) and NOT `markClientInvoiceCollected`
(`billed_to='contact'`, vendor-collected).

Wired to a new **`app/dashboard/vendors/vendor-bills-panel.tsx`** ("Vendor Bills"
card on the brokerage vendor directory, Preferred tab, mirroring the existing
Vendor Charges panel), fed by a `billed_to='brokerage'` read added to
`app/dashboard/vendors/page.tsx` (error destructured — a denied read must not render
as "no bills awaiting payment").

Hardening applied to `markInvoicePaid` while wiring it:
- **ROLE GATE added.** It was gated on tenancy alone, so any authenticated member of
  the brokerage could mint an 'available' payout claim. Now
  `VENDOR_CHARGE_ADMIN_ROLES` (broker/broker_owner/broker_admin/admin/superadmin/
  team_lead) — the sibling money lane's set minus `agent`: an agent may settle a
  charge they raised (money IN), but authorizing a payment OUT of brokerage funds is
  leadership's. Safe to add: the function had zero callers, and `grep` over
  `app/api/cron/`, `app/api/webhooks/` and workers found no unattended caller.
- **LANE GUARD added.** It accepted `billed_to='contact'` invoices, which would mint
  an 'available' earning for money the vendor collects DIRECTLY from the client and
  the brokerage never held — a payout claim against brokerage funds for a debt that
  does not exist. Now refused with a message pointing at the vendor invoice center.
- `status === 'cancelled'` now refused (it would previously resurrect a cancelled
  invoice to paid and mint earnings).

**SECURITY FINDING — `app/actions/multi-persona.ts:submitVendorInvoice` was a
completely UNGATED `"use server"` endpoint.** No `requireCaller()`, straight to
`createServiceClient()` on a caller-supplied `bookingId` and `amount`. Any caller
could mint a `billed_to='brokerage'` vendor invoice of arbitrary amount against ANY
tenant's booking, and it also overwrote that booking's `cost`. This is the front
door of the money path above. Fixed: caller must be authenticated AND either in the
booking's brokerage or BE the vendor being invoiced for
(`user_role_assignments.vendor_id`); amount must be finite and > 0; the booking read
now destructures `error` and fails closed (the old shape inserted an invoice with
NULL `vendor_id`/`brokerage_id` — an unscoped money row — when the booking read
returned nothing). Only call site is the dashboard panel; no cron/webhook/worker
caller exists.

**Call sites changed:** `app/vendor/earnings/page.tsx` (identity resolution + new
import + Stripe return handling + two `vendorId` props),
`app/dashboard/vendors/page.tsx` (new read + new panel),
`app/actions/vendor-payments.ts` (return URLs), `app/actions/multi-persona.ts`
(gate). New file: `app/dashboard/vendors/vendor-bills-panel.tsx`.

---

### 3. `app/actions/stock-video-upload.ts` — `deleteStockClip` — WIRED

Not a duplicate. `app/actions/stock-library.ts:deleteStockAsset` also deletes from
`video_assets`, but the two lanes use DIFFERENT scope models that **both exist on the
live table** (verified): this one scopes by `created_by`/`agent_id`/`team_id`/
`brokerage_id` (what `uploadStockClip` + the BrollPicker write), `deleteStockAsset`
scopes by `scope_type`/`scope_id` (what `registerStockAsset` + the stock-library
settings page write). A row from one lane has NULLs in the other's scope columns, so
`deleteStockAsset` evaluates every `canEditScope` branch false on a BrollPicker clip
and always answers `scope_forbidden`. Neither can delete the other's rows — deleting
either function would strand its lane's assets permanently. Recorded on both.

Note (lesson 6): a first grep suggested `uploadStockClip` was unwired too. A second,
differently-shaped search found `app/dashboard/videos/components/BrollPicker.tsx`
importing it — my first grep's `head` cut it off. The picker could upload clips and
never remove one, so a mistyped title, a wrong-scope upload or an unusable take was
permanent and kept being offered as a one-click choice in the video wizard.

Wired into `BrollPicker.tsx`: the library query now selects `created_by`, the picker
resolves the signed-in user, and each card its owner uploaded gets a remove control.
`removeClip` clears the clip from the current wizard selection FIRST — otherwise the
render would be submitted pointing at a URL whose row no longer exists — then
reloads the library. The UI only offers the affordance on the caller's own uploads
even though the server also permits a same-brokerage broker/admin: it will not show
a control it cannot prove the caller is entitled to.

Hardening: `assetId` required; the pre-check read destructures `error` so a refused
read is reported as a verification failure rather than mislabeled "Clip not found".
Corrected the doc comment that called this a **"soft delete"** — `video_assets` has
no `deleted_at` column (verified live) and the statement is `.delete()`. Calling it
soft invited callers to assume the row was recoverable.

---

### 4. `app/actions/contacts.ts` — `archiveContact` — WIRED + duplicate resolved + false-success bug fixed

The CRM had **no contact-removal control at all** — `archiveContact` had no caller,
and neither did the kernel command behind it.

**DUPLICATE — survivor `app/actions/contacts.ts:archiveContact`.** The loser is
`app/actions/crm.ts:deleteContact` → `lib/services/contact-management.service.ts:
deleteContact`, which also soft-deletes by stamping `deleted_at`. The losing lane is
broken for the admin case and weaker throughout:
- it takes a **caller-supplied `agentId`** and the service re-verifies ownership with
  `.eq("agent_id", agentId)`, so a broker/admin archiving another agent's contact
  passes the action's own gate and is then rejected by the service — the admin path
  can never succeed. The survivor resolves the agent id SERVER-side from
  `getAgentContext()` and applies the agent predicate only for `userType === "agent"`.
- it scopes by agent, not brokerage; the survivor puts `brokerage_id` on the UPDATE
  predicate.
- no `.is("deleted_at", null)` guard, so re-archiving rewrites the original timestamp.
- no lifecycle event; the survivor writes `CONTACT_ARCHIVED`.

MERGED, not just chosen: the loser's one real capability — cache revalidation of the
CRM surfaces — is ported onto the survivor. Its `status: 'deleted'` write is
deliberately NOT ported: `contacts.status` has no CHECK constraint (verified live) and
every reader already filters `deleted_at IS NULL`, so a second unconstrained deletion
flag is a divergence waiting to happen, not a capability. The loser is left in place
(barrel-exported, outside my orphan set) with the verdict recorded on the survivor.

**BUG FIXED — `lib/kernel/crm.ts:archiveContactRecord` reported success without doing
the thing.** Its `.eq(brokerage_id)` / `.eq(agent_id)` / `.is(deleted_at, null)`
predicates ARE the authorization, and a zero-row UPDATE is not a Postgres error. So a
wrong tenant, a non-owning agent, or an already-archived row all returned
`{ success: true }` **and wrote a CONTACT_ARCHIVED lifecycle event** — an audit trail
asserting an archive that never happened, and a UI free to tell the user their
contact was removed while the record stayed live and reachable. Now `.select("id")`
makes the affected rows observable and a zero-row result fails. The failure message
deliberately does not distinguish "does not exist" from "not yours" — that difference
is an id-enumeration oracle across tenants.

Wired into `app/crm/page.tsx` (contact detail Quick Actions → "Archive Contact") with
a confirm, honest server-error reporting, selection cleared and the list reloaded.
`archiveContact` also now checks `isAuthenticated` and requires a `contactId`.

---

### 5. `app/actions/social-publishing.ts` — `handleScheduledPost`, `handlePostPublished`, `getSocialAnalytics` — ALL THREE DELETED after merge

**`handleScheduledPost` + `handlePostPublished` — survivor
`app/api/cron/publish-social-posts/route.ts` (the publish loop).**
Neither published anything. Both were `"use server"` endpoints — reachable over HTTP
by any signed-in session — that mutated the publish state machine out of band, and
nothing dispatched them. Confirmed three ways (lesson 6): no importer, no emitter of
the event names, and the `EVENT_HANDLERS` map in `lib/orchestrator/internal.ts` that
would register them is **itself declared and never read**.

They were hazardous, not merely redundant:
- `handleScheduledPost` flipped a due post to `status='publishing'`. The cron selects
  on `status='scheduled'`, so a post moved to `'publishing'` by anything else **never
  matches again** — stranded mid-flight, silently never published. A publicly
  reachable endpoint that can permanently strand another brokerage-member's post.
- `handlePostPublished` stamped `status='published'`, `published_at` and a
  **caller-supplied `external_post_id`**. Any signed-in user could mark any of their
  brokerage's posts published with a fabricated platform id without a byte reaching a
  platform — a control reporting success without doing the thing — and it skipped
  `social_publish_log`, the engagement-tracking seed and the `SOCIAL_POST_PUBLISHED`
  kernel event, all of which the cron writes.

MERGE REVIEW: their only extra capability was an auto-created follow-up task
("verify published" +30m, "check engagement" +24h). **Deliberately not ported.** The
verify task fired at the moment of the flip to `publishing` — before anything had
published — and the cron already records real failure (`status='failed'`,
`social_publish_log`, `SOCIAL_POST_FAILED`), so it is busywork by construction. The
engagement task is the right intent implemented badly (one task per published post is
spam); the class is already served better at the survivor, which seeds
`social_engagement_tracking` and is followed by the nightly
`/api/cron/social-analytics-sync` writing measured platform numbers.

**`getSocialAnalytics` — survivor
`app/actions/social-media-automation.ts:getSocialMediaAnalytics`** (the canonical
social lane, wired to `app/dashboard/social/social-dashboard-client.tsx`). The
removed reader embedded `social_post_analytics`, whose only writer was removed from
the publish cron in favour of `social_engagement_tracking` (the cron's own comment
says so). Its analytics block was therefore **structurally empty for every post,
forever** — rows that looked like analytics and carried no measurement. Both tables
still exist live; only `social_engagement_tracking` is written.

MERGED before deletion: the loser's one real capability — per-user scoping (an
ordinary agent sees only their own posts) — is now on the survivor
(`seesAllBrokeragePosts`), which was brokerage-wide, so **an individual agent could
read the whole brokerage's social performance**. The ported role list also adds
`broker_admin`, which the loser's list omitted. Verified safe: `social_posts.user_id`
is reliably populated (3/3 live rows; both the manual creator and the listing-promo
cron resolve and set it), so the filter narrows rather than blanking the view.
`requireBrokerage()` now also returns `userType` (additive; existing callers
unaffected).

**Call sites changed:** none needed — all three had zero callers.
**Adjacent, not fixed:** `app/components/portal/PortalSocialHub.tsx` also reads
`post.social_post_analytics`, so the client portal's social metrics are structurally
empty too. Same root cause, different file.

---

### 6. `app/actions/ai-direct-mail.ts` — `trackCampaignResponse`, `getDirectMailAnalytics`, `aiAnalyzeCampaignPerformance` — ALL THREE WIRED

All three were already correctly gated by an earlier pass (session-derived agent +
brokerage; the previous holes — a caller-supplied `agent_id` handing back another
agent's paid-mail book, and an entitlement check standing in for authentication in
front of a billed model call — are documented in the file). This slice's job was the
wiring, and it exposed a bigger break.

**THE DIRECT-MAIL ATTRIBUTION LOOP HAD NO WRITER.** `direct_mail_responses` is what
the mail dashboard's Responses tab reads and what response-rate and
cost-per-response are computed from. Its only writer in the tree is
`app/actions/direct-mail.ts:logResponse`, whose only caller is
`ai-direct-mail.ts:trackCampaignResponse`, which had no caller of its own. So the
table had **no writer at all**: the Responses tab was structurally empty forever and
every response figure was zero by construction. `/api/qr/scan` already resolved the
owning direct-mail campaign for a scanned QR and wrote only `qr_scan_events`.

**Fix — the anonymous door (lesson 1).** `app/api/qr/scan/route.ts` now writes the
`direct_mail_responses` + `mail_response_tracking` pair itself, with the service
client it already holds, `brokerage_id` from the `qr_codes` row and `campaign_id`
from the campaign that owns the QR — nothing taken from the scanner. It is
deliberately NOT routed through `trackCampaignResponse`: the person scanning a mailer
is a prospect with no session, so the session-gated action would either turn the real
event source away or require inventing an identity for it. Best-effort try/catch — an
attribution write must never break the redirect the prospect is waiting on.
(`response_type: 'qr_scan'` verified against the live
`direct_mail_responses_response_type_check`.)

**`trackCampaignResponse` wired** to the Responses tab as the OPERATOR-side logger
("Log a response"): responses arriving by phone, or from someone typing the landing
URL off the postcard, have no automatic signal — the agent is the only witness, and
they were undercounted entirely. Keyed on the tracking code printed on the piece,
which matches the action's signature; the action resolves the campaign from that code
and refuses one outside the caller's brokerage, so the printed low-entropy code is an
addressing key and never an authorization.

**`getDirectMailAnalytics` + `aiAnalyzeCampaignPerformance` wired** to a new
**Analytics tab** (`app/dashboard/campaigns/mail/components/analytics-tab.tsx`). The
mail dashboard shipped Campaigns / Recipients / Tracking / Responses — four tabs
reporting activity and none reporting outcome. The tab shows blended spend, pieces,
responses, response rate and cost-per-response plus a per-campaign table, and puts
the AI read behind an explicit button rather than running on tab change: it bills a
model call per invocation and that spend should follow an intent. Load errors are
surfaced, never rendered as "$0 across 0 campaigns" — the actions report a refused
read as a failure and a confident zero about someone's marketing spend is a lie.

**Call sites changed:** `app/api/qr/scan/route.ts`,
`app/dashboard/campaigns/mail/mail-dashboard.tsx` (new tab + `onResponseLogged`),
`app/dashboard/campaigns/mail/components/responses-tab.tsx`. New file:
`app/dashboard/campaigns/mail/components/analytics-tab.tsx`.

---

### 7. `lib/listings/tier-assigner.ts` — `getTierForListing`, `getTierBudgets`, `getTiersForBrokerage` WIRED; `getRequiredDistributions` deliberately left

All four are the READ side of the listing marketing-tier system. The WRITE side
(createTier / updateTier / createTierBudget / createTierDistribution / the two
deletes) is wired to `app/dashboard/listings/[id]/marketing-tier/marketing-tier-client.tsx`,
and all four readers were already hardened by an earlier pass (session-only
`resolveTierReader`, fail-closed, `getTiersForBrokerage` refuses a caller-named
tenant).

**DUPLICATE — the surface had re-implemented all of them inline, and worse.**
`app/dashboard/listings/[id]/marketing-tier/page.tsx` loaded the current tier, its
budgets, its distributions and the brokerage's tier list with raw selects. Every one
of those was weaker than the reader it duplicated:
- the tier lookup, the `tier_budgets` read and the `tier_distributions` read all
  filtered ONLY on id / `tier_id`, with **no `brokerage_id` predicate** — they leaned
  entirely on RLS, while the readers state the tenant in the query;
- the tier lookup used `.single()`, which raises PGRST116 when a listing still points
  at a deleted tier and takes the **whole page down with a 500** instead of degrading
  to "no tier assigned".

That same page already establishes the convention in its own comment for the
marketing-package read: *"Goes through the action rather than a raw select so the same
tenant guard … applies to the read too."* The tier reads simply had not followed it.

WIRED: `getTierForListing`, `getTierBudgets` and `getTiersForBrokerage` now serve the
page. `getTierForListing`'s embedded tier projection (id, tier_name, min_price,
max_price, description, is_active) matches the client's `currentTier` prop type
exactly — a drop-in. The listing row itself still comes from the page's own select
because it needs address/city/state/zip/brokerage_id, which the reader does not
return.

**DELIBERATELY LEFT — `getRequiredDistributions`.** It returns only
`is_required = true` rows, but this surface renders the FULL distribution set and
badges each row required/optional (`marketing-tier-client.tsx` line ~147 filters
client-side over data it already holds). Swapping it in would silently hide the
optional distributions — a narrower reader is not a safe substitute for a wider one.
Rather than degrade the surface, the tenant predicate it carries was applied to the
page's own distributions read instead. It remains correct and gated for any future
caller that genuinely needs only the required set without loading all of them (a
tier-completion check is the obvious one); finishing it means building that check,
not re-pointing this page at it.

**Call site changed:** `app/dashboard/listings/[id]/marketing-tier/page.tsx`.

---

### 8. `lib/ads/ad-monitor.ts` — `ingestCompetitorAd`, `ingestCompetitorPost` — WIRED + live CHECK mismatch fixed

Both were already gated by an earlier pass (session-resolved tenant + the
`competitor_monitor` entitlement). Two findings on top:

**`competitor_posts` had NO WRITER ANYWHERE IN THE TREE.** For ads it did not matter
much — `/api/cron/competitor-ads-exa` upserts `competitor_ads` automatically with the
service client, which is the correct unattended door (lesson 1) and is why the
session-gated action is not its replacement. For POSTS there is no such cron, so the
Competitive Monitor's Posts tab was structurally empty forever, and its empty state
("posts will appear here once they are ingested from your monitoring sources")
described sources that do not exist. The agent who actually sees a rival's listing
post had nowhere to put it.

WIRED via a new `app/dashboard/campaigns/competitive/track-competitor-dialog.tsx`
("Track a competitor" on the monitor header), covering both ingest doors. The ad path
notes that the action upserts on (brokerage, platform, headline), so re-adding a seen
ad refreshes `last_seen_at` rather than duplicating it.

**LIVE CHECK-CONSTRAINT MISMATCH (lesson 3) — the two tables do NOT accept the same
platform vocabulary, and neither TypeScript union matched its table.** Verified via
`pg_constraint`:
- `competitor_ads_source_platform_check` → `facebook | instagram | google`. The
  `IngestCompetitorAdParams` union offered `linkedin` and `tiktok`, which the CHECK
  **rejects with 23514** — two branches of the type were structurally unreachable, and
  any caller trusting the type got an opaque database error.
- `competitor_posts_source_platform_check` → `facebook | instagram | linkedin | x |
  youtube | tiktok`. The `IngestCompetitorPostParams` union offered **`twitter`**,
  which the CHECK rejects (the live value is `x`), and omitted `x` and `youtube`
  entirely.

Both unions are now pinned to the live constraints and exported as
`CompetitorAdPlatform` / `CompetitorPostPlatform` with matching
`COMPETITOR_AD_PLATFORMS` / `COMPETITOR_POST_PLATFORMS` arrays, so the new dialog's
options cannot drift from the database. `brokerageId` on both param interfaces is now
optional and documented as ignored, matching what the gated implementations actually
do. Verified no other caller exists in the tree, so narrowing the unions breaks
nothing.

**Call sites changed:** `app/dashboard/campaigns/competitive/competitive-monitor-client.tsx`.
New file: `app/dashboard/campaigns/competitive/track-competitor-dialog.tsx`.

---

### 9. `app/actions/error-handler.ts` — `assignErrorGroup` — WIRED + three defects fixed

The error-triage surface (`/dashboard/admin/error-handler`) shipped Resolve and
Dismiss and **no way to hand an error to the person who can fix it**, which is why
this had no caller.

Three defects fixed in the action:
1. **No authentication check.** The gate was the tenant predicate alone; an
   unauthenticated call reached `.eq("brokerage_id", undefined)` — a malformed
   predicate, not a refusal, which is the wrong shape for an authorization boundary
   on a `"use server"` endpoint.
2. **The assignee was taken entirely on trust.** `automation_errors.assigned_to` FKs
   to `users(id)` (verified live) with no tenant constraint of its own, so ANY
   users.id was accepted — including a user of a different brokerage, who would then
   own an error record they cannot see and that nobody in the owning brokerage is
   chasing. Now verified against the caller's brokerage first, with `error`
   destructured so the check fails closed.
3. **Reported success without doing the thing.** A wrong id, or an error belonging to
   another tenant, updated zero rows — not an error in Postgres — and it still
   returned `{ success: true }`, so the UI would show the error as assigned to
   someone who was never given it. Now `.select("id")` makes the affected rows
   observable and a zero-row update throws.

**New reader added — `listAssignableTeammates`.** There was no way to obtain a
candidate list: nothing in the tree returned brokerage USERS.
`app/actions/admin/locations.ts:listBrokerageAgentsAction` is not a substitute — it
returns `agents.id` while `assigned_to` FKs to `users(id)`, and those are disjoint id
spaces (lesson 8); feeding one where the other belongs is a 23503, not a
mis-assignment. The reader is session-gated, brokerage-scoped, returns an empty
roster on a refused read rather than a fabricated one, and filters to STAFF
user_types — a contact / vendor / lender portal user shares the `brokerage_id` but is
not someone an internal automation error can be handed to. (Live `user_type` values
were checked before writing the filter.)

Wired into `app/components/admin/errors/ErrorDetailsPanel.tsx` as an "Owner" block.
`assignErrorGroup` THROWS on refusal, so the panel surfaces the real message rather
than a generic failure.

**Call sites changed:** `app/components/admin/errors/ErrorDetailsPanel.tsx`.

---

### 10. `app/actions/admin/locations.ts` — `updateLocationAction` — WIRED

The office admin surface (`/dashboard/admin/locations`) shipped Add, Delete and
Reassign and **no way to correct an office**. Renaming an office or fixing a typo'd
address meant deleting it — which unassigns every agent in it — and rebuilding.
`updateLocationAction` already existed, admin-gated and brokerage-scoped, with no
caller.

Wired into `app/dashboard/admin/locations/locations-client.tsx` as a per-office edit
dialog. The optimistic update is rolled back on refusal (the action rejects an empty
name and any row outside the caller's brokerage), so the list never keeps showing a
change the database declined. The dialog re-seeds from the row on each open, so a
cancelled edit does not linger.

**Call sites changed:** `app/dashboard/admin/locations/locations-client.tsx`.

---

### 11. `app/actions/transaction-document-signatures.ts` — `getTransactionSignatureStatuses` FIXED; `getUnsignedDocumentBlockers` left

**BUG — `getTransactionSignatureStatuses` IGNORED ITS `transactionId` ARGUMENT
ENTIRELY.** It returned EVERY `contract_signatures` row in the brokerage — every
other deal's signatures — from a function named "for transaction". Any surface that
trusted the name would show one deal's page the signature state of all the others: a
correctness bug and an internal-confidentiality one. (The old comment acknowledged
the design and pushed the filtering onto "the caller", but there was no caller, so
nothing filtered.)

Verified live: `contract_signatures` carries `brokerage_id`, `agent_id`,
`contract_type`, `form_id` and **no `transaction_id` / `listing_id`** — the link
genuinely does not exist on the row. Fixed using the resolution its own sibling
`getUnsignedDocumentBlockers` already uses correctly: `transaction_documents` IS
transaction-scoped, so the transaction's signable `doc_type`s are the bridge and
signatures are narrowed to those `contract_type`s. Returns `[]` when the transaction
has no signable documents.

**Residual limit stated, not hidden:** two open deals in one brokerage needing the
same doc_type still share these rows, because no column distinguishes them. Closing
that requires a `transaction_id` (or `transaction_document_id`) column on
`contract_signatures` plus a backfill — a migration, deliberately not invented here.

`getUnsignedDocumentBlockers` is correct as written (transaction-scoped docs, per-type
signature status) and remains unwired; its surface would be the transaction readiness
/ blockers panel.

---

## Files reviewed but NOT wired — findings and exactly what finishing needs

Each of the exports below was read in full and confirmed correctly gated by earlier
passes (session-derived identity, tenant on the predicate, `error` destructured).
None is a duplicate of a live implementation. They are unwired capabilities, and the
specific gap is named for each.

### `app/actions/buyer-offer/track-offer-lifecycle.ts:markOfferExpired` — **LESSON-1 SHAPE, needs an unattended door**
The most important item in this list. The function is correct: it refuses to record
an expiry that has not happened (no `response_deadline` → refuse; deadline in the
future → refuse), which is exactly the "the reason recorded must be the reason that
happened" discipline. But **an offer expiring is a TIME event with no human actor**,
and the gate is `requireOfferActor(offerId)` — `auth.getUser()` plus a
same-brokerage check. There is no cron anywhere in `app/api/cron/` that sweeps
expired offers (searched for the function name and for offer-expiry logic in
`lib/`), so the only caller that would ever fire this is one the gate turns away.
Finishing it needs a nightly sweep route with its OWN door onto the underlying
transition — `app/api/cron/<name>/route.ts` selecting offers whose
`response_deadline` has passed and whose state is still open, using the service
client and the brokerage on the offer row, registered in `lib/kernel/cron-dispatch.ts`
— **never** a fake identity passed into the session-gated action. Not built here:
adding a cron touches the dispatch registry and deserves its own change.

### `app/actions/ai-newsletter.ts:manageSubscribers`, `manageSubscriberBatch`, `aiPersonalizeNewsletter`
The subscriber list IS populated automatically — `lib/content/newsletter-enrollment.ts`
auto-enrolls leads/contacts on lifecycle events — so these are the MANUAL management
door (add the open-house walk-in, remove on a verbal request, bulk-add selected
contacts), which `/newsletters` has no UI for at all despite showing an "Active
Subscribers" stat. Finishing needs a subscribers panel on `app/newsletters/newsletters-client.tsx`
(single add/remove by email for `manageSubscribers`; a contact multi-select for
`manageSubscriberBatch`, whose 500-id cap and de-dupe the UI must respect).
`aiPersonalizeNewsletter` needs a per-recipient preview surface — it personalises ONE
newsletter for ONE contact, so it belongs behind a "preview as <contact>" control on
the newsletter editor, and it bills a model call per invocation, so it must be
explicit rather than on render.

### `app/actions/learning-modules.ts:updateLearningModuleAction`
Same shape as the locations fix above: `app/dashboard/admin/learning-modules/learning-modules-client.tsx`
has Create and Publish and no EDIT, so a typo in a published module cannot be
corrected. Admin-gated and brokerage-scoped already. Finishing is an edit dialog over
the same `UpdateLearningModulePatch` fields. (Left only for budget — it is the same
one-dialog job as `updateLocationAction`.)

### `app/actions/superadmin/parked-retention.ts:getParkedRetentionAction`
**Duplicate, and the duplication is the reason it has no caller.**
`app/dashboard/superadmin/platform/page.tsx` calls `loadParkedRetention()` directly
via dynamic import with the service client, relying on the page's own superadmin
gate. Noted divergence: the PAGE gate is `user_type !== 'superadmin'` only, while
`requireSuperadmin()` in the action also accepts `platform_role === 'superadmin'` — so
a platform_role superadmin is locked out of the whole page. Not a hole (narrower, not
wider), but the two gates should agree. Left rather than re-pointed because the page
read is not wrong, only redundant; the honest fix is to align the page's gate with
`requireSuperadmin` and let the action serve the refresh after a purge.

### `app/actions/ce-provider.ts:connectCeProvider`
Correctly gated (broker/admin, brokerage-scoped, writes
`brokerage_settings.settings.ce_provider`). `lib/kernel/manager-registry.ts` claims
"UI in the License & CE settings page" — **that UI does not exist**; no `.tsx` in the
tree references it. Note also that its admin test ORs on `users.role`, which is
RETIRED (live: 19/23 NULL, the rest title-cased) — that branch can never match, so
the `user_type` branch is doing all the work. It is not a hole (the working branch is
correct and complete) but the dead `role` clause should come out when the settings UI
is built. Finishing needs a License & CE section under settings with provider name,
launch base URL and catalog.

### Reviewed, correct, and awaiting only a surface
- `app/actions/vendor-portal.ts:uploadVendorJobDocument` — vendor-side job document
  upload; already verifies the job belongs to this vendor AND links to the claimed
  transaction via `vendor_assignments`. Needs an upload control on `/vendor/jobs`.
- `app/actions/seller-coaching.ts:dismissCoachingCard` — needs a dismiss affordance on
  the seller coaching card surface.
- `app/actions/portal-messages.ts:getPortalMessages` — `requireContactAccess`-gated
  thread reader; needs the portal messages view.
- `app/actions/compliance/manage-required-docs.ts:listTemplateFormOptions` — the form
  picker feeding required-doc templates; needs the required-docs admin screen's
  template selector.
- `app/actions/vendor-budget.ts:getPlatformVendorBudget` — platform-staff-only
  per-brokerage vendor budget view; its sibling
  `getPlatformVendorSpendOverview` powers the support console, so this is the
  drill-down that console has no row-click for yet.
- `app/actions/open-house.ts:getAgentListings` — listing picker for creating an open
  house; correctly refuses when it has no scoping context rather than falling back to
  every listing.
- `app/actions/photo-management.ts:getPhotoOrderingRules` — per-agent photo ordering
  rules reader; the rules have no management surface.
- `app/actions/analytics.ts:aggregateValueDelivered`, `trackLeadValueJourney` — both
  already carry heavy prior fixes (phantom-table replacement, tenant anchors, a
  unified day window). NOTE for whoever wires `trackLeadValueJourney`: its
  `toolsUsed` / `guidesDownloaded` arrays are hardcoded empty with "would need actual
  tracking" comments, so `valueReceived` is always 0 and `roiMultiple` always 0. It
  must NOT be surfaced as a value/ROI number until those two reads are real — that
  would be a fabricated metric.

## NOT REACHED in this slice

Read only far enough to confirm they are not duplicates of anything already handled;
no changes made and no findings recorded for them:

`app/actions/lead-readiness/evaluate-readiness.ts` (batchEvaluateLeadReadiness) ·
`app/actions/buyer-broker-agreements.ts` (createBBADraftAction) ·
`app/actions/neighbor-notifications.ts` (listNeighborCampaignsForListing) ·
`app/actions/video-content.ts` (createShortClip) ·
`app/actions/stock-video-upload.ts` — done · `app/actions/content-prediction.ts`
(getPredictionAction) · `app/actions/ai-voice-transcription.ts` (transcribeAudio) ·
`app/actions/ai-referral-management.ts` (analyzeReferralProgram) ·
`app/actions/ai-listing-intake.ts` (aiOptimizePhotoOrder, runCompleteListingIntake) ·
`app/actions/ai-closing-workflow.ts` (aiTrackClosingMilestones) ·
`app/actions/transaction-transparency.ts` (markDelaysCommunicated) ·
`app/actions/marketing-studio.ts` (generateCampaignContent, updateCampaign) ·
`app/actions/listing-lifecycle.ts` (getListingTasks, sendReviewRequest) ·
`app/actions/blog.ts` (getBlogPostById, getBlogPosts, getSeoKeywords) ·
`app/actions/onboarding/agent-onboarding-actions.ts` (fetchMyOnboardingDashboard)

Note for the next slice: `transcribeAudio`, `runCompleteListingIntake`,
`aiOptimizePhotoOrder`, `analyzeReferralProgram`, `getPredictionAction` and
`generateCampaignContent` are all AI-spend endpoints — check each for an entitlement
gate standing in for an authentication gate (the exact hole already found and fixed in
`aiAnalyzeCampaignPerformance`), and confirm none can be invoked to bill a model call
without a resolved session.
