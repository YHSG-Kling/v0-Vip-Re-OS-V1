# Orphan burndown — wave 2, slice 2 (`"use server"` action modules)

Method (owner's rule), per orphaned export:
(a) **duplicate?** establish the survivor by reading both → **merge the loser's unique capability onto the
survivor first**, then delete. Name the survivor `file.ts:fn`. "No caller" is never a deletion rationale.
(b) **not a duplicate?** either it belongs to a surface (wire it) or it is an advanced feature worth having
(finish it, or record exactly what finishing needs and leave it).
Hardening an endpoint without wiring it is a valid outcome — it stays in the census, and that is correct.

Every file here is `"use server"`, so **every export is a public HTTP endpoint**.

Wave 1's report on the same slice is `docs/orphan-burndown-slice2.md`. Exports it already handled
(`copilot.ts` ×4, `campaign-sequences.ts:cancelEnrollment`/`getSequenceSteps`,
`ai-voice-transcription.ts:transcribeAudio`, `direct-mail.ts:trackDelivery`,
`lead-readiness/evaluate-readiness.ts:batchEvaluateLeadReadiness`) are **not redone here**; they remain in the
census by design.

I did **not** run `tsc` / `npm run type-check` / `npm run guard` — explicitly instructed not to (three
concurrent typechecks OOM'd the box last wave). The orchestrator typechecks centrally.

Status: IN PROGRESS — appended as each file is finished.

---

## `lib/ads/facebook-audience-sync.ts` — 2 orphans. Both KEPT + GATED. 🚨 Whole file was anonymous.

Orphans: `loadFacebookAudiences`, `getAudienceSyncHistory`.

### 🚨 The finding that matters: unauthenticated cross-tenant control of ad audiences

Every export took `userId`, `params.brokerageId` and `params.agentId` **from the caller** and had **no auth
gate at all**. `canAccessFeature(userId, "ads_audiences")` is an *entitlement* check on a caller-chosen
identity — it authenticates nothing. Those values were then packed into an `AdsActorContext` and handed to
`lib/kernel/ads.ts`, which runs on **`createServiceClient()` — RLS bypassed** — and scopes purely on
`ctx.brokerageId`. So a caller-supplied brokerage uuid was the whole access-control story:

- `loadFacebookAudiences` / `getAudienceSyncHistory` — read any brokerage's audience definitions, source
  rules, consent basis, external Meta audience ids and sync history.
- `syncFacebookAudience` — **the sharp one.** Kernel `syncAudience` selects up to **10,000 `contacts`
  (id, email, phone, first_name, last_name)** for `ctx.brokerageId`, SHA-256 hashes them and **pushes them to
  Meta/Google under that audience's provider credential**. An anonymous caller with a brokerage uuid and one
  of its audience uuids could force another tenant's consented contact list to be uploaded to an ad platform.
- `createFacebookAudience` / `approveAudience` (flips an audience **live on Meta**) / `deleteAudience` —
  anonymous writes.

### Fixed
Added a non-exported `resolveAdsActor()` gate (`getAgentContext()` → refuse unauthenticated, refuse missing
brokerage) and wired **all seven** exports through it. `userId` params and the `brokerageId`/`agentId` fields
on the params objects are **retained but ignored** so the live call sites in
`app/dashboard/campaigns/ads/ads-dashboard-client.tsx` keep type-checking (house pattern in this repo).

`agentId` is deliberately **omitted** from the constructed context when the session has none (brokers/admins
have no `agents` row). It is never back-filled from `users.id` — disjoint id spaces — and never coerced to
`""`. Verified first that none of the three kernel commands reached from this file
(`loadAudienceDefinitions`, `syncAudience`, `createAudienceSegment`) reads `ctx.agentId`.

Related, worth noting: the dashboard was calling `syncAudience(userId, { brokerageId, agentId: userId, … })` —
a `users.id` in an `agents.id` slot. Harmless only because the kernel ignores the field. The gate now supplies
the real value (or none), so the bogus one is no longer used.

### Orphan verdicts
- **`loadFacebookAudiences` — KEPT + GATED.** Not a duplicate of anything with a caller: the ads page
  (`app/dashboard/campaigns/ads/page.tsx`) loads audiences server-side via
  `lib/kernel/ads.ts:loadAdsWorkspace`, and every dashboard mutation refreshes with `router.refresh()`. This
  is the *client-callable* refresh path for the audiences tab — real capability, no wiring today.
- **`getAudienceSyncHistory` — KEPT + GATED.** Per-audience drill-down. It loads the brokerage's audience list
  and `.find`s the id, which — now that the list is session-scoped — **is** the ownership check: an id from
  another tenant simply is not in the list and it answers "Audience not found". Recorded that in a comment so
  nobody "optimises" it into a bare `audience_sync_runs` read keyed on `audienceId` alone, which would
  reintroduce the IDOR.

---

## `lib/ads/ad-creator.ts` — 1 orphan. KEPT + GATED. Whole file was anonymous; 3 more defects fixed.

Orphan: `getCampaignCreatives`.

### 🚨 Unauthenticated, plus unmetered AI spend
All seven exports took `userId` / `brokerageId` from the caller with **no auth gate**. This file uses the
anon cookie-bound client, so RLS bounds the blast radius — but not the rest of it:

- `created_by` on `ad_campaigns` and `actor_user_id` on `lifecycle_events` were **forgeable audit fields**.
- `canAccessFeature(userId, "ad_creator")` was, again, an entitlement check on a caller-chosen identity.
- **`generateAdCreative` had no feature gate at all.** The file header names
  `canAccessFeature('ad_creator')` as a kernel gate and the function's own numbered comments jump from
  **1 straight to 3** — step 2 was never written. So the one export that spends model tokens
  (`claude-sonnet-4`, 1500 output tokens, on the platform key) was the only one nobody metered, and it was
  reachable without a session. Added the gate **and** the matching `incrementFeatureUsage`.
- **`generateAdCreative` read the campaign with `.eq("id", adCampaignId)` and no tenant predicate** (same
  class as wave 1's `blog.ts:getBlogPostById`), destructuring `data` only. A bare campaign uuid disclosed
  another brokerage's campaign, and then the function *wrote creative variations against it*. Now scoped on
  the session brokerage, `maybeSingle()`, and **fails closed on `error` as well as on no rows** — a refused
  read is not "no rows".
- **`launchAdCampaign` had the tenant predicate on its read but not on its UPDATE.** Added.

### Three more defects fixed while in there
1. **`rejectCreativeVariation` accepted `reason` and silently threw it away.** The reviewer's rejection note —
   the entire point of a review queue — was written nowhere. `ad_creative_variations` has no
   `rejection_reason` column (confirmed against the live schema), so it is now recorded on `lifecycle_events`
   as `ad_creative_rejected` with `metadata.reason`, the ledger the approval rail already reads.
2. **Every mutation reported success on zero rows.** `approveCreativeVariation`, `rejectCreativeVariation`,
   `launchAdCampaign` and `updateCampaignStatus` destructured `error` only, so a row RLS hides — or one that
   never existed — returned `{ success: true }` having changed nothing. All four now `.select("id")` and
   refuse when nothing moved. (Same fail-open class wave 1 found at `assistant.ts:setSuggestionStatus`.)
3. **Schema drift in `updateCampaignStatus`'s type.** Its union accepted `"active"` and `"completed"`;
   `ad_campaigns_status_check` is
   `('draft','pending_review','approved','launching','live','paused','ended','failed')` (verified live), so
   either value was a guaranteed `23514`. Narrowed to the real vocabulary. The only call site passes
   `"approved"`.
4. The model's JSON was `JSON.parse`d and inserted straight into `ad_creative_variations`
   (`variation_name` NOT NULL). Now shape-validated; an off-shape response is refused rather than inserted.

### Orphan verdict — `getCampaignCreatives`: KEPT + GATED, **deletion blocked on a merge I cannot make**
Partial duplicate. Survivor is **`lib/kernel/ads.ts:previewAdCreative`** — same read, brokerage-scoped, and
strictly stronger because it also refuses when the campaign does not belong to the tenant;
**`lib/kernel/ads.ts:loadAdsWorkspace`** covers the list axis the ads page actually renders (it nests
`ad_creative_variations (*)`, and every dashboard mutation refreshes through it).

The one capability the orphan has that the survivor lacks is a deterministic
`.order("created_at", { ascending: true })` — A/B variations rendered in generation order. Per the
merge-first rule that ordering must land on `previewAdCreative` **before** this is deleted, and
`lib/kernel/ads.ts` is outside this slice's file list. Hardened in place and the reasoning left in a comment
above the function.

**→ HANDOFF:** add `.order("created_at", { ascending: true })` to the `ad_creative_variations` query in
`lib/kernel/ads.ts:previewAdCreative`; `lib/ads/ad-creator.ts:getCampaignCreatives` can then be deleted.

---

## `app/actions/calculators.ts` — 3 orphans. 1 already hardened, 1 hardened, 1 **fixed at the root**.

This file is the public, no-login lead-magnet calculator lane, so "add a session gate" is usually the WRONG
move here — the same reasoning wave 1 applied to `ai-direct-mail.ts:trackCampaignResponse`. Each orphan was
judged on what the caller is actually allowed to assert.

### `emailCalculationResults` — ALREADY HARDENED by an earlier pass. Left as found.
Read in full and verified rather than assumed. It was an **open email relay + PII exfiltration** (any
anonymous caller could send platform-domain mail to any address, and the row carries `user_email` /
`user_name`); a prior wave bound the read to `visitorId` and pinned the destination to the address recorded
on the row. `error` is destructured on the read, so a refusal is not mistaken for "no rows". Nothing to add.

### `getSavedCalculations` — KEPT + HARDENED. Not a duplicate; it is the read half of `saveCalculation`.
Nothing else reads `saved_calculations`. Its callerlessness has a recorded root cause
(`lib/tools/visitor-id.ts`): the calculators screen used to mint a throwaway id per component, so no id
survived to call this with. That half is fixed — `getOrCreateVisitorId()` persists one id per browser and
`saveCalculation` is wired to it — so what remains is purely a missing UI panel.

RLS does not protect this table: the live SELECT policy is
`is_platform_admin() OR brokerage_id IS NULL OR has_brokerage_access(...)`, and `saveCalculation` never sets
`brokerage_id`, so **every row is anon-readable** by the middle clause. The visitor id is the entire
credential. Two fixes:
- **`select("*")` → enumerated columns.** `user_email` and `user_name` are no longer returned. A retrieval
  panel does not need them, and returning them made a guessed visitor id a PII disclosure rather than just a
  calculation disclosure.
- **Blank-id refusal**, so this can never degrade into `.eq("visitor_id", "")`.

And the credential itself was weak: the file's own `generateVisitorId()` minted
`visitor_${Date.now()}_${Math.random().toString(36).substring(7)}` — a guessable millisecond timestamp plus
~5 base-36 chars. That is the *same* too-weak-to-be-a-bearer-token shape the calculator share feature was
removed for, still in use as the key to saved rows. Now `crypto.randomUUID()`, matching what the browser side
already mints.

**→ HANDOFF (wiring):** add a "your saved calculations" list to
`app/dashboard/calculators/calculators-client.tsx`, calling `getSavedCalculations(getOrCreateVisitorId())`.
The action and the id are both ready; only the panel is missing. That file is not in this slice.

### `calculateHomeValue` — 🚨 FIXED: unauthenticated paid-provider + AI spend billed to a caller-named tenant.
Not a duplicate. The sibling public lane `app/actions/home-value.ts:submitHomeValueRequest` is a
lead-capture funnel (contact + valuation_request + scheduling); this is an instant estimate with comps and no
lead capture. Different products over the same engine, which is the intent recorded in its own docstring.

The defect: it took `brokerageId` as a **raw uuid parameter** and passed it to `runAiCma`, which calls
`sourceCompsForCma` (PAID comparable-sales providers) and then an LLM for the narrative. Being
unauthenticated is correct for a lead magnet; letting the anonymous caller **name which brokerage gets
billed** is not. Any uuid holder could run unlimited paid comp lookups and model calls against another
tenant's account.

**Fixed by resolving the brokerage instead of accepting it.** The parameter is replaced (free — no callers)
with an optional `agentSlug`, and the brokerage comes from: (1) the session when signed in — the dashboard
calculators; else (2) `agents.public_slug` via `app/actions/home-value.ts:getAgentBySlug`, the same public
handle `/home-value/[agentSlug]` already personalises from; else (3) refuse. A public handle is something a
visitor legitimately holds; a tenant uuid is not. `getAgentBySlug` returns null for both "no such slug" and a
refused read, so this fails closed either way.

**🚩 STILL OPEN — owner decision, deliberately not guessed:** there is **no rate limit** on this endpoint. With
the brokerage pinned to a real public surface the attacker must now aim at a specific agent's slug, but one
script can still burn that brokerage's comp-provider quota and model spend. No rate-limit helper exists
anywhere in this repo. `submitHomeValueRequest` has the same exposure. Recorded in the code above the
function.

### Flagged, not changed (not orphans)
`calculateSellerNet` and `calculateRentVsBuy` take `brokerageId` from the caller for
`getDefaultCommissionStructure`. Same class, far lower value (commission defaults, no spend), and they have
live callers in `app/dashboard/calculators/calculators-client.tsx`, which this slice does not own.

---

## `app/actions/vendor-payments.ts` — 2 orphans. Both KEPT. 🐛 One carried a real money bug.

Orphans: `markInvoicePaid`, `completeStripeConnectOnboarding`. Both were **already correctly
authenticated** (`resolveWriteContext()` + `verifyInvoiceInCallerBrokerage`, and `requireVendorActor(vendorId)`
respectively) — a prior wave fixed this file's cross-tenant holes and its header records them. No auth finding
here. What was left is worse in a quieter way.

### `markInvoicePaid` — KEPT + FIXED. 🐛 It minted a fresh payout claim on every call.
Not a duplicate: it is the brokerage-side settlement of a vendor invoice. The client-side lane
(`confirmVendorInvoiceCheckout` → `recordDirectCollectionEarnings`) records earnings as **`paid_out`**
because the money went straight to the vendor's connected account; this one records **`available`**, i.e. a
claim the platform still owes. Different states, different money. Nothing to merge.

The bug: `verifyInvoiceInCallerBrokerage` already `select`ed `status` — **and nothing ever read it.** The
function unconditionally inserted a `vendor_earnings` row with `status: 'available'`, `vendor_earnings` has
**no unique index on `invoice_id`** (verified live — only the pkey plus two non-unique indexes), and
`initiateVendorPayout` pays out whatever is `available`. So:

- a double-clicked button, or a retried request, **doubled the vendor's payable balance** against one
  collected invoice;
- worse across paths — a client pays online (`confirmVendorInvoiceCheckout` mints its own earnings row) and a
  TC also clicks "mark paid": two payout claims, one payment received.

Fixed: return early when the invoice is already `paid` (catches the repeat of this action), **and** refuse to
mint when an earnings row already exists for the invoice (catches the cross-path collision, which leaves the
invoice `paid` by a route that never ran this code). That existence read destructures `error` and **fails
closed** — treating a refused read as "no earnings yet" would mint exactly the duplicate the guard exists to
prevent.

Two more silent-failure fixes in the same function: the invoice UPDATE now `.select("id")`s and refuses on
zero rows (it previously reported a payment recorded if the row moved out from under it), and the
`vendor_earnings` insert result — **previously discarded entirely** — is now checked, so a failed earnings
write no longer reports a fully successful payment while the vendor is never credited.

### `completeStripeConnectOnboarding` — KEPT. It is the only implementation that can turn the flag OFF.
**Duplicate, and the survivor has the defect.** Survivor for the "flip it on" half is
`app/api/billing/webhook/route.ts`, the `account.updated` branch →
`lib/connections/vendor-stripe.ts:setStripeOnboardingByAccount`. That path is wired and works, so this orphan
is not simply "the unwired one".

But the webhook branch is `if (details_submitted && charges_enabled) set(..., true)` — **it only ever sets
true.** The orphan computes the same boolean and passes it through, so it also **demotes**. On a money path
that is the whole game: `initiateVendorPayout` hard-gates on `connect.onboardingComplete` before
`stripe.transfers.create()`. When Stripe later restricts a connected account (expired documents, failed
verification, `charges_enabled` → false) the webhook leaves the flag true forever and the payout lane keeps
transferring to a destination that can no longer receive. This is the wave-1 voice-clone shape again: the
orphan holds the correct behaviour, the survivor holds the hole.

Deleting it would remove the only demoting implementation, so it stays. Both handoffs are recorded in a
docstring above the function:

- **→ SURVIVOR FIX (one line, outside this slice):** in `app/api/billing/webhook/route.ts`
  `case "account.updated"`, pass the computed boolean instead of gating on it —
  `setStripeOnboardingByAccount(supabase, account.id, Boolean(account.details_submitted && account.charges_enabled))`.
- **→ WIRING (outside this slice):** `initiateStripeConnectOnboarding` sets
  `return_url: ${appUrl}/vendor/settings?stripe=complete`, but onboarding is *started* from
  `app/vendor/earnings/stripe-connect.tsx`, and `app/vendor/settings/page.tsx` is a bare
  `redirect('/settings/general')` that **drops the query string**. The vendor lands on an unrelated page and
  nothing reads `?stripe=complete`. Point `return_url` at the earnings surface and call this action there.

---

## `app/actions/knowledge/search.ts:trackArticleView` — **MERGED-THEN-DELETED** (nothing to merge).

**Survivor: `app/actions/support.ts:getHelpArticle`** — the Help centre's actual article read, which bumps
the counter via `increment_knowledge_article_view` as part of returning the article. Exactly the relationship
`rateArticle` had with `support.ts:voteArticleHelpful`, resolved the same way, in the same file.

The survivor is strictly better on every axis, so nothing needed porting:
- it is **authenticated** (`getAgentContext` + `isAuthenticated`). `trackArticleView` had **no gate at all**,
  making it a public, anonymous, unbounded **view-count inflation primitive** for any article uuid;
- it is **tenant-checked** (`data.brokerage_id !== ctx.brokerageId → null`) and published-only.
  `trackArticleView` bumped any id, any brokerage, any status;
- its bump is **coupled to an article actually being read and returned**, which is what a view count means.
  `trackArticleView` counted views nobody had.

The loser's only extra was the read-modify-write fallback under the RPC — a **defect, not a capability**: the
same lost-update race that got `rateArticle`'s version replaced, running on the session client where
`knowledge_articles` UPDATE is admin-gated, so it would have silently done nothing regardless. Per the rule
("if the loser's extra is implemented badly, do not port the implementation"), it was not carried over.

**Open question from slice 3, now closed:** `docs/orphan-burndown-slice3.md` flagged that this called
`supabase.rpc('increment', { table_name, column_name, row_id })` and asked whether that RPC is a generic
"increment any column on any row of any table" primitive. **It is not.** Verified live —
`public.increment(table_name text, row_id uuid, column_name text)` is `SECURITY DEFINER` with
`SET search_path = public` and raises unless the `(table, column)` pair is one of four allowlisted counters
(`ai_video_projects.view_count`, `knowledge_articles.view_count/helpful_count/not_helpful_count`). No hole.

**⚠️ ORCHESTRATOR ACTION REQUIRED:** this is a deliberate capability collapse with the survivor named, so the
census floor in `scripts/orphan-export-baseline.json` **must be re-baselined**, the same way wave 1 did for
`resumeCampaignSequence`. `scripts/orphan-export-guard.ts` fails CI otherwise — by design. I did not edit the
baseline; it is not in this slice's file list and two other agents are writing concurrently.

---

## `app/actions/superadmin/connector-healing.ts` — 2 orphans. Both KEPT. Correctly gated; one exposes a survivor defect.

Both pass `assertPlatformStaff()` (session user must be `superadmin` or platform staff) before touching the
service client. No security finding.

- **`listPendingProposalsAction` — duplicate, KEPT.** Survivor is the inline read in
  `app/dashboard/superadmin/connector-healing/page.tsx:ConnectorHealingPage` — identical column list, same
  `status='pending'`, same order, same `limit(200)`, gated by `requirePlatformCapability("providers")`.
  **But the orphan destructures `error` and surfaces it; the survivor destructures `data` only.** On a page
  whose own copy says "the queue must stay short", a refused read renders **"0 pending"** — indistinguishable
  from a healthy empty queue, on the surface whose entire job is to prove the queue is empty. The orphan is
  the only implementation that can tell those apart.
  **→ HANDOFF (survivor fix, outside this slice):** destructure and surface `error` on both reads in
  `app/dashboard/superadmin/connector-healing/page.tsx`.
- **`listRecentProposalsAction` — NOT a duplicate, KEPT.** The page's "recent" read is
  `.neq("status","pending").limit(25)`; this one has **no status filter** (full history including pending),
  a caller-supplied limit correctly clamped to 1..500, and also returns `failure_signature`. A superset — the
  history/"load more" read the page does not have. Unwired capability.

## `app/actions/superadmin/platform-controls.ts:getPlatformControlsAction` — KEPT. Correctly gated.
Superadmin-gated wrapper (`requireSuperadmin()` — and note its `users` read fails **closed**: a refused read
yields `data: null` → not superadmin → Forbidden). The underlying `lib/platform/platform-controls.ts:
getPlatformControls()` is ungated and shared with `app/actions/whats-new.ts`, and the superadmin page
(`app/dashboard/superadmin/platform/page.tsx`) calls it directly as a server component with its own gate. So
this action is the **only superadmin-gated, client-callable** path to that read. Redundant today only because
`setPlatformControlsAction` already returns the fresh controls after a write. Kept — deleting a correctly
gated read of the platform god-switch to move a count is precisely what the method forbids.

## `app/actions/admin/invitations.ts:markBrokerageSetupCompleteAction` — KEPT. Correctly gated, unwired.
`requireBrokerageAdmin()` **plus** an explicit second role check
(`broker | broker_admin | admin | superadmin`) before advancing brokerage onboarding to `completed`. Tenant
comes from the gate, never the caller. Not a duplicate — `advanceBrokerageOnboarding` is the shared writer and
this is the only surface that declares the terminal `completed` state. Purely missing a "we're done setting
up" control on `/dashboard/admin`. Nothing to fix here.

## Verified-safe, left as-is (read and confirmed, not skipped)
- **`app/actions/stock-video-upload.ts:deleteStockClip`** — deletion path, and it is properly gated:
  `auth.getUser()`, then owner-or-(broker/admin **in the same brokerage**) on the clip's own row. The clip read
  destructures only `data`, but that fails **closed** ("Clip not found"). No finding.
- **`app/actions/portal-lifetime.ts:setLifetimeSegment`** — `requireContactAccess(contactId)` and explicitly
  **staff-only** (`access.isContactSelf` is refused, so a client cannot reclassify their own segment); the
  update is scoped by `brokerage_id` from the gate.
- **`app/actions/seller-offers.ts:getOffersForListing`** — `requireCaller()` +
  `verifyListingInCallerBrokerage()` + a `brokerage_id` predicate on the offers read. (Slice 3 recorded this
  one as "not investigated deeply"; it has been now, and it is correct.)
- **`app/actions/seller-offers.ts:recordSellerView`** — dual-path authorization (agent-in-brokerage OR
  seller-self via `contact_user_id`/verified email), tenant-scoped, idempotent.
- **`app/actions/income-engine.ts:completeRecommendedActionAction` / `dismissRecommendedActionAction`** —
  `resolveAgentContext()` and the update is scoped `.eq("agent_id", ctx.agentId)`, so a caller-supplied
  `actionId` alone cannot move another agent's row.
- **`app/actions/auth.ts:loginUser` / `registerUser` / `getCurrentUser`** — these are *supposed* to be
  unauthenticated; they are thin `supabase.auth` wrappers. `registerUser` passes only `first_name`/`last_name`
  into user metadata — **no role, user_type or brokerage_id is accepted from the caller**, so there is no
  self-elevation surface. `loginUser` additionally runs `rejectIfSuspended`. No finding.

---

## `app/actions/ai-vendor-management.ts` — 2 orphans. Both KEPT + GATED. 🚨 Whole file was an anonymous LLM proxy.

Orphans: `coordinateVendors`, `requestVendorReview`. Neither is a duplicate — nothing else in the tree builds
a multi-vendor schedule or drafts a vendor review request. Unwired capabilities, case (b).

### 🚨 THE FINDING: four `"use server"` exports called models with no session at all
The file's **own house pattern is right there** — `transitionBookingStatus` opens with `auth.getUser()` and
refuses. All four AI exports (`getVendorRecommendations`, `analyzeVendorPerformance`, `coordinateVendors`,
`requestVendorReview`) skipped it. `isValidUUID()` is input validation, not authorization.

The sharpest of the four is **`coordinateVendors`**: `params.services` is caller-authored free text
(`serviceType`, `notes`) that is `JSON.stringify`'d **directly into a gpt-4o prompt**. Before this fix, any
anonymous request was an **unmetered gpt-4o proxy on the platform's key** — a free LLM with an arbitrary
prompt — and it read a listing's address and vendors' **phone and email** on the way past with no tenant
predicate at all.

`requestVendorReview` returned another tenant's vendor name and the transaction's **property address** from a
bare job uuid, and spent a model call doing it. `getVendorRecommendations` **selected `brokerage_id` on the
vendors read and then never filtered on it** — every brokerage's vendor contact list, to anyone.

### Fixed
Added a non-exported `requireVendorCaller()` (`getAgentContext()` → refuse unauthenticated, refuse missing
brokerage) and applied it to **all four** exports, including the two that are not orphans — same file, same
hole, and gating is a pure addition that cannot break a legitimate caller. Then, on the two orphans:

- **Tenant predicates.** `listings` and `vendor_jobs` both have a **nullable** `brokerage_id`, so instead of
  `.eq()`-filtering on a column that may be NULL, the row is read and the brokerage **compared explicitly**,
  with an untenanted row refused — an unprovable owner fails closed. The `vendors` read in
  `coordinateVendors` and `getVendorRecommendations` is `.eq()`-scoped (contact PII).
- **`error` destructured before any spend.** `coordinateVendors` previously did `listing?.address || "N/A"` —
  so a refused or cross-tenant listing read still **spent the gpt-4o call**, planning a schedule against
  "N/A". Both reads now fail closed before the model is touched.
- **Cost attribution.** `requestVendorReview` called `generateTextRouted` with `feature: "unspecified"` and no
  `userId`/`brokerageId`, i.e. the spend was logged against nobody. It now passes all three. Routing is
  unchanged — an unknown feature key resolves to the same default row `"unspecified"` did.

## `app/actions/ai-lead-nurturing.ts` — 3 orphans. All KEPT, all **already correct**. Slice 3's flag was a false positive.
`docs/orphan-burndown-slice3.md` flagged these three ("Left — AI SPEND … the file has only one auth marker
across three model-calling exports"). Read in full: the single marker is the file-local `requireCaller()`
helper, and **all three call it** on their first line. `aiCalculateLeadScore`, `aiGenerateDripCampaign` and
`aiPredictConversion` each gate, then scope every `contacts`/`agents` read with
`.eq("brokerage_id", auth.brokerageId)` before spending a token — the file's header even states that is the
point ("scope to caller's brokerage to prevent burning AI $$$ on cross-tenant probing"). No finding; the
record is corrected here so a later wave does not re-open them.

None is a duplicate: scoring a lead, generating a drip campaign and predicting conversion are three distinct
operations. They are unwired capabilities of a wired feature — nothing to merge, nothing to fix.

---

## 🚨 `app/actions/buyer-offers.ts:getBuyerOffers` — FIXED. The worst read in this slice.

Not a duplicate — the seller-side equivalent is `seller-offers.ts:getOffersForListing` (offers *on* a
listing); this is the buyer-side view of *their own* offers. Distinct axis, distinct surface.

It ran on **`createServiceClient()` (RLS bypassed) with no authentication of any kind**, and took **both** the
contact id and the brokerage id from the caller — so `.eq("brokerage_id", brokerageId)` scoped it to whatever
tenant the caller named. It returns a buyer's complete negotiating position: `offer_price`, `earnest_money`,
`financing_type`, `contingencies`, `buyer_notes`, `property_address`, `closing_date`.

In this domain that is not ordinary PII. A competing bidder who learns another buyer's price, contingencies
and financing wins the house. Two uuids — both of which appear in ordinary agent-facing URLs — bought that.

**Fixed with `requireContactAccess(contactId)`** (`lib/portal/require-contact-access.ts`), which is the right
shape here rather than a plain staff gate: it admits **the buyer themselves** (portal, by linked user id or
verified email) **or staff in the contact's own brokerage**, and — the load-bearing part — it returns the
`brokerageId` resolved **from the contact row**. The tenant is no longer assertable by the caller. The
`brokerageId` parameter is retained and ignored (house pattern), and a `isValidUUID` guard was added.

**Flagged, not fixed (not orphans, same file, same class):** `startOfferDraft` writes `lifecycle_events` on
the service client with a caller-supplied `brokerage_id` and a **forgeable `actor_user_id`**, unauthenticated;
`resolveFormSource(buyerId, brokerageId)` and `getConnectedEsignProvider(brokerageId)` take the tenant from
the caller too. They have live callers, so fixing them means signature changes outside this slice.
**Recommend a follow-up covering the whole file.**

## 🚨 `app/actions/listing-lifecycle.ts:sendReviewRequest` — FIXED. Anonymous outbound SMS.
Neither this wrapper nor `lib/application/listing-lifecycle.ts:sendReviewRequestService` had **any** auth
gate. The service reads `review_requests` by a caller-supplied uuid joined to **`contact:contacts(*)` — the
full contact record, phone number included** — and then **dispatches an SMS to that number**. A bare request
uuid let anyone read another brokerage's client PII and make the platform text that client. `dispatchSms`
still applies consent/DNC/quiet-hours, which bounds the abuse but authorizes nobody.

The file's own header promises "validate → **authenticate** → delegate", and `completeListingTask` two
functions above does exactly that. Fixed at the endpoint: session gate, then the `review_requests` row must
belong to the caller's brokerage before the service is allowed to run. `brokerage_id` is nullable there, so
it is compared explicitly and an untenanted row is refused — an unprovable owner must not authorize an
outbound message. `error` is destructured; a refused read fails closed before anything is sent.

**→ HANDOFF — two live bugs in `sendReviewRequestService` (`lib/application/listing-lifecycle.ts`, outside this slice):**
1. **Every review SMS ever sent contained a dead link.** The message is built from a hardcoded map —
   `google: "https://g.page/r/YOUR_GOOGLE_PLACE_ID/review"`, `zillow: ".../YOUR_AGENT_ID/reviews"`,
   `facebook: ".../YOUR_PAGE/reviews"` — placeholders that were never filled in. And `review_requests` **has a
   `review_url` column** (verified live) that the service ignores. Read the row's own URL.
2. `dispatchSms({ brokerageId: (request.contact as any).brokerage_id ?? "", … })` — **an empty string coerced
   into a uuid slot**, precisely the `22P02` trap. A contact with no brokerage silently sends under `""`
   instead of refusing.

## 🚨 `app/actions/transaction-transparency.ts:markDelaysCommunicated` — FIXED. Forgeable compliance record.
Kept, not folded away: the same write exists inline in `logTransactionDelay`, but only fires when a delay is
being *logged* with `notifyClient` set. This is the standalone case — the agent phoned the client about a
delay already on file. Real distinct operation.

It had no auth gate, no tenant scope, and returned the raw PostgREST response.
`timeline_transparency.communicated_to_client` is a **compliance assertion** — the record of whether the
client was actually told their closing is slipping. Keyed on nothing but `transaction_id`, it could be
flipped true for any transaction in the system. That is the one failure a transparency ledger cannot have: it
does not hide a delay, it **manufactures proof that the delay was disclosed**. Now session-gated, scoped by
`brokerage_id`, and `.select()`-verified so zero rows reports failure instead of asserting a disclosure
against a record that does not exist.

**Flagged, not fixed:** `getTransactionDelays(transactionId)` in the same file is also ungated (reads any
transaction's delay reasons and client-facing notices). Not an orphan.

## Verified-safe in the final sweep (read and confirmed)
| export | verdict |
|---|---|
| `activities.ts:getAgentActivities` / `getPendingFollowups` | `resolveOwnAgentId(agentId)` — the caller can only ever resolve to their **own** agents.id. Correct. |
| `ai-closing-workflow.ts:aiTrackClosingMilestones` | `resolveWriteContext()`; `agentId`/`brokerageId` params documented "ignored — the actor is the authenticated caller". |
| `ai-isa/engage-contact.ts:toggleContactAIISA` | same pattern; `brokerageId`/`actorId` explicitly ignored in favour of the session. |
| `ai-listing-intake.ts:aiOptimizePhotoOrder` / `runCompleteListingIntake` | `getAgentContext()` gate before any AI spend, listing verified in the caller's brokerage. |
| `ai-offer-creation.ts:submitCompleteOffer` | `getAgentContext()`, caller-supplied `agentId` explicitly ignored. |
| `buyer-move.ts:getBuyerMoveCaseAction` | `authAndScope(params)`. |
| `compliance/manage-required-docs.ts:listTemplateFormOptions` | `resolveActor()` + `brokerage_id` predicate. |
| `contacts/update-channel-controls.ts:getContactChannelControls` | `authorizeContactAccess(contactId)`. |
| `content-compliance.ts:quickCheck` | `getSessionAgentId()`. |
| `content-compliance.ts:validateContentInput` | pure input validation — no auth needed, touches no data. |
| `creative-playbooks.ts:listCreativePlaybooks` | returns a static in-code catalog; no DB, no PII, nothing to gate. |
| `lifecycle-promo-policy.ts:getMyLifecyclePromoPolicy` | `getAgentContext()`; resolves the caller's own `agents.id` scoped by brokerage. |
| `listing-lifecycle.ts:getListingTasks` | wrapper is bare, but `getListingTasksService` carries `callerBrokerageId()` + a `brokerage_id` predicate **and** destructures `error` ("a refused read is not an empty task list"). Correct as delegated. |
| `marketing-intelligence.ts:getCompetitorPostInspiration` | `getAgentContext()` gate. |
| `onboarding-decisions.ts:getOnboardingDecisionsAction` | `loadMember()` gate, brokerage from the gate. |
| `open-house.ts:getAgentListings` | `getAgentContext()` gate. |
| `portal-seller.ts:getSellerDashboardData` / `getSellerOffers` | `requireContactAccess(contactId)`, brokerage from the contact row. |
| `seller-showing-sentiment.ts:getShowingSentimentSummaryAction` | `auth.getUser()` + caller-brokerage vs listing-brokerage comparison. |
| `transaction-inspections.ts:declineInspectionQuoteAction` / `getInspectionsAction` | `requireCallerForBrokerage()` + `verifyTransactionInBrokerage()`. |
| `vendor-budget.ts:getPlatformVendorBudget` | `resolveActor()` + `isPlatformStaff()` — correctly platform-staff-only. |
| `video-content.ts:createShortClip` | `auth.getUser()` gate. |

### Deliberately left public (this is the design, not a defect)
`open-house-automation.ts:handleRSVP` and `submitFeedback` are **inbound** endpoints: the caller is an
open-house invitee clicking an RSVP link or an attendee filling in a feedback form. They are not, and cannot
be, logged in. Both resolve the tenant from the row they look up (`open_house_invitations` /
`open_house_attendees`), never from the caller — the uuid in the link is a capability token, exactly like
`ai-direct-mail.ts:trackCampaignResponse`, which wave 1 analysed and correctly left public. Adding a session
gate would break the feature.

**Flagged:** neither has replay or rate-limit protection, so RSVP counts and feedback scores can be inflated
by anyone holding a link. Same product decision wave 1 recorded for `trackCampaignResponse`; not changed here.

---

# WHERE I STOPPED

All **43 exports** on this slice's list were given a verdict. Nothing was skipped for time; the ones marked
"left" are left with a reason, not a shrug.

## Changed (13 files)
| file | orphans | verdict |
|---|---|---|
| `lib/ads/facebook-audience-sync.ts` | `loadFacebookAudiences`, `getAudienceSyncHistory` | **gated** — whole file was anonymous over an RLS-bypassing kernel |
| `lib/ads/ad-creator.ts` | `getCampaignCreatives` | **gated** + 4 defects fixed (missing feature gate on the AI call, missing tenant predicate, silent no-op writes, schema drift) |
| `app/actions/calculators.ts` | `calculateHomeValue`, `getSavedCalculations`, `emailCalculationResults` | 1 **fixed at the root** (caller-named tenant billed for paid-provider + AI spend), 1 **hardened**, 1 verified already-hardened |
| `app/actions/vendor-payments.ts` | `markInvoicePaid`, `completeStripeConnectOnboarding` | 1 **fixed** (duplicate payout claims), 1 **kept** with the survivor's defect named |
| `app/actions/knowledge/search.ts` | `trackArticleView` | **merged-then-deleted** — survivor `support.ts:getHelpArticle` |
| `app/actions/ai-vendor-management.ts` | `coordinateVendors`, `requestVendorReview` | **gated** — whole file was an anonymous LLM proxy |
| `app/actions/buyer-offers.ts` | `getBuyerOffers` | **fixed** — unauthenticated cross-tenant read of live offer terms |
| `app/actions/listing-lifecycle.ts` | `sendReviewRequest` | **gated** — anonymous outbound SMS |
| `app/actions/transaction-transparency.ts` | `markDelaysCommunicated` | **fixed** — forgeable compliance record |

## Kept with reasoning, unchanged (30 exports)
Recorded per-export above: `superadmin/connector-healing.ts` ×2, `superadmin/platform-controls.ts`,
`admin/invitations.ts`, `ai-lead-nurturing.ts` ×3, `activities.ts` ×2, `ai-closing-workflow.ts`,
`ai-isa/engage-contact.ts`, `ai-listing-intake.ts` ×2, `ai-offer-creation.ts`, `auth.ts` ×3, `buyer-move.ts`,
`compliance/manage-required-docs.ts`, `contacts/update-channel-controls.ts`, `content-compliance.ts` ×2,
`creative-playbooks.ts`, `income-engine.ts` ×2, `lifecycle-promo-policy.ts`, `listing-lifecycle.ts:getListingTasks`,
`marketing-intelligence.ts`, `onboarding-decisions.ts`, `open-house-automation.ts` ×2 (deliberately public),
`open-house.ts`, `portal-lifetime.ts`, `portal-seller.ts` ×2, `seller-offers.ts` ×2,
`seller-showing-sentiment.ts`, `stock-video-upload.ts`, `transaction-inspections.ts` ×2, `vendor-budget.ts`,
`video-content.ts`.
Wave-1-completed exports (`copilot.ts` ×4, `campaign-sequences.ts` ×2, `ai-voice-transcription.ts`,
`direct-mail.ts:trackDelivery`, `lead-readiness` ×1) were not re-litigated.

## Deliberately NOT done
- **No `tsc` / `npm run type-check` / `npm run guard`** — instructed not to; three concurrent typechecks OOM'd
  the box last wave. The orchestrator typechecks centrally.
- **No files edited outside the assigned list.** Every cross-file fix is a named handoff below.
- **No commit / push / `git add`.**

---

# HANDOFFS (all outside this slice's file list)

1. **`app/api/billing/webhook/route.ts`, `case "account.updated"`** — pass the computed boolean instead of
   gating on it, so a Stripe account that becomes restricted actually demotes. Today
   `stripe_onboarding_complete` can only ever go true, and `initiateVendorPayout` transfers money on it.
2. **`lib/application/listing-lifecycle.ts:sendReviewRequestService`** — (a) every review SMS contains a
   hardcoded placeholder link (`YOUR_GOOGLE_PLACE_ID`) while `review_requests.review_url` sits unused;
   (b) `brokerageId: contact.brokerage_id ?? ""` coerces a missing uuid to `""`.
3. **`lib/kernel/ads.ts:previewAdCreative`** — add `.order("created_at", { ascending: true })`; then
   `lib/ads/ad-creator.ts:getCampaignCreatives` can be deleted.
4. **`app/dashboard/superadmin/connector-healing/page.tsx`** — destructure and surface `error` on both reads;
   a refused read currently renders "0 pending".
5. **`app/dashboard/calculators/calculators-client.tsx`** — add the "your saved calculations" panel calling
   `getSavedCalculations(getOrCreateVisitorId())`. Action and id are both ready.
6. **`app/vendor/earnings/stripe-connect.tsx` + `initiateStripeConnectOnboarding`'s `return_url`** — the
   return URL points at `/vendor/settings`, which is a bare redirect that drops the query string. Point it at
   the earnings surface and call `completeStripeConnectOnboarding` on `?stripe=complete`.
7. **`scripts/orphan-export-baseline.json`** — re-baseline for the `trackArticleView` deletion.

# FOLLOW-UPS RECOMMENDED (not orphans, same defect classes, live callers)
- `app/actions/buyer-offers.ts` — `startOfferDraft` (forgeable `actor_user_id` on the service client),
  `resolveFormSource`, `getConnectedEsignProvider`: caller-supplied tenant, unauthenticated.
- `app/actions/transaction-transparency.ts:getTransactionDelays` — ungated read of delay reasons.
- `app/actions/calculators.ts` — `calculateSellerNet` / `calculateRentVsBuy` take `brokerageId` from the caller.
- **No rate limiting anywhere in this repo.** It is the missing control behind three separate items here:
  `calculateHomeValue` (paid comp providers + LLM), `open-house-automation.ts:handleRSVP` / `submitFeedback`
  (attribution inflation), and wave 1's `ai-direct-mail.ts:trackCampaignResponse`.
