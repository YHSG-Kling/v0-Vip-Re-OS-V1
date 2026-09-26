# Wave 6 — Slice 3 (28 files, 39 category-C orphaned exports)

Branch: `claude/settings-consolidation-ui-0cd7lo`. Every file below carries `"use server"`,
so every export is a publicly reachable HTTP endpoint.

## Orphan inventory (from `scripts/orphan-export-guard.ts --list`)

| File | Orphaned exports |
|---|---|
| app/actions/seller-coaching.ts | dismissCoachingCard |
| app/actions/portal-messages.ts | getPortalMessages |
| app/actions/lead-readiness/evaluate-readiness.ts | batchEvaluateLeadReadiness |
| app/actions/buyer-offers.ts | getBuyerOffers |
| app/actions/buyer-move.ts | getBuyerMoveCaseAction |
| app/actions/ai-lead-nurturing.ts | aiCalculateLeadScore, aiGenerateDripCampaign, aiPredictConversion |
| app/actions/campaign-sequences.ts | cancelEnrollment, getSequenceSteps |
| app/actions/superadmin/platform-controls.ts | getPlatformControlsAction |
| app/actions/link-to-video.ts | generateSocialCaption, getVideoDetails |
| app/actions/content-compliance.ts | quickCheck, validateContentInput |
| app/actions/ai-voice-transcription.ts | transcribeAudio |
| app/actions/ai-referral-management.ts | analyzeReferralProgram |
| app/actions/ai-market-intelligence.ts | getMarketAlerts, predictPropertyPrice |
| app/actions/ai-content-generation.tsx | saveDescriptionToListing |
| app/actions/ai-calendar-management.ts | createDeadlineEventsFromMilestones |
| lib/listings/tier-assigner.ts | getRequiredDistributions |
| app/actions/vendor-budget.ts | getPlatformVendorBudget |
| app/actions/transaction-stage-machine.ts | getTransactionStageInfo |
| app/actions/social/generate-social-post.ts | stampPostBrandCompliance |
| app/actions/partner-orders.ts | updateTitleOrderStatus |
| app/actions/onboarding/training.ts | recordVideoProgress |
| app/actions/marketing-studio.ts | generateCampaignContent, updateCampaign |
| app/actions/listing-lifecycle.ts | getListingTasks, sendReviewRequest |
| app/actions/learning-modules.ts | updateLearningModuleAction |
| app/actions/credit-copilot.ts | referToCreditPartner, updateContactCreditStatus |
| app/actions/communications.ts | getRecentCommunications |
| app/actions/brand-template-registry.ts | batchClassifyTemplatesAction, batchGetBrandRequirementsAction |
| app/actions/analytics.ts | aggregateValueDelivered, trackLeadValueJourney |

## Findings log

(appended incrementally as work proceeds)

### 1. `app/actions/credit-copilot.ts` — `referToCreditPartner`, `updateContactCreditStatus` — WIRED

Not duplicates. Both were already hardened in wave 4 (tenant predicate on the write,
`error` destructured, both ends of the referral verified) but had **no surface at all**,
so the entire consumer-credit posture lane was reachable only as a raw HTTP endpoint.
Verified the earlier note: `getCreditPipelineStats` does carry the `referrals` reader —
**not undone**.

Third defect found: `getCreditPipelineStats` returned `referrals`, but
`app/credit-pipeline/page.tsx`'s local `PipelineStats` interface omitted the field and
nothing rendered it. `credit_partner_referrals` was therefore still effectively
write-only from the user's point of view.

Changes, all in `app/credit-pipeline/page.tsx` (the only live surface —
`app/dashboard/credit-pipeline/page.tsx` is an 11-line redirect to it):
- `PipelineStats` now declares `referrals`; a "Credit partner referrals" card renders
  the list with partner name, referral date, status and a link to the contact.
  Empty state says so explicitly rather than rendering nothing.
- New `ManageCreditAccountDialog`, opened from a per-card "Credit status / refer"
  button, calls **`updateContactCreditStatus`** and **`referToCreditPartner`**.
