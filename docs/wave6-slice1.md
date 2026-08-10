# Wave 6 — Slice 1 (29 files, 42 category-C orphaned exports)

Branch: `claude/settings-consolidation-ui-0cd7lo`

Every file in this slice carries `"use server"`, so every export is a publicly reachable
HTTP endpoint. Orphaned = no caller anywhere, so nothing is protecting these doors except
whatever gate the function itself carries.

## Exact orphan inventory (from `scripts/orphan-export-guard.ts --list`)

| File | Orphaned exports |
|---|---|
| app/actions/vendor-portal.ts | uploadVendorJobDocument |
| app/actions/portal-stream.ts | getAgentPortalStream, triggerPortalProjectionAction |
| app/actions/portal-lifetime.ts | setLifetimeSegment |
| app/actions/lead-management.ts | getLead |
| app/actions/buyer-offer/track-offer-lifecycle.ts | markOfferExpired |
| app/actions/buyer-broker-agreements.ts | createBBADraftAction |
| app/actions/ai-client-gifting.ts | aiPlanBulkGifting, getGiftAnalytics |
| app/actions/video-generation.ts | createAvatarVideo, queueVideoGeneration |
| app/actions/superadmin/parked-retention.ts | getParkedRetentionAction |
| app/actions/content-studio.ts | saveContentIdea |
| app/actions/compliance/manage-required-docs.ts | listTemplateFormOptions |
| app/actions/ai-vendor-management.ts | coordinateVendors, requestVendorReview |
| app/actions/ai-predictions.ts | getLeadPredictions |
| app/actions/ai-listing-presentation.ts | generateBrochureContent |
| app/actions/ai-cma.ts | getAIPriceAdjustmentRecommendation |
| app/actions/ai-auto-response.ts | trackBehavioralEvent, updateAutoResponseSettings |
| lib/ads/facebook-audience-sync.ts | getAudienceSyncHistory, loadFacebookAudiences |
| app/actions/user-profile.ts | getAgentEmailSignature |
| app/actions/transaction-inspections.ts | declineInspectionQuoteAction, getInspectionsAction |
| app/actions/social-share.ts | canAgentSharePost, getAgentShareHistory |
| app/actions/open-house.ts | getAgentListings |
| app/actions/onboarding/agent-onboarding-actions.ts | fetchMyOnboardingDashboard |
| app/actions/marketing-intelligence.ts | getCompetitorPostInspiration |
| app/actions/lifetime-customer-touchpoints.ts | getLifetimeCustomerContacts, getTouchpointCalendar |
| app/actions/inbox.ts | getInboxMessages, markInboxRead |
| app/actions/creative-playbooks.ts | listCreativePlaybooks |
| app/actions/ce-provider.ts | connectCeProvider |
| app/actions/blog.ts | getBlogPostById, getBlogPosts, getSeoKeywords |
| app/actions/activities.ts | getAgentActivities, getPendingFollowups |

## Findings log

(appended incrementally)

### `app/actions/vendor-portal.ts` — `uploadVendorJobDocument` → **WIRED**

Not a duplicate. The function itself was already finished + hardened in Wave 2 Slice 3
(bytes actually stored, private `transaction-documents` bucket, path-traversal-safe key,
25MB cap, orphan-object sweep on a failed insert). What was left was the wiring, and the
prior wave recorded exactly that: *"`app/components/vendor/job-detail.tsx` … renders an
`Upload` icon, but has no upload control."*

**The surface was a dead dropzone.** `app/components/vendor/job-detail.tsx` rendered a
"Documents / Job photos, invoices, and completion reports" card with a `<input type="file"
multiple>` that had **no `onChange` handler at all**, plus a "Choose Files" button that
opened the OS picker. A vendor picked their invoice, the dialog closed, and *nothing
happened* — no request, no error, no feedback. The completion-report/invoice lane of the
vendor portal was inert while looking live.

**Wired it** (`app/components/vendor/job-detail.tsx`):
- `onChange` now calls `uploadVendorJobDocument` per file with the job's real
  `transaction_id` (read off `job.vendor_assignments.transaction_id`, which
  `getVendorJobs` already selects — the action re-verifies that link server-side, so the
  client is not trusted for it).
- Added the required `documentType` control. `transaction_documents.doc_type` has **no
  CHECK** on the live DB (verified via `pg_constraint`) — it is NOT NULL free text — so the
  vocabulary is a UI list aligned with what other writers use (`inspection_report` is the
  literal `transaction-inspections.ts` writes).
