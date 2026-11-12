# Orphan burn-down — Slice 3 (`"use server"` action modules)

Every file in this slice is a `"use server"` module, so **every export is a publicly
reachable HTTP endpoint**. The audit for each export is therefore not only "is it a
duplicate" but "is this a live, unreviewed, unauthenticated endpoint".

Method (owner's, followed exactly):
1. Duplicate? → find the survivor by READING it. Merge every capability the loser has
   and the survivor lacks, THEN delete. If the loser's extra is implemented badly,
   port the *intent* or fix the class at the survivor — never port a defect.
2. Not a duplicate? → wire it to the surface it was written for, or record precisely
   what finishing it needs and leave the code.
3. Never delete to move a number.

---

## SECURITY FINDINGS (unauthenticated endpoints) — see the summary section at the bottom

---

## Per-export ledger

### `lib/lead-storage.ts` — `insertLead`, `checkLeadExists` → **merged-then-deleted (file removed)**

**Security finding (high).** `lib/lead-storage.ts` was a `"use server"` module with **no
authentication of any kind** — no `getAgentContext`, no `auth.getUser`, no session read.

- `insertLead(leadData: any)` — an unauthenticated public endpoint that performed
  `supabase.from('leads').insert(leadData)` with **entirely caller-supplied columns**,
  including `brokerage_id` and `agent_id`. Anyone who could POST to the action could
  write arbitrary rows of PII into any tenant's `leads` table. It used the *cookie*
  client (`@/lib/supabase/server`), so it also ran with whatever the anon RLS policy
  permits rather than a deliberate service-role decision.
- `checkLeadExists(...)` — an unauthenticated read of any brokerage's leads, keyed on a
  caller-supplied `brokerageId`.

**Survivors, verified by reading:**
- `lib/kernel/crm.ts:createLeadOnlyRecordForAcquisitionSource` — the canonical `leads`
  writer. Strictly richer than `insertLead`: explicit tenant + owner stamps, `normalizeEmail`
  / `normalizePhone` + `phone_digits`, the source taxonomy (`source_family` /
  `source_channel`), `lifecycle_state: "raw"`, `is_active`, timestamps, and it destructures
  `error` and returns a typed `CRMResult` instead of throwing. It takes a typed param object,
  not `any`.
- `app/api/cron/lead-scraping/route.ts:insertRawRecord` — the canonical scrape-ingest writer
  ("ALL scraping paths funnel through this"), which is the lane `checkLeadExists` was written
  for (its `sourcePlatform` + `contentHash` signature is a scraped-content dedupe key).

**Merge analysis — what the losers had that the survivors lack: nothing.**
`checkLeadExists`'s only apparent extra was content-hash dedupe. The survivor achieves the
same guarantee *atomically at the database*: `raw_scraped_leads_source_record_id_key
UNIQUE (source, source_record_id)` (verified live against project `hrvaqgvukzxfskkcrwbt`),
with `insertRawRecord` catching `23505` and skipping. The loser's version was a
read-then-write TOCTOU race over `ilike('notes', '%hash%')` — an unindexed substring scan on
a free-text column, which would also false-positive on any note that merely quoted the hash.

It was also **failing open**: `const { data } = ...` never destructured `error`, so a refused
or errored read returned `false` = "not a duplicate" and the caller would insert anyway.
Per the owner's rule the fix would be to make the gate fail closed — but the capability is
already held correctly by a unique index, so there is no defect to port and nothing to merge.

Deleted `lib/lead-storage.ts` (whole file; both exports were its only contents, and nothing
in the repo imported it).

---

### `app/actions/video-voice.ts` — `getVoiceProfileById`, `getDefaultVoiceProfile`, `getTrainingJobStatus`, `resolveAgentIdFromUserId` → **merged-then-deleted** (+ one undeclared extra, below)

All four were subsumed duplicates. Survivors named, each verified by reading:

| loser | survivor | what the survivor already has |
|---|---|---|
| `getVoiceProfileById(profileId)` | `app/actions/video-voice.ts:getVoiceProfiles` | The profile is a **singleton per agent** (`agent_voice_profiles` carries a UNIQUE index on `agent_id` — stated in `createVoiceProfile`'s own contract), so `getVoiceProfiles(agentId)` returns *that* profile with `voice_clone_training(...)` embedded, scoped by `agent_id`. |
| `getTrainingJobStatus(trainingId)` | `app/actions/video-voice.ts:getVoiceProfiles` | The capture UI (`app/dashboard/videos/voice/voice-client.tsx`) polls by re-calling `getVoiceProfiles` and reads the nested jobs — it never had a reason to fetch a job by id. |
| `getDefaultVoiceProfile(agentId)` | `app/actions/video-voice.ts:getVoiceOptionsForGeneration` (`.defaultVoiceClone`) | Same filters **plus** `elevenlabs_voice_id IS NOT NULL`. |
| `resolveAgentIdFromUserId(userId)` | `lib/identity/get-agent-context.ts:getAgentContext` | Resolves the *session*, plus `user_role_assignments`, the `users.user_type` → role-assignment → metadata priority chain, `brokerageId`, and the platform-staff act-as / impersonation seam. |

**Merge analysis — nothing to move, and two of the "extras" were defects, not features:**
- `getVoiceProfileById` and `getTrainingJobStatus` used `select("*")` where the survivor selects an
  explicit column list. The delta (verified against the live table) is
  `provider_response`, `brokerage_id`, `training_job_id`, `provider`, `voice_profile_id` —
  a raw provider blob and a tenant id being handed to a **client component**. That is a leak to
  close, not a capability to port. `voice-client.tsx` reads only `id`, `status`,
  `sample_manifest`, `error_message` — all already in the survivor's select.
- Both by-id readers were scoped by **nothing** (a bare `.eq("id", …)`), where every survivor is
  scoped by `agent_id`.

**Also removed — DECLARED, and it was invisible to the census:**
`app/actions/video-voice.ts` exported a *second* `getAgentContext(userId)` that shadowed the
canonical `lib/identity/get-agent-context.ts:getAgentContext`. It had no callers either, but the
export census counts a name as referenced wherever that name appears, so the collision hid it.
Body was `agents.select("id, brokerage_id").eq("user_id", userId)` with the userId supplied by the
caller — an unauthenticated `users.id → agents.id + brokerage_id` oracle. Removed with the rest;
declaring it here so the re-baseline is a decision and not a rubber stamp.

**Census note for whoever re-baselines:** a name-shadowed export is a blind spot in
`scripts/orphan-export-guard.ts` — it resolves references by *name*, so any orphan sharing a name
with a live symbol elsewhere reads as referenced. Worth a follow-up.

---

### `app/actions/direct-mail.ts` — `getMailCampaign`, `getResponseSummary` → **merged-then-deleted**; `trackDelivery` → **kept, hardened, wiring recorded**

`getMailCampaign(campaignId)` → survivor `app/actions/direct-mail.ts:getMailCampaigns`.
Same table, same `select("*")`, and it is what both live surfaces call
(`app/dashboard/campaigns/mail/mail-dashboard.tsx`,
`app/dashboard/marketing/studio/marketing-studio-client.tsx`). One campaign is a `.find()`
over a list those surfaces already hold. The loser's only difference was the *absence* of the
`brokerage_id` filter — not a capability. Nothing to merge.

`getResponseSummary(campaignId)` → survivor `app/actions/direct-mail.ts:getResponses`
(the Responses tab's reader). Same table, same filter, returns the full rows —
`response_type` among them — so the per-type counts were a `reduce()` over data the caller
already had. Nothing to merge.

#### `trackDelivery` — NOT a duplicate, and it uncovered a broken surface

**Finding: the Tracking tab has no writer.** `getTrackingRecords` is live —
`mail-dashboard.tsx:148` calls it and feeds `tracking-tab.tsx`. It reads `mail_tracking`.
`trackDelivery` is the **only writer of `mail_tracking` in the repository**, and nothing calls
it. So the Tracking tab renders empty for every campaign, always, and has since it shipped.

The real Lob receiver — `app/api/webhooks/lob-events/route.ts` — is the survivor for the
*event* channel: shared-secret authenticated, reconciles via
`lib/outcomes/reconciliation-ledger.ts:ingestProviderTruth`, mirrors a terminal outcome onto
`direct_mail_campaigns.status`. But it does **not** write `mail_tracking`. So the capability
`trackDelivery` holds (the per-piece tracking row the agent-facing tab reads) genuinely is not
held anywhere else. Deleting it would have deleted the only thing that could ever populate
that tab. **Kept.**

Two defects fixed in place rather than left for the wiring:
1. **It was an anonymous forgery endpoint.** `"use server"` + no auth + caller-supplied
   `brokerageId` + free-form `deliveryPayload` = anyone could post "delivered" or
   "returned_to_sender" against any brokerage's campaign, on the most expensive touch the
   platform makes and the one a broker is most likely to be asked to prove. Now gated on
   `LOB_WEBHOOK_SECRET`, matching the receiver's own documented posture — **unset = refuse**,
   never silently open.
2. **The tenant was accepted, not resolved.** `brokerage_id: params.brokerageId` straight onto
   the insert. Now read off the campaign row, and the read destructures `error`: a campaign that
   cannot be read is a **refusal**, not a NULL tenant on a written row.

**To finish (one call, in a file outside this slice)** — in
`app/api/webhooks/lob-events/route.ts`, after `ingestProviderTruth` and inside the existing
`lob_order_id` lookup that already resolves the campaign:

```ts
await trackDelivery({
  campaignId:      campaign.id,          // already resolved from lob_order_id
  batchId:         pieceId,              // Lob piece id — the per-piece batch key
  brokerageId:     "",                   // ignored; resolved from the campaign server-side
  deliveryPayload: { status: eventType, mailed_at: …, delivered_at: …, returned_at: … },
  webhookSecret:   process.env.LOB_WEBHOOK_SECRET,
})
```

Note the route currently `.select("id")`s only on the terminal-status branch, so it needs the
lookup hoisted to cover in-flight events too (`created` → `rendered_pdf` → `in_transit` →
`in_local_area` → `processed_for_delivery`), which is the whole point of a per-piece tracking
tab. Left for whoever owns that route.

---

### `app/actions/buyer-offer/*` — `emitMultiOfferEvent` **wired**; `checkDuplicateOffer`, `markOfferExpired` **left with reasons** — and a severe bug in the gate all four sit on

#### THE BUG (found while looking for the survivor; fixed)

`app/actions/buyer-offer/track-offer-lifecycle.ts:getOfferLifecycleState` **never filtered by the
offer**. The read was:

```ts
.from("activities").select(...).eq("entity_type", "contact")
  .in("activity_type", [ ...seven buyer.offer.* types... ])
  .order("created_at", { ascending: true })
```

`offerId` was validated at the top of the function and then never used in the query. On a
**service client**, so: it returned every `buyer.offer.*` activity in the database across all
tenants, took the newest, and returned it as "the current state of THIS offer". Every offer on
the platform reported the same state — whichever offer event fired last, anywhere.

Everything gates on it: `submitOffer`, `withdrawOffer`, `recordSellerResponse`,
`markOfferExpired`, `canBuyerSubmitOffer`, `checkDuplicateOffer`, `getBuyerActiveOffers`, and
`app/components/offer/multi-offer-status-banner.tsx` — a banner a buyer actually sees.

**The survivor named the key.** `lib/buyer-offer/status-sync.ts:syncOfferStatus` /
`getCurrentOfferStatus` read offer lifecycle events as `entity_type='offer'` +
`entity_id=<offer id>`. The four writers in `track-offer-lifecycle.ts` were writing
`entity_type:"contact"` with **no `entity_id` at all**, hiding the offer id inside a JSON string
in `notes`. So there is a second consequence: `offers.status` could never sync — `syncOfferStatus`
queries exactly the shape these writers never produced, and had never matched a single row.

Fixed both sides in this slice's files: the read now filters
`.eq("entity_type","offer").eq("entity_id", offerId)`, and all four writers stamp that key.
Safe to repoint with no back-compat shim — verified live, `activities` holds **0** rows with
`activity_type LIKE 'buyer.offer.%'` (pre-rollout).

*Left for the vocabulary owner:* `status-sync.ts`'s `EVENT_TO_STATUS` maps
`buyer.offer.signature.requested` → submitted and `buyer.offer.counter.received` → countered,
while these writers emit `buyer.offer.submitted` and `buyer.offer.countered`. Accepted /
rejected / withdrawn / expired agree and will now sync; submitted and countered still will not.
One map, two names — someone has to pick. Not changed here: `status-sync.ts` is outside this slice.

#### `emitMultiOfferEvent` → **WIRED** (not a duplicate)

It was the emitter for three governance signals nothing raised. The pure classifier
`lib/offers/multi-offer-rules.ts:limitProximity` returns `"clear" | "approaching" | "at_limit"` —
*exactly* this function's event vocabulary. The two halves were written for each other and never
joined. Now:
- `canBuyerSubmitOffer` emits `approaching_limit` / `at_limit` off `limitProximity(pendingCount)`.
- `checkDuplicateOffer` emits `duplicate_attempted` when it finds a live offer on the listing.

Both best-effort (`.catch(() => {})`): a signal that cannot be recorded must never fail the gate
it is reporting on. `emitMultiOfferEvent` already carried a proper auth gate + brokerage check
from an earlier pass, so wiring it does not open anything.

#### `checkDuplicateOffer` → **left, with the wiring named**

Not a duplicate — nothing else checks for a live offer by the same buyer on the same listing;
`canBuyerSubmitOffer` only counts, and `app/actions/buyer-lifecycle-core.ts:canBuyerSubmitOffers`
(plural — the one the offer pages call) is a different, eligibility-shaped gate. Now reachable
via the emitter wiring above, but its real caller should be the offer-creation path,
`app/actions/buyer-offers.ts:createOffer` — outside this slice. It should refuse when
`has_duplicate` is true, before an offer row is written.

#### `markOfferExpired` → **left, with the wiring named**

Not a duplicate — it is the only code that can move an offer to EXPIRED. `offers.response_deadline`
is written (`app/actions/seller-offers.ts:310`) and rendered as "Respond by …" in at least four
surfaces (`app/approvals/page.tsx`, `app/dashboard/listings/[id]/offers/*`,
`app/portal/[contactId]/offers/page.tsx`, `lib/portal/resolve-seller-context.ts`), and **nothing
expires an offer when that deadline passes**. The capability is real and unfinished.

To finish: a daily sweep over `offers` where `response_deadline < now()` and `status` is still
live, calling `markOfferExpired(offerId, systemUserId)`. Note it takes a `systemUserId` that must
be a real `users.id` — it resolves `agents.id` through `resolveAgentId` (an earlier pass already
fixed that identity-class bug here), so the sweep needs a designated system user, not a
substituted id. Needs a new cron route: outside this slice.

---

### `app/actions/activities.ts` — `getAgentActivities`, `getPendingFollowups` → **left (not deleted), hardened, wiring named**

Neither is a duplicate worth deleting, and the near-survivor is *worse*, so deleting would have
been a downgrade.

**Near-survivor:** `app/mobile/assistant/page.tsx` (the RSC) inlines almost exactly
`getPendingFollowups`' query — `activities` filtered by `agent_id` + `status='pending'`, ordered
by `scheduled_at`, with the contact joined — and feeds it to `MobileFollowupPanel`. That page is
demonstrably the surface these were written for: `logActivity` in this same file calls
`revalidatePath("/mobile/assistant")`.

Two reasons not to delete in favour of the inline copy:
1. The action **filters `activity_type` to `["followup","callback","reminder","task"]`**; the
   inline query returns every pending activity. That is a real behavioural difference, and the
   panel is called "Followups".
2. The inline query is written `const [{ data: followupTasks }, …] = await Promise.all([…])` —
   **`error` is never destructured**. A refused read renders an empty day. That page's own
   comment says these panels previously "rendered its empty state forever while the rows sat in
   the database — the agent standing in the field saw 'nothing today' no matter what their day
   actually held". The undestructured error puts them one RLS change away from that same bug.
   Flagging it; `app/mobile/assistant/page.tsx` is outside this slice.

**Security fix applied here (both exports).** Both are `"use server"` exports — public HTTP
endpoints — that took `agentId` **from the caller** with no authentication whatsoever.
`getPendingFollowups` embeds `contacts(id, first_name, last_name, phone, email)`, so an anonymous
caller walking agent ids was reading **contact PII out of arbitrary brokerages**, bounded only by
whatever the anon RLS policy happens to allow. Added `resolveOwnAgentId`: resolves the agent from
the session via `lib/identity/get-agent-context.ts:getAgentContext` (which also carries the
platform-staff act-as seam, so impersonation keeps working) and refuses a requested id that is not
the caller's. Zero callers existed, so nothing could break.

**To finish:** have `app/mobile/assistant/page.tsx` call `getPendingFollowups(agentId, 20)`
instead of inlining the query — it already holds `agentId` from `getAgentContext()`, so the new
ownership check passes unchanged, and the page gains both the `activity_type` filter and a
destructured error.

---

### `app/actions/lead-readiness/evaluate-readiness.ts` — `batchEvaluateLeadReadiness` → **left (not a duplicate), hardened, wiring named**

Not a duplicate. The sibling `evaluateAndLogLeadReadiness` (live —
`app/components/lead/LeadReadinessPanel.tsx`) evaluates **one** lead and *logs* a readiness
transition; the batch form deliberately does not log, because a dashboard rendering a pipeline
must not write a transition per row. Different jobs.

Three defects fixed before it can be wired — it is a `"use server"` export, so a public endpoint:
1. **No authentication at all.**
2. **No tenant scope.** `lib/lead-readiness/readiness-evaluator.ts:evaluateLeadReadiness` reads
   with the **service client** and filters `.eq("id", leadId)` only. So an anonymous caller
   passing arbitrary lead ids read other brokerages' `lead_score` / `lead_stage` /
   `enrichment_confidence` / `motivation_confidence` with RLS bypassed. Ids are now intersected
   against the caller's brokerage first, and the intersect read destructures `error` — a refused
   read is a refusal, not "none of these are yours" (returning an empty set would be a false
   claim that nothing in the pipeline is ready).
3. **Unbounded fan-out.** `Promise.all` over a caller-supplied array turned one request of N ids
   into 2N concurrent service-role queries. Capped at 200.

**To finish:** it wants the lead-pipeline / lead-desk list view, which currently shows stage but
not readiness. That surface is outside this slice.

#### Separate bug found in the survivor path — `lib/lead-readiness/readiness-evaluator.ts` (NOT in this slice)

```ts
const { data: activities } = await supabase
  .from("activities").select("created_at, activity_type")
  .eq("contact_id", leadId)          // ← leadId is a leads.id
```

`activities.contact_id` carries `activities_contact_id_fkey → contacts(id)` (verified live), and
`leads.id` / `contacts.id` are disjoint id spaces. A `leads.id` in that filter can therefore
**never** match a row. So `lastActivityDate` is permanently `null` for every lead, and whatever
readiness component depends on contact recency is computed as "never touched" for the entire
pipeline, forever. It also does not destructure `error`, so a refused read is indistinguishable
from the (always) empty result. Needs an owner decision on the right join — probably
`leads.contact_id` after conversion, and honest "no activity yet" before it. Left alone: outside
this slice.

---

### `app/actions/data-health.ts` — `purgeInvalidContacts` → **left (not a duplicate), HARDENED — the most serious finding in this slice**

Not a duplicate. Nothing else bulk-purges health-flagged contacts.

**Finding (critical).** This was a `"use server"` export that took **no arguments**, performed
**no authentication**, **no role check**, and **no tenant scoping**. Reaching it soft-deleted
every contact flagged `validation_status='Invalid'` in **every brokerage** — and then `DELETE`d
the matching `data_health_logs` rows, destroying the only record of what had been purged and why.
A no-argument destructive endpoint is the worst case of this class: an attacker does not even
have to guess a parameter.

It also **lied on failure**: `const { data: invalidLogs } = …` never destructured `error`, so a
refused read fell through to `{ success: true, deletedCount: 0, message: "No invalid contacts to
purge" }` — reporting a clean bill of health to an operator when in fact nothing could be read.

Fixed in place (the capability is wanted; the exposure was not):
- Authenticated via `lib/identity/get-agent-context.ts:getAgentContext`.
- **Role-gated** to `broker` / `broker_admin` / `admin` / `superadmin`.
- A **read-only act-as** session is refused — a read-only impersonation grant must not be able to
  bulk-delete a tenant's contacts.
- All three statements scoped with `.eq("brokerage_id", ctx.brokerageId)` (column verified live on
  both `data_health_logs` and `contacts`).
- The health-log read destructures `error` and **refuses** rather than reporting "nothing to purge".

**To finish:** it wants a confirm-dialog button on the data-health surface. Outside this slice.

---

### `app/actions/social-share.ts` — `canAgentSharePost`, `getAgentShareHistory` → **left, wiring named**

Neither is a duplicate to delete.

- `canAgentSharePost` looks like a duplicate of the guards inside
  `app/actions/social-share.ts:shareListingPost` (same two checks: `approval_status === 'approved'`
  and `brand_compliance_passed === true`), but it is a *pre-flight* check, not the enforcement.
  The enforcement stays where it belongs — server-side inside `shareListingPost`, which is live in
  `app/dashboard/social/social-dashboard-client.tsx:263`. Deleting the pre-check would remove the
  ability to disable a Share button, not remove a duplicated guard. It already fails **closed**
  (any read error → `{ canShare: false }`), which is the right direction for a gate.
- `getAgentShareHistory` has no survivor at all — nothing else reads `agent_social_shares`.

**To finish:** `app/dashboard/social/social-dashboard-client.tsx` should call `canAgentSharePost`
to gate its Share control and `getAgentShareHistory` to show what the agent has already shared.
That file is outside this slice.

**Note (not changed):** both take `agentUserId` / `brokerageId` from the caller with no session
check, leaning entirely on RLS. Lower severity than the others here — the reads are
brokerage-filtered and return share metadata rather than PII — but they should resolve the actor
from `getAgentContext()` when they are wired, exactly as `app/actions/activities.ts` now does.

---

### `lib/ads/ad-monitor.ts` — `ingestCompetitorAd`, `ingestCompetitorPost` → **left; one is superseded but could not be merged from here**

`ingestCompetitorAd` **is** superseded. Survivor:
`app/api/cron/competitor-ads-exa/route.ts` (POST), which writes the same `competitor_ads` table
**atomically** — `upsert(..., { onConflict: "source_platform,provider_ad_id" })`, the key the
route's own header calls "the canonical idempotency key" — and carries strictly more:
`competitor_id` linkage, `ad_delivery_start` / `ad_delivery_stop`, `geo_relevance`,
`engagement_score`, `categories`, `page_name`.

The loser's dedupe is a defect, not a capability: a read-then-write TOCTOU over
`(brokerage_id, source_platform, ad_headline)`. An ad **headline is not an identity** — two
competitors can run the same headline, and one competitor can change theirs — so it both merges
distinct ads and duplicates the same one.

**Not deleted, because I could not complete the merge from inside this slice.** The loser writes
two fields the cron does not: `media_url` and an explicit `first_seen_at`. Per the method, the
merge lands on the survivor *first* — and the survivor is a cron route outside this slice.
**Recommended for the ads owner:** add `media_url` + `first_seen_at` to the cron's upsert, then
delete `ingestCompetitorAd`. Recording it rather than doing it, so the next pass does not have to
re-derive the analysis.

`ingestCompetitorPost` → **left, genuinely unfinished.** It is the **only writer of
`competitor_posts` anywhere in the repository** (verified: the only other file mentioning the
table is `lib/kernel/manager-registry.ts`, as ownership metadata). Meanwhile
`lib/ads/ad-monitor.ts:generateInsights` reads `competitor_posts` and feeds it to the model, and
`app/dashboard/campaigns/competitive/competitive-monitor-client.tsx` renders posts. So the posts
half of the competitive monitor is a **surface with no source** — the ads half got its Exa cron
and the posts half never did. Deleting the only writer would make that permanent.

**To finish:** a competitor-posts scrape lane alongside `competitor-ads-exa` (Apify social scrape
is already in the repo), calling `ingestCompetitorPost`. Note it should gain the same idempotency
key treatment — as written it is a bare `.insert()` with no dedupe at all, so a re-run duplicates
every post.

*(Not a bug: `canAccessFeature(params.brokerageId, …)` looks like an id-class error, but
`lib/kernel/0.1-feature-access.ts` documents an explicit tenant-id fallback naming "competitor
monitor ingest/insights" as the rail that passes a `brokerages.id` here.)*

---

## Remaining exports — classified, not individually rewritten

Time-boxed. Each line below is a real verdict from reading the export and looking for its
survivor/surface, but without the depth of the sections above. Nothing here was deleted.

| export | verdict |
|---|---|
| `lib/ads/ad-creator.ts:getCampaignCreatives` | **Left.** Plain brokerage-scoped read of `ad_creative_variations`, destructures `error`. No survivor. Wants the ad-campaign detail surface. Unauthenticated (takes `brokerageId` from the caller) — resolve from `getAgentContext()` when wired. |
| `app/actions/contacts.ts:archiveContact` | **Left — already correct.** Authenticates via `getAgentContext()` and delegates to `archiveContactRecord`. Purely unwired: needs the Archive control on the contact surface. |
| `app/actions/seller-offers.ts:recordSellerView` | **Left — already correct.** Full dual-path authorization (agent-in-brokerage OR seller-self by `contact_user_id`/email), tenant-scoped write, idempotent via `.is("seller_viewed_at", null)`. Wants a call from the seller offers portal view. |
| `app/actions/seller-offers.ts:getOffersForListing` | **Left.** Not investigated deeply. |
| `app/actions/knowledge/search.ts:trackArticleView` | **Left.** Unauthenticated counter bump on any article id — low severity. **Worth a separate look:** it calls `supabase.rpc('increment', { row_id, table_name, column_name })`. If that RPC really does take a table and column by name, it is a generic "increment any column on any row of any table" primitive reachable by anything that can call RPCs; this action passes literals, so this endpoint does not expose it, but the RPC itself should be reviewed. |
| `app/actions/ai-referral-management.ts:analyzeReferralProgram` | **Left — AI SPEND, UNAUTHENTICATED (see findings).** Takes `agentId` from the caller, reads that agent's referrals + transactions, and runs `generateObject` against Claude Sonnet. |
| `app/actions/ai-lead-nurturing.ts` (`aiCalculateLeadScore`, `aiGenerateDripCampaign`, `aiPredictConversion`) | **Left — AI SPEND (see findings).** Not investigated deeply; flagged because the file has only one auth marker across three model-calling exports. |
| `app/actions/assistant.ts` (`handleAssistantQuery`, `handleAutomationTriggered`, `handleTaskDelegated`) | **Left.** Not investigated deeply. |
| `app/actions/buyer-execution.ts` (`getBuyerUpdateHistory`, `handleBuyerVoiceAssistant`, `logBuyerAction`) | **Left — see the dedicated finding below; the whole module is unauthenticated.** |
| `app/actions/portal-seller.ts`, `portal-lifetime.ts`, `seller-showing-sentiment.ts`, `superadmin/platform-controls.ts`, `onboarding-decisions.ts`, `income-engine.ts`, `transaction-document-signatures.ts`, `transaction-transparency.ts`, `vendor-budget.ts`, `vendor-invite.ts:revokeVendorInviteAction`, `communications.ts`, `listing-lifecycle.ts`, `open-house.ts`, `open-house-automation.ts`, `marketing-intelligence.ts`, `content-studio.ts`, `content-compliance.ts`, `blog-cadence-policy.ts`, `lifecycle-promo-policy.ts`, `stock-video-upload.ts`, `video-content.ts`, `ai-calendar-management.ts`, `ai-listing-intake.ts`, `ai-listing-presentation.ts`, `ai-vendor-management.ts`, `ai-content-generation.tsx` | **Not reached.** All carry at least one auth marker (see the scan in the findings section), which is why they were deprioritised behind the zero-auth files. Each still needs the duplicate/wire analysis. |

Note on `app/actions/vendor-invite.ts:revokeVendorInviteAction`: read, and it is **correct** —
authenticated, role-gated, `.eq("brokerage_id", caller.brokerage_id)` on the update, only touches
`status='pending'`. Purely unwired: nothing in the repo calls `inviteVendorToPlatformAction`
either (its three "references" are all prose in comments — `lib/vendors/vendor-scope.ts`,
`lib/kernel/manager-registry.ts`, `lib/recruiting/vendor-recruitment-scout.ts`). So the whole
vendor invite/revoke handshake is built and has no button, while
`lib/recruiting/vendor-recruitment-scout.ts` generates a weekly "invite these vendors" brief that
points at it.

---

# SECURITY FINDINGS — unauthenticated `"use server"` endpoints

Every export in this slice is an HTTP endpoint. These are the ones that authenticate nothing and
touch money, messaging, PII, AI spend, or bulk deletion. **Severity order.**

### 1. `app/actions/data-health.ts:purgeInvalidContacts` — bulk cross-tenant contact deletion · FIXED
No arguments, no auth, no role check, no tenant scope. Soft-deleted every `Invalid`-flagged
contact in **every brokerage**, then `DELETE`d the `data_health_logs` rows — destroying the record
of what was purged. Also reported `{ success: true, message: "No invalid contacts to purge" }`
when the read failed. **Fixed**: authenticated, broker/admin only, read-only act-as refused,
brokerage-scoped on all three statements, refuses on a failed read.

### 2. `app/actions/buyer-execution.ts` — the entire module · NOT FIXED, needs an owner decision
No `getAgentContext`, no `auth.getUser`, no session read anywhere in the file, and the underlying
`lib/buyer-execution/*` does not authenticate either. Every actor id is **supplied by the caller**:
- `adminOverrideFinancialVerification({ contactId, adminId, reason })` — overrides the **financial
  gate** that decides whether a buyer may tour or make an offer. Nothing verifies the caller *is*
  that admin, or that the admin holds an admin role. **This one has live callers** (via
  `app/actions/voice-assistant/helpers/command-executors.ts:45`), so it is a reachable auth bypass
  on a money-adjacent gate, not a dormant one.
- `lenderConfirmBuyerFinancials({ contactId, lenderId, approvedAmount, … })` — writes a
  pre-approval / proof-of-funds verification with a caller-declared amount. Also live.
- The three orphans: `handleBuyerVoiceAssistant` (**AI spend** — free transcript → model, keyed on
  a caller-supplied `contactId`), `getBuyerUpdateHistory` (reads any contact's multi-party audit
  trail), `logBuyerAction` (writes arbitrary `eventType` + `metadata` into that audit trail —
  audit-log poisoning).

Left unchanged **deliberately**: the four live exports are load-bearing for the voice-command lane,
and adding an actor check changes how those callers must pass identity. That is an owner decision
about where identity enters the voice lane, not a burn-down edit. Flagging it as the largest
unfixed exposure I found.

### 3. `lib/lead-storage.ts:insertLead` — arbitrary cross-tenant PII write · REMOVED
`supabase.from('leads').insert(leadData)` with `leadData: any` — every column caller-controlled,
including `brokerage_id` and `agent_id`. Deleted (survivor:
`lib/kernel/crm.ts:createLeadOnlyRecordForAcquisitionSource`).

### 4. `app/actions/direct-mail.ts:trackDelivery` — forged provider truth on a paid channel · FIXED
Anonymous endpoint accepting `brokerageId` and a free-form delivery payload, letting anyone post
"delivered" / "returned_to_sender" against any brokerage's mail campaign. Now gated on
`LOB_WEBHOOK_SECRET` (unset = refuse) with the tenant resolved from the campaign row.

### 5. `app/actions/lead-readiness/evaluate-readiness.ts:batchEvaluateLeadReadiness` — service-role cross-tenant read + fan-out · FIXED
The evaluator it fans out to reads with the **service client** and filters on lead id only, so
arbitrary ids returned other tenants' lead scores with RLS bypassed; and `Promise.all` over a
caller-supplied array turned one request into unbounded concurrent service-role queries. Now
authenticated, intersected against the caller's brokerage, capped at 200.

### 6. `app/actions/activities.ts:getPendingFollowups` / `getAgentActivities` — contact PII by agent-id enumeration · FIXED
`getPendingFollowups` embeds `contacts(first_name, last_name, phone, email)` and took `agentId`
from the caller with no session check. Now resolves the agent from the session and refuses a
mismatch.

### 7. `app/actions/video-voice.ts` — a `users.id → agents.id + brokerage_id` oracle · REMOVED
`resolveAgentIdFromUserId(userId)` and a name-shadowing local `getAgentContext(userId)`, both
mapping a caller-supplied user id to tenant identity with no session check. Removed; survivor
`lib/identity/get-agent-context.ts:getAgentContext` resolves the session instead.

### 8. `app/actions/ai-referral-management.ts:analyzeReferralProgram` — AI spend, unauthenticated · NOT FIXED
Takes `agentId` from the caller, reads that agent's referrals (joined to full contact rows) and
transactions, then calls `generateObject` against `claude-sonnet-4`. Anyone can bill the platform's
model budget in a loop and read another agent's referral book doing it. Flagged, not changed —
ran out of slice time. `app/actions/ai-lead-nurturing.ts`'s three model-calling orphans are in the
same category and need the same look.

---

# CORRECTNESS FINDINGS (not security, but live and wrong)

1. **`getOfferLifecycleState` never filtered by the offer** — every offer on the platform reported
   the same lifecycle state. Fixed; see the buyer-offer section. Its writers also used a key
   `lib/buyer-offer/status-sync.ts` cannot read, so `offers.status` had never synced. Fixed.
2. **The direct-mail Tracking tab has no writer** — `getTrackingRecords` is live, `mail_tracking`
   has exactly one writer in the repo, and nothing calls it. Tab renders empty, always.
3. **`lib/lead-readiness/readiness-evaluator.ts` queries `activities.contact_id` with a `leads.id`** —
   `activities_contact_id_fkey → contacts(id)` (verified live) and the two id spaces are disjoint,
   so "last meaningful activity" is permanently null for every lead.
4. **`app/mobile/assistant/page.tsx` does not destructure `error`** on its four field-panel reads —
   the exact bug that page's own comment says it was written to fix.
5. **The census cannot see name-shadowed orphans** — `scripts/orphan-export-guard.ts` resolves
   references by name, so `video-voice.ts`'s local `getAgentContext` read as "referenced" because
   the canonical one is referenced everywhere. One confirmed instance; there may be more.