- Vocabulary verified against the LIVE DB before writing it: `contacts` has exactly one
  relevant CHECK — `contacts_lender_status_check` = `cash | pre_approved |
  needs_pre_approval | unknown` (or NULL). `credit_status`, `credit_score_band`,
  `credit_pipeline_stage` have **no** CHECK, and 4 live rows are all NULL, so no live
  vocabulary exists. The dialog offers closed sets matching what the flow automation in
  credit-copilot.ts already writes (`credit_status:"good"`,
  `credit_pipeline_stage:"in_program"|"target_score_reached"`) so free text cannot fork.
- Partner picker reuses the existing `app/actions/referrals/referral-actions.ts:listPartnersWithReferrals`
  rather than minting a new `"use server"` endpoint.
- The card is a dnd drag handle, so the new button `stopPropagation`s on pointerdown.

No tenant id crosses the wire: the client sends only `contact_id` / `partner_id`; the
server resolves the brokerage from the session.

### 2. `app/actions/partner-orders.ts` — `updateTitleOrderStatus` — WIRED + 2 defects fixed

Not a duplicate. It belongs to `/title/orders`, which had no way to advance an order at all.

**Defect A (severe, user-visible).** `app/title/orders/page.tsx` is titled "Title Orders",
and `/title/orders/new` creates a `title_orders` row via `createTitleOrder` then
`router.push('/title/orders')` — but the page listed **`transactions`**, not
`title_orders`. Every order a title partner created reported success and then vanished;
`revalidatePath('/title/orders')` inside the writer refreshed a list that structurally
could never contain it. The `transactions` read also had **no tenant predicate**.
Rewritten to list `title_orders` scoped `.eq('brokerage_id', ctx.brokerageId)` (RLS
`title_orders_select` = `is_platform_admin() OR has_brokerage_access(brokerage_id)`,
verified live) with `error` destructured, so a refused read renders as a refusal instead
of "no title orders" — a false all-clear on a page that tells a closing team whether
title is clear.

**Defect B (lesson 9).** `updateTitleOrderStatus` and `updateLenderApplicationStatus`
both ran an UPDATE with no `.select()` and returned `{success:true}` whenever `error`
was null. An id from another brokerage matched zero rows and still reported success —
"title marked clear" with nothing written. Both now `.select("id")` and return
`order_not_found_in_brokerage` / `application_not_found_in_brokerage` on a zero-row
result. Added an empty-`orderId` guard.

New file `app/title/orders/title-order-row.tsx` (client) calls **`updateTitleOrderStatus`**:
status picker mirroring `title_orders_status_check` exactly (verified live:
pending|ordered|in_progress|clear|issue|exception|completed|cancelled) plus findings.
Findings are sent as `undefined` when unchanged, so re-stamping a status never blanks a
search result already on file.

### 3. `app/actions/superadmin/platform-controls.ts` — `getPlatformControlsAction` — WIRED

Not a duplicate to delete: `lib/platform/platform-controls.ts:getPlatformControls` is a
server library function, and the superadmin page called it once at render. The action is
the **only superadmin-gated door a client may use**, so the god-switch panel had no way
to re-read the true state.

Consequence found: `app/dashboard/superadmin/platform/platform-controls-panel.tsx` showed
its render-time snapshot plus its own optimistic edits forever. A second operator hitting
emergency mode left this panel reading "AI engine: on" while every tenant's autonomy was
frozen — the most consequential stale reading on the platform. On a failed
`setPlatformControlsAction` it also restored `prev`, this browser's possibly-stale belief.

Wired: `resync()` calls **`getPlatformControlsAction`** on mount, on window focus, from a
refresh button, and in place of the `prev` rollback after a rejected flip. An "As of
HH:MM:SS" stamp makes staleness visible.

### 4. `app/actions/vendor-budget.ts` — `getPlatformVendorBudget` — WIRED + 1 defect fixed

Not a duplicate. `/dashboard/support` listed per-brokerage totals via
`getPlatformVendorSpendOverview` but had no drill-down, so `getVendorSpendBreakdown`
(per-VENDOR figures) was computed by nothing and staff triaging a brokerage at 98% of its
ceiling could not see which vendor was burning it.