- **Size:** `next.config.ts` sets `serverActions.bodySizeLimit: '8mb'` and base64 inflates
  ~33%, so a browser can never reach the action's own 25MB cap (that cap serves
  server-to-server callers). The client caps at 5MB and says so, instead of letting the
  user hit an opaque Next.js body-limit failure.
- **Uploads are sequential, not `Promise.all`** — each call carries a whole file body and
  the action stores the object before inserting the row; firing them together would race
  the 8MB action budget.
- **Per-file success is proven, not assumed.** `uploadVendorJobDocument` *throws* on any
  gate/storage/insert failure rather than returning `{success:false}`, so a rejection means
  nothing was filed. Only files whose call resolved are listed as uploaded; the rest are
  reported with their real reason. (Directly the "reports success without doing the thing"
  class, at the UI layer.)
- Jobs with no linked transaction disable the control with a stated reason rather than
  failing at the server gate.
- The `FileList` is snapshotted before `value` is reset (the list is live and resetting
  `value` empties it), and the reset is what makes re-picking the same file fire again.

Call site changed: `app/components/vendor/job-detail.tsx`.

### `app/actions/buyer-offer/track-offer-lifecycle.ts` — `markOfferExpired` → **FINISHED (unattended door built) + defect fixed**

Not a duplicate. The function was already correctly session-gated and tenant-scoped by a
prior wave, and its own docblock recorded the unfinished half verbatim:

> *"a scheduled job that needs to run this without a session should call it through a route
> handler holding a service credential, not by naming a user id over HTTP."*

**Nothing ever did — so no offer on this platform has ever expired.** `markOfferExpired` is
the only thing in the tree that can move an offer PENDING → EXPIRED, it requires a browser
session, and it had zero callers. `offers.response_deadline` passes and the offer stays
PENDING forever, while `submitOffer`, `withdrawOffer`, `recordSellerResponse`,
`canBuyerSubmitOffer` and the buyer-facing multi-offer banner all keep treating a dead
offer as live.

**Second defect found while finishing it — the expiry was invisible even when it ran.**
`markOfferExpired` wrote the `buyer.offer.expired` activity and stopped. It never synced
`offers.status`. `lib/buyer-offer/status-sync.ts` documents that column as *"the operational
index"* and maps this exact event to `'expired'` — and `offers.status` is what every screen
reads (`app/portal/[contactId]/offers/page.tsx`, `app/dashboard/listings/[id]/offers/`,
`lib/kernel/approval-queue-aggregator.ts`, `app/actions/portal-seller.ts`). So the action
returned `{success:true}` while the audit trail said EXPIRED and every UI still showed the
offer live. Textbook "reports success without doing the thing".

**Built (Lesson 1 — the unattended caller gets its OWN door, no fake identity):**

- **`lib/buyer-offer/expire-offers.ts`** (NEW, plain module — deliberately *not*
  `"use server"`, nothing here is an endpoint). Holds the session-free core:
  - `expireOffer(svc, input)` — proves the deadline actually passed and the offer is
    actually PENDING (both derived from stored data, never asserted), writes the activity,
    then updates `offers.status` **with `.select()`** so the result is proven, not intended.
    If the activity lands but the status update matches no row it returns a *failure* naming
    that split, rather than a clean success with the trail and the screens disagreeing.
  - `sweepDueOfferExpirations(svc, opts)` — scans due offers and expires each.
- **`app/api/cron/offer-expiry/route.ts`** (NEW) — `verifyCronAuth` + service credential,
  calling the library core **directly**. It does not call the session-gated action and does
  not name a user id. The actor on each expiry is the offer's own `agent_id` (verified live:
  `offers.agent_id` FKs `agents(id)`, so it is already the right id space — no `??`
  substitution across the users/agents boundary).
- **`lib/kernel/cron-dispatch.ts`** — registered at `52 * * * *` (hourly, offset from
  `deadline-watcher` at `:45`). Verified with `npx tsx scripts/cron-dispatch-simulator.ts`:
  17/17 pass, including "every cron route is registered" and "every registry path resolves
  to a real route file".
- `markOfferExpired` now **delegates to the same core** after its session gate, so the two
  doors cannot drift.

**Live-schema checks made before writing** (project `hrvaqgvukzxfskkcrwbt`):
- `offers.status` — `character varying`, nullable, **no CHECK** (`pg_constraint` lists eight
  CHECKs on `offers`; none is on `status`). `'expired'` is storable and is the literal
  `status-sync.ts` already maps to.
- `offers.agent_id` → `FOREIGN KEY (agent_id) REFERENCES agents(id)`.
- `activities.brokerage_id` NOT NULL, **no default** — `expireOffer` refuses rather than
  attempting a write that would silently die (Lesson 8).
- The sweep filter uses `.or("status.is.null,status.not.in.(…)")`, **not** a bare
  `.not("status","in",…)`: `offers.status` is nullable and `NULL NOT IN (…)` is NULL, so the
  simple form would silently drop every offer whose index column was never stamped.

**SECURITY FINDING (medium) — noted, NOT in my orphan set, left alone deliberately.**
`getOfferLifecycleState` in this same file is a `"use server"` export with **no
authentication at all**, running on `createServiceClient()` (RLS off). Anyone who knows or
guesses an offer uuid can read that offer's full lifecycle history — states, timestamps,
actor ids, and the free-text `reason` on withdrawals — for any tenant. It is category A/B
(it has callers), so hardening it belongs to whoever owns those call sites; flagging it here
so it is not lost.

Call sites changed: `app/actions/buyer-offer/track-offer-lifecycle.ts` (delegates),
`lib/kernel/cron-dispatch.ts` (registry). New: `lib/buyer-offer/expire-offers.ts`,
`app/api/cron/offer-expiry/route.ts`.

### `app/actions/ai-client-gifting.ts` — `aiPlanBulkGifting`, `getGiftAnalytics` → **WIRED + a money-lane defect chain fixed**

Neither is a duplicate. `app/actions/gift-studio.ts` (`getGiftStudioAction`,
`orderGiftSelectionAction`) is a different, narrower surface — single-contact studio flow —
and exports nothing equivalent to a sphere-wide bulk plan or a spend/ROI rollup.

**SECURITY / CORRECTNESS FINDING (high) — the gifting lane wrote nothing and reported
everything.** Chasing why the analytics orphan had no data turned up a chain, all confirmed
against the live schema (project `hrvaqgvukzxfskkcrwbt`).

**(A) `createGiftOrder` has never written a row.** `client_gifts.brokerage_id` is **NOT NULL
with no default**, and the insert omitted it entirely, so every gift order died on a NOT NULL
violation. The result was destructured `const { data: gift }` with **no `error`** — supabase-js
resolves the rejection — so the action returned `{ success: true, data: null }` and the
gifting panel toasted *"Gift order placed."* while nothing existed. Exactly the
`activities.brokerage_id` class from Lesson 8, compounded by Lesson 9, in the money lane.
`createGiftOrder` is not one of my orphans, but it is the survivor's only data source, so it
is fixed here: `brokerage_id` and `agent_id` now come from the **session** (they were
caller-asserted on a public `"use server"` insert), `error` is destructured, a null row is a
failure, and `agentId` is retained-and-ignored so existing call sites keep type-checking.

**(B) `getGiftAnalytics` read four things that are not true.**
1. **Columns that do not exist.** `client_gifts` has **no `cost`** and **no `vendor`** column —
   the money is `actual_cost` / `estimated_cost` and the supplier is `vendor_name`. `g.cost`
   was `undefined` on every row, so `totalSpent` was **always 0**, `byOccasion` was all
   zeros, and `topVendors` labelled every gift `"Unknown"`. Reader and writer never agreed.
2. **`estimatedROI: "Infinity%"`.** With `totalSpent` pinned at 0,
   `(referralCount * avgCommission) / totalSpent * 100` is `Infinity` (or `NaN` at zero
   referrals) and `.toFixed(0)` renders that literally.
3. **A hardcoded `avgCommission = 8000`** — fabricated money driving a headline ROI. Replaced
   with the real sum of `referrals.commission_amount`; when no attributed referral carries an
   amount, `estimatedROI` is **`null`** and the UI says the ROI is unavailable. No stand-in.