**Defect (lesson 5).** `getPlatformVendorSpendOverview` destructured only `{ data }` on
both service reads. A refused read resolved to empty, and the console renders empty as
"All brokerages within budget" — a false all-clear on the platform's spend-control page.
Both reads now destructure `error` and the action fails closed.

Wired: new client `app/dashboard/support/vendor-breakdown-row.tsx` makes each row
expandable and calls **`getPlatformVendorBudget(brokerageId)`** on expand. The privacy
contract is unchanged — the gate stays in the action (`isPlatformStaff`), and the
component renders vendor names only from a `scope === "platform"` view.

### 5. `app/actions/analytics.ts` — `aggregateValueDelivered`, `trackLeadValueJourney` — WIRED + 5 defects fixed

Both are the SOLE writers behind live readers, so the whole value-analytics surface was
structurally guaranteed to show zeros. Verified the earlier note first: the two
unauthenticated upserts and the cross-tenant aggregation ARE still fixed — **not undone**.

**Defect A (fatal, lesson 4).** `aggregateValueDelivered` upserted eight columns that do
not exist on `value_delivered_daily`. Live columns (verified, project
`hrvaqgvukzxfskkcrwbt`) are exactly: id, agent_id, brokerage_id, date,
`total_value_delivered_dollars`, `recipients_count`, `cost_to_deliver`,
`value_breakdown` (jsonb), created_at, updated_at. `free_tools_used_count`,
`guides_downloaded_count`, `questions_answered_count`, `personalized_reports_sent`,
`free_tools_value`, `guides_value`, `help_value`, `reports_value` — **none exist**. The
write therefore failed with a column error on every call. The breakdown now goes into
`value_breakdown`, which is what that column is for.

**Defect B.** `loadValueDrivenDashboard` and `calculateTrustCapital` read those same
non-existent columns off the row (`m.free_tools_used_count`), so tools/guides totals were
always 0 even had rows existed. New `breakdownCount()` helper unpacks `value_breakdown`.

**Defect C.** `trackLeadValueJourney` wrote `touchpoints_count: 0` as a hardcoded fact
onto a table the /analytics journeys panel renders. `activities` does carry
`contact_id` + `brokerage_id` (verified), so the real count is now taken with
`count:"exact", head:true`, and a failed count fails closed rather than writing 0 as truth.

**Defect D (lesson 5).** The `lead_value_journey` upsert discarded its own `error`, so a
rejected write returned the same `null` as "contact not visible". Now destructured.

**Defect E (UI).** `/analytics` rendered `journey.contacts?.name` — `getLeadValueJourneys`
selects `first_name`/`last_name` and `contacts` has no `name` column, so every row showed
"Unknown". The CSV export read `j.touchpoint_count ?? j.total_touchpoints`; the live
column is `touchpoints_count`, so that CSV field was always blank. Both fixed.

Wired in `app/analytics/page.tsx`:
- `loadData()` now calls **`aggregateValueDelivered(agentId, new Date())`** before reading
  the dashboard (idempotent — UNIQUE (agent_id, date) + onConflict; failure is logged and
  surfaced, never fatal to the page).
- A "Rebuild journeys" button on the Lead Value Journeys card calls
  **`trackLeadValueJourney`** for the agent's own contacts (bounded to 100, batches of 5)
  then re-reads.

**Deliberately NOT faked:** `trackLeadValueJourney`'s `tools_used` / `guides_downloaded`
stay empty. `tool_usage_sessions` keys on `visitor_id` (text) and `document_downloads` on
`user_id`/`partner_id` — verified live, **neither carries a `contact_id`**, so per-contact
tool/guide attribution cannot be derived from what the database records. Finishing this
needs a `contact_id` on those two ledgers; the code says so at the site.

**Not done (needs a decision):** the daily aggregate really wants a nightly backfill over
all agents, but `aggregateValueDelivered` gates on `resolveWriteContext()` and an
unattended caller must get its OWN door onto the underlying computation (lesson 1) rather
than a fake identity. That refactor (extract the day computation into a lib function taking
an explicit agentId+brokerageId, call it from both the action and a cron) is recorded here
rather than half-built.