4. **The referral join was backwards.** "Referrals *from* gifted clients" means the gifted
   client is the **referrer** → `referrals.referrer_contact_id` (the FK
   `lib/kernel/referral-appreciation.ts` and `app/actions/referrals/referral-appreciation.ts`
   populate, and the one `ai-sphere-management.ts:437` embeds). It filtered
   `referred_contact_id` — referrals whose *newly introduced* contact happened to be gifted.

   Also fixed: both reads now destructure `error` and **fail closed** (a refused read
   returned `{success:true, totalSpent:0}` — "you spent $0 on clients" is not distinguishable
   from "the query was refused"); the year window is half-open (`.lte(…"-12-31")` compared a
   timestamptz to midnight and dropped every gift recorded during 31 December); `.in()` is
   skipped on an empty id list; and the malformed embed
   `referrals:contacts(referrals!referred_contact_id(id))` — which aliased `contacts` twice
   and was never read — is gone.

**Wired both** into `app/lifetime-customers/components/campaigns-gifting-panel.tsx`, the
existing surface that already drives `aiRecommendGift` / `createGiftOrder` /
`aiGenerateThankYouNote` over the same lifetime-contact list:
- **Gift budget card** (`getGiftAnalytics`) — spend, gift count, recipients, average, top
  vendors, referrals attributed, ROI-or-stated-unavailable. Load failure renders the error
  with a Retry, never a fake `$0`. Refreshes after a successful order.
- **Bulk gifting dialog** (`aiPlanBulkGifting`) — tiers, per-tier budget, timeline, vendors.
  Gated behind an explicit button, never fired on mount, because it spends real gpt-4o
  tokens; the budget is validated finite-and-positive **before** the call, since the action
  interpolates `totalBudget` straight into the prompt. `agentId` is not sent — the action
  derives the sphere from the session. The dialog states that a plan is not an order.

Call sites changed: `app/lifetime-customers/components/campaigns-gifting-panel.tsx`,
`app/actions/ai-client-gifting.ts`.

### `app/actions/video-generation.ts` — `queueVideoGeneration`, `createAvatarVideo` → **2 DELETIONS (both with named survivors), 1 capability MERGED, 1 WIRING**

#### `queueVideoGeneration` → **DELETED**
Survivors: **`app/actions/video.ts:submitVideoGenerationJobAction`** (tenant-gated by
`assertProjectInCallerBrokerage`, delegating to
`lib/kernel/video.ts:submitVideoGenerationJob`, which claims the project slot atomically)
and **`app/actions/video-generation.ts:generateVideoFromScript`** for the "I already have a
script" entry point. These are literally the *"ai_video_projects insertion path"* the stub's
own error message named.

Its entire body was `return { error: "schema drift — use ai_video_projects insertion path
instead" }` after an auth gate. A public HTTP endpoint that could never queue anything.
**Nothing was ported** — a stub that returns an error string has no capability to move.

Its schema-drift note was also partly stale: the live `video_generation_queue` does carry
`user_id`, `organization_id`, `organization_type`, `source_url`, `content_category`,
`ai_generated_script`, `edited_script`, `script_status`, `compliance_approved`,
`compliance_flags`, `social_caption` (that lane is the link-to-video/social queue,
`app/actions/link-to-video.ts`). It still lacks `agent_id`/`script_id`/`template_id`/
`script_content`/`video_type`/`scheduled_for`/`metadata`, which is why `ai_video_projects`
remains the right rail. `lib/kernel/manager-registry.ts` records an explicit ruling that
only two paths may claim the `ai_video_projects` render slot, so reviving this as a third
writer would have been actively harmful.

#### `createAvatarVideo` → **DELETED (duplicate)**
**SURVIVOR: `app/actions/video-generation.ts:generateVideoFromScript`.**

Same capability — saved script + avatar + voice → D-ID/ElevenLabs render — but this copy
carried the exact defect the survivor had already been fixed for (documented in the manager
registry under `video_queue_terminal_state`), unfixed:

> **It called the paid provider for real, then wrote the returned job id to `console.log`
> and nowhere else.** `poll-did-videos` selects `ai_video_projects` rows on
> `status='generating' AND provider_job_id NOT NULL AND provider_metadata->>provider='did'`.
> This path created **no project at all**, so the render was unpollable forever — the agent
> was billed for a video nothing could ever find — while the function returned
> `{ success: true, status: "generating" }`.

It also defaulted a missing avatar/voice to `""` and called the provider anyway. **That
laxness was deliberately not ported**; the survivor refuses (`lib/did` refuses rather than
rendering a stock stranger).