### 6. `app/actions/communications.ts` — `getRecentCommunications` — WIRED

Not a duplicate. Already gated + brokerage-scoped + limit-clamped by an earlier wave, but
with no surface: the CRM Communications tab showed conversation THREADS and the activity
feed, never the actual SMS/email bodies exchanged with the contact.

New client `app/crm/components/recent-messages-card.tsx` renders the history through the
server action (not a browser query, so the session gate, brokerage predicate and limit
clamp stay on the server), mounted in the `comms` tab of `app/crm/page.tsx`. A refused
read renders as a refusal, never as "no messages" — telling an agent nobody had ever been
contacted is the failure mode that matters here.

### 7. `app/actions/portal-messages.ts` — `getPortalMessages` — DUPLICATE RESOLVED (survivor kept, loser's caller re-pointed)

`app/api/portal/messages/[contactId]/route.ts` GET was a second implementation of the same
capability, and it is the one with the live caller (the SWR poller in
`app/portal/[contactId]/messages/messages-client.tsx`). Read both.

**Survivor: `app/actions/portal-messages.ts:getPortalMessages`** — it uses the shared
`lib/portal/require-contact-access.ts:requireContactAccess`, whose own header says it
exists so portal actions AND portal API routes cannot diverge. The route's inline copy had
diverged in **both** directions, and each divergence is a real defect:
- it recognised a contact only by **email match**, missing `contacts.contact_user_id`, so a
  portal client linked by user id with a different login email was refused their own thread;
- it admitted only `admin|broker|superadmin` as staff, so `agent`/`team_lead`/`tc` in the
  same brokerage were refused, while the shared gate admits them.

Nothing was ported the other way — the route had no capability the action lacked. The route
now delegates to the action and maps `Unauthorized`→401, `Forbidden`→403,
`Contact not found`→404, `Access check failed`→500 (a refused read must not read as a clean
404). The client's endpoint URL is unchanged.

### 8. `app/actions/campaign-sequences.ts` — `getSequenceSteps`, `cancelEnrollment` — WIRED + 4 defects fixed

**`getSequenceSteps` — DUPLICATE RESOLVED (survivor = this function).**
`app/dashboard/campaigns/sequences/[id]/builder/page.tsx` carried its OWN inline
row→builder-step mapping over `getCampaignSequence`'s raw steps, carrying only the nine
common fields. `saveSequenceSteps` writes **every field the step palette declares**
(`ad_platform`, `ad_budget_cents`, `gift_occasion`, `esign_recipient`, `tour_property_ids`,
`video_script`, `task_title`, `avm_*`, `document_*`, `qr_*`, …). So a broker who configured
any of those, reopened the builder and pressed Save had every one of them **written back as
null** — silent data loss on the campaign engine. The inline mapping also coerced an
unrecognised `channel` to `"email"`, which the next save then persisted.

The survivor had its own bug: its `select()` named only the nine common columns while its
mapper read `row.ad_platform`, `row.video_script`, `row.output_variable_name` … so those all
came back `undefined`→null. It now projects the same `PALETTE_STEP_FIELDS` allow-list
`saveSequenceSteps` writes with, making it the exact inverse, and preserves `null` rather
than substituting defaults (a false default would be written back as fact on the next save).
The builder page now calls it, and **refuses to open** (with the reason) if the steps cannot
be read, because the builder saves the whole step set.

**`cancelEnrollment` — WIRED.** Already gated + tenant-checked + `.select("id")`-proven by
an earlier wave, but there was no per-enrollment list anywhere, so an automated outbound
programme could be started against a contact and never stopped from the product. Added an
"Active Enrollments" section to the analytics tab of
`app/dashboard/campaigns/sequences/[id]/SequenceBuilderClient.tsx` with a Cancel button
(broker/admin only, matching the page's existing `canEdit`).

**Blocking defect found while wiring it (lesson 8 + lesson 1), fixed:**
`enrollContactInSequence` — the only writer of `sequence_enrollments` — omitted
`brokerage_id` and passed `contact_id: null` on the lead path. Live schema:
`sequence_enrollments.brokerage_id` is **NOT NULL, no default** and `contact_id` is **NOT
NULL**. So *no enrollment has ever succeeded through the product*, the enrollment lists were
empty by construction, and `cancelEnrollment` had nothing to act on. It also had **no gate
at all** — a public endpoint that could start an outbound programme against any contact id
in any tenant.

`lib/kernel/ai-isa.ts` calls it from an unattended path (`recordAiIsaOutcome`, explicit ctx,
no session) inside a bare `catch {}`, so the AI ISA reported "not ready now → enrolled in
long-term nurture" while enrolling nobody. Adding a session gate alone would have broken
that caller. Instead:
- new `lib/campaigns/enroll-in-sequence.ts:enrollInSequence` takes `brokerageId` explicitly,
  verifies the sequence AND contact are in that tenant, resolves `leads.contact_id` for the
  lead path (refusing with a reason when a lead has no contact row), and stamps
  `brokerage_id` + `enrolled_by`;
- `enrollContactInSequence` now gates on `getAgentContext()` and delegates;
- `lib/kernel/ai-isa.ts` calls the library directly with its own `ctx.brokerageId` — its own
  door, never a fake identity — and now logs the failure instead of swallowing it.

### 9. `app/actions/buyer-offers.ts` — `getBuyerOffers` — DUPLICATE RESOLVED (survivor = this) + access defect fixed

`app/crm/contacts/[contactId]/offers/page.tsx` loaded offers with its OWN inline
service-client query — a second copy of the query AND of the tenant rule for the single
most commercially damaging read in the product (offer_price, earnest_money,
contingencies, financing_type, buyer_notes: a competing bidder who learns these wins the
house).

**Survivor: `app/actions/buyer-offers.ts:getBuyerOffers`** — it resolves the tenant from
the CONTACT ROW via `requireContactAccess`, which is the invariant this lane was hardened
around. MERGED FIRST: the page's projection included `listing_id` and the action's did not,
so `listing_id` was ported onto the survivor before the page was re-pointed. Nothing the
page renders was lost.

**Access defect fixed (lesson 7).** The page computed
`const isOwner = contact.agent_id === user.id` — `contacts.agent_id` is an **agents.id**
and `user.id` is a **users.id**, disjoint spaces, so `isOwner` was *always false*: a
buyer's own agent was redirected off their own buyer's offers page unless they also
happened to be broker/admin. Now resolved with `resolveAgentId(supabase, user.id)` first.

### 10. `app/actions/buyer-move.ts` — `getBuyerMoveCaseAction` — WIRED

Not a duplicate: `app/dashboard/transactions/[id]/page.tsx` seeds the section from the
library `getBuyerMoveCase`, but only the ACTION recomputes the live `decideBuyerMode`
recommendation and the Utility-Connect flag.

Defect it fixes: `buyer-move-section.tsx` drove its "hand this to the concierge partner"
banner off the STORED `moveCase.recommended_mode`, which is only recomputed when someone
toggles a checklist task. `decideBuyerMode` also weighs `daysToClose` — which changes every
day with no user action — so a deal drifting into "essential utilities still unset, closing
in ≤5 days" never raised the banner unless the agent happened to tick something off. The
section now refreshes through **`getBuyerMoveCaseAction`** on load and prefers the live
recommendation, falling back to the stored column.

### 11. `app/actions/seller-coaching.ts` — `dismissCoachingCard` — WIRED

Not a duplicate. The action records the `coaching.dismissed` activity — the only signal of
"the agent did not want this AI coaching" — and had no caller, while the card's own collapse
control was purely local state. `app/components/dashboard/listings/lifecycle/seller-coaching-card.tsx`
now calls **`dismissCoachingCard(listingId)`** from the collapse control: fire-and-forget
(the UI must never wait on an analytics write) and at most once per mount so
collapse/expand cycling cannot inflate the signal. Verified live that every column the
action inserts exists on `activities` (`entity_type` NOT NULL and supplied, `entity_id`,
`agent_user_id`, `metadata`, and the NOT NULL `brokerage_id`).