**MERGED FIRST, then deleted.** Its one genuine capability the survivor lacked was
*rendering a script that is already in `video_scripts_library`, by id, with a tenant check*
— the survivor only took raw text and **inserted a fresh library row every render**.
`generateVideoFromScript` now accepts `scriptId`: it reads `script_content`/`title` from the
stored row, destructures `error` so a refused read is not read as "script not found",
enforces `brokerage_id === caller`, refuses an empty stored script, and **skips the
duplicate library insert** on that path. `script`/`title` became optional; both existing
call sites (`app/components/video/VideoGenerationButtons.tsx`,
`app/content-studio/content-studio-client.tsx`) pass them and are unaffected.

**WIRED the merged capability** so it is not merged-and-dormant:
`app/components/video/VideoGenerationButtons.tsx` takes an optional `scriptId` and forwards
it, and the Video Script Library detail sheet
(`app/dashboard/videos/library/page.tsx`) now renders those buttons for the selected script
— gated on `approval_status === 'approved'`, because rendering spends provider credits and
that page already treats approval as the gate before a script may become a video.

Call sites changed: `app/actions/video-generation.ts`,
`app/components/video/VideoGenerationButtons.tsx`, `app/dashboard/videos/library/page.tsx`.

**Left deliberately:** `getVideoQueue` (not in my orphan set — it has callers) is still a
stub returning `[]` behind an auth gate, for the same drift reason. Flagged, not touched.

### `app/actions/ai-vendor-management.ts` — `requestVendorReview` (WIRED), `coordinateVendors` (left, with a precise finish spec)

Neither is a duplicate; both were already session-gated and tenant-scoped by a prior wave.

#### `requestVendorReview` → **WIRED**
Surface: `app/components/transactions/VendorBookingSection.tsx`, on the "Assigned Vendors"
job list that already renders each `vendor_jobs` row with its status. A **"Draft review
request"** control appears only on jobs at `status === "completed"`, only on explicit click
(it spends a model call on the platform key — never on render), and the result is presented
as a **draft the agent copies**, not something sent. A failed call renders its error rather
than an empty draft.

Also fixed a wiring trap in the action itself: `agentId` is documented as session-derived
and never read, yet `isValidUUID(params.agentId)` **rejected the call unless the caller
invented a uuid for it**. Any honest caller passing nothing would get `"Invalid IDs"` from a
parameter the function ignores. It is now optional and unvalidated, and the error names the
one id that matters (`"Invalid job ID"`).

#### `coordinateVendors` → **left unwired, deliberately. What finishing needs:**
It takes a `listingId` plus a caller-authored list of services and returns a full
coordination plan (schedule, critical path, conflicts, per-vendor message drafts, budget).
Two concrete blockers, both verified:
1. **No surface exists.** Every listing-scoped vendor UI in the tree
   (`VendorBookingSection`, `suggested-vendors.tsx`, `vendor-booking-button.tsx`,
   `vendor-directory-client.tsx`) books **one** vendor at a time; nothing collects a
   multi-service basket for a listing, which is this function's entire input.
2. **The output has nowhere to live.** The code comments *"vendor_coordination_plans table
   doesn't exist — return in-memory"*, and that is still true: a live
   `information_schema.tables` sweep for `%coordination%`/`%vendor%` returns
   `agent_coordination_log`, `vendor_plans` (marketplace subscription tiers) and 23 others,
   **none** of which models a per-listing service schedule. So a plan costing a gpt-4o call
   evaporates on refresh.

Finishing it = (a) a `vendor_coordination_plans` table (listing_id, brokerage_id, plan jsonb,
created_by, created_at) or an agreed `vendor_assignments` extension, and (b) a multi-service
basket on the listing vendor rail. Both are outside this slice's file set; wiring it as-is
would have shipped a paid AI call whose result cannot be kept.

### `app/actions/ce-provider.ts` — `connectCeProvider` → **WIRED + authorization defect fixed**

Not a duplicate. `lib/kernel/manager-registry.ts:ce_provider_integration` claims *"UI in the
License & CE settings page"* — but `app/dashboard/settings/license-ce/page.tsx` imported only
`getCeCenter` and `launchCeCourse`. **The connect form was never built**, which is why this
export had zero callers, and the agent-facing panel literally reads *"Ask your broker to
connect one"* while offering the broker no control anywhere in the app to do it. The whole
in-app CE lane was therefore permanently in its empty state.

**SECURITY / VOCABULARY FINDING — the brokerage owner was locked out of their own setup.**
The gate was:
```
["broker","admin","broker_admin","superadmin"].includes(user_type)
  || ["broker","admin","owner"].includes(role)
```
Against the live `users_user_type_check` (admin, agent, broker, **broker_owner**,
compliance_officer, contact, isa, lender, superadmin, support, system, tc, team_lead, vendor):
- **`broker_admin` is not storable** — a dead branch that can never match.
- **`broker_owner` is storable and was missing** — the owner of a brokerage could not connect
  their CE provider.
- The `users.role` fallback is a **retired column** (Lesson 6: mostly NULL, the rest
  title-cased), i.e. a second authorization door keyed on a column that no longer holds the
  answer. Removed; `role` is no longer selected.

Also hardened, all in the same function:
- `error` destructured on the profile read — a refused read was rendered as "no profile",
  turning an infrastructure failure into an authorization *decision*.
- **The settings read now fails closed.** It was `const { data: row }` with no `error`, and
  the result seeds a spread into an upsert — so a refused read would be taken as "no settings
  yet" and the upsert would **replace every other setting this brokerage has with `{}`**.
- Refuses configurations that cannot work: empty name (`isCeProviderConnected` requires one),
  `connected: true` with no launch URL (`buildLaunchUrl` then returns nothing and every
  course launch silently fails), and a non-https launch URL.
- The upsert now `.select()`s and treats a zero-row result as failure — success is proven.

**Wired:** `app/dashboard/settings/license-ce/ce-center-panel.tsx` gains a broker/admin-only
"Accredited CE provider" section (name, https launch URL, live toggle, save) calling
`connectCeProvider`; `page.tsx` resolves `canManageProvider` from `users.user_type` using the
same live vocabulary. That prop only decides what to *render* — the action re-checks
server-side, so the client is never the gate.

Call sites changed: `app/actions/ce-provider.ts`,
`app/dashboard/settings/license-ce/ce-center-panel.tsx`,
`app/dashboard/settings/license-ce/page.tsx`.

### `app/actions/inbox.ts` — `markInboxRead` (WIRED, real defect), `getInboxMessages` (left, reasoned)

#### `markInboxRead` → **WIRED. It fixes a genuine read-state split.**
Not a duplicate of `ai-communication-hub.ts:markConversationRead` — they clear **different
ledgers**, and only one of them was ever called:

| | what it clears |
|---|---|
| `markConversationRead` (wired) | `conversations.unread_count` — the thread **badge** |
| `markInboxRead` (orphan) | `messages.status='unread'` → `'read'`, and `client_portal_messages.read=false` → `true` with `read_at` — the **message rows** |

So opening a conversation in the inbox zeroed the badge and left every underlying message row
unread. Anything counting those rows directly — the kernel's `loadUniversalInbox`
`totalUnread`, and the **client portal's own unread state** on `client_portal_messages` —
went on reporting messages the agent had already read.

Wired into `app/dashboard/communications/inbox/InboxClient.tsx:handleSelect`, next to the
existing `markConversationRead`, keyed on the thread's `contacts.id`. Lead threads return
before this point (no `conversations` row, no read state), which matches the function's
contact-keyed shape. The list is read through a ref, because `handleSelect` runs inside
`startTransition` and closing over `conversations` captures a stale array — the same class
the file's own `loadThread` comment already documents. A failure is logged, not swallowed
into the badge update.

#### `getInboxMessages` → **left, with reasoning.**
Not a duplicate either, but wiring it is a restructure rather than a connection.
`app/dashboard/communications/inbox/page.tsx` loads threads via
`ai-communication-hub.ts:getConversations`, which reads the **`conversations` table**.
`getInboxMessages` wraps `lib/kernel/communications.ts:loadUniversalInbox`, which
**aggregates at read time** across `messages`, `client_portal_messages`, `voice_calls` and
`isa_outreach_log`. They return different shapes for different models of "a thread", and the
inbox UI, its realtime subscription, its lead lane and its compose bar are all built on the
`conversations` shape. Swapping the reader is an inbox re-architecture, not a wiring, and it
is not in this slice's file set.

Worth recording alongside it: `app/api/inbox/messages/route.ts` is a **third** door onto the
same kernel function and **nothing in the tree fetches it** either. Consolidating
`getInboxMessages` + that route onto one reader is the real piece of work here.
