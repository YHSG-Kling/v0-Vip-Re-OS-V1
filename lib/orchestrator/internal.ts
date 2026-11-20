/**
 * Internal orchestrator dispatch — NOT a Next.js server action.
 *
 * Moved out of app/actions/orchestrator.ts so these functions are NOT
 * registered as client-callable RPC endpoints. They run server-side only.
 *
 *   - emitEventFromCron / orchestrateEvent: invoked by cron routes + the
 *     authenticated emitEvent() server action. Trusted-context only.
 *   - handleX / EVENT_HANDLERS / markEventProcessed / logProcessingResults:
 *     internal dispatch + handler implementations.
 *
 * Auth gating happens at the entry points in app/actions/orchestrator.ts.
 */

import { sentinelWrite } from "@/lib/kernel/write-sentinel"
import { registerEventDispatcher } from "@/lib/events"
import type { Event, EventInput } from "@/lib/orchestrator/event-types"
import { EVENT_TYPES } from "@/lib/orchestrator/event-types" // the module, not the barrel (proxy-graph budget)
import { KernelEvent } from "@/lib/kernel/events"

// THE SERVICE CLIENT, NOT THE COOKIE ONE (lane 86F). This module is dispatched
// from emitEventFromCron (poll-did-videos, render-composition, the image
// generators), from logEventAndTrigger's registered dispatcher (webhooks) and
// from emitEvent under whoever's session emitted — a client in the portal, an
// agent, or nobody. `createServerClient()` read NOTHING on the unattended paths
// (and only the emitter's own rows on the others), so the suggestion cards, the
// processed stamp and event_processing_log were never written from a cron. Every
// read and write below is now on the service client and pinned to the EVENT
// ROW's brokerage_id — a lifecycle_events row this system wrote with a verified
// tenant (emitEvent: the session's; emitEventFromCron: its caller's).
import { createServiceClient } from "@/lib/supabase/service"
import { writeSmartSuggestion, type SuggestionPriority } from "@/lib/assistant/smart-suggestion"
// (wave 155, lane 155B2) sendNotificationToAgent is no longer imported: its two callers here — the hot-lead alert and the
// copilot's overdue bell — are retired onto the AI ISA loop and raiseMilestoneOverdue's one notification.
// (wave 155, lane 155R24) listingLiveTasks / offerReceivedTasks / closingApproachingTasks, reactToCreditPartnerStatus /
// reactToCreditTargetReached, reactToVideoPublished / reactToVideoHighEngagement and writeSevenDayNurturePlan are no longer
// imported: their eight dotted events are retired onto the kernel-bus survivors named in the WAVE 155 (155R24) block below.
import {
  appointmentBookedTasks,
  agreementSignedTasks,
  contingencyClearedTasks,
  scheduleClosingGiftForListing,
} from "@/lib/listing-lifecycle/lifecycle-event-tasks"
import {
  reactToJourneyTaskCompleted,
  reactToJourneyStageCompleted,
  reactToJourneyAllTasksDone,
} from "@/lib/portal/journey-event-handlers"
import { reactToOnboardingStalled } from "@/lib/onboarding/stalled-onboarding-reaction"
import { reactToAgentDelegatedToAi } from "@/lib/portal-stream/ai-delegation-reaction"
import {
  reactToVideoReady,
  reactToVideoScriptApproved,
} from "@/lib/video/video-event-reactions"
import { getChainsByTrigger } from "@/lib/workflow-orchestrator/chains"
import { startRun as engineStartRun } from "@/lib/workflow-orchestrator/engine"
// ONE "finished reel in an email" block — shared with the pre-listing section
// drip (lib/listing-presentation/section-drip.ts) so the campaign-asset embed
// and the chapter-reel email cannot drift into two different-looking emails for
// the same product. Moved to lib/video/video-thumbnail-embed.ts; this module is
// far too heavy for the drip cron to import.
import { videoThumbnailEmbed } from "@/lib/video/video-thumbnail-embed"
import { isSellerAuthored } from "@/lib/video/memory-video-gate"

interface ProcessingResult {
  success: boolean
  handler: string
  error?: string
  processing_time_ms: number
  skipped?: boolean
}

// =====================================================
// EVENT HANDLER REGISTRY — CONSULTED BY orchestrateEvent().
// =====================================================
// WHAT CHANGED, AND WHY IT WAS CHANGED. This map used to say of itself "⚠️ NOT
// CURRENTLY DISPATCHED": it existed only so that 24 handler modules would not read as
// orphans, and its own header named the two exits — "either add cases to the switch or
// make orchestrateEvent consult this map". A comment holding a wire open is exactly the
// shape the orphan doctrine forbids, so BOTH exits were taken at once: the switch below
// now has a `case` for every event type this map can actually service, and each of those
// cases dispatches THROUGH the map (dispatchRegistered). The map is a wiring again, not a
// reference — and the switch stays the place the routed set is declared, which is what
// scripts/event-dispatch-invariant-guard.ts reads to know which types must be emitted
// with the DISPATCHING emitter.
//
// THE PREMISE THAT TURNED OUT TO BE FALSE. This was expected to need a vocabulary
// reconciliation first — dotted keys here vs an "underscore EVENT_TYPES" in the switch.
// There is no such drift: EVENT_TYPES is dotted too (lib/events/types.ts:29 —
// `LISTING_SIGNED: "listing.signed"`). Only the CONSTANT NAMES are SCREAMING_SNAKE; the
// values are byte-identical to these keys. 21 of the 24 keys below are exactly an
// EVENT_TYPES value. Nothing was renamed and no migration was needed.
//
// THE VALUE SHAPE IS AN INVOKER, NOT A FUNCTION REFERENCE. Each entry used to resolve to
// the handler itself, which quietly assumed every handler takes one `payload`. Two do
// not, and dispatching them that way would have failed silently:
//   · scheduleClosingGiftForListing(svc, brokerageId, listingId) — lib/listing-lifecycle/
//     lifecycle-event-tasks.ts (lane 86F; was lib/application scheduleClosingGift) —
//     takes a LISTING ID, not a payload object. Handed the payload it would have queried
//     `.eq("id", {…})` and matched nothing, which supabase-js reports as success (§3).
//   · generateAssistantSuggestions(agentId, { page, entity_id, entity_type }) —
//     app/actions/assistant.ts:307 takes TWO arguments including a UI page context.
// Each entry now adapts its own handler, so a signature change breaks the build here
// instead of dropping an orchestration at runtime.
//
// WHAT IS RECORDED BUT NOT DISPATCHED, AND WHY (a key with no `case` below never fires):
//   · The 8 keys the switch already services with a LOCAL handler — lead.created,
//     lead.tagged_hot, listing.appointment_set, listing.signed, listing.live,
//     transaction.milestone_overdue, credit.status_updated, video.generated. For these the
//     local handler in this file IS the wiring in force, and the mapped module is a SECOND,
//     different implementation of the same event (e.g. this file's handleListingLive mints
//     the tracked QR; lifecycle-event-tasks' listingLiveTasks does not). Running both would
//     double-fire. Consolidating the two implementations is a separate piece of work in
//     lib/listing-lifecycle/lifecycle-event-tasks.ts + lib/video/video-event-reactions.ts, not something this
//     dispatch can decide.
//   · lead.engaged → generateAssistantSuggestions. No `page` value can be derived from a
//     lead.engaged payload without inventing one, and nothing in the repo emits
//     lead.engaged, so a guess would buy nothing and could mis-route. Refused explicitly
//     below rather than guessed.
//   · RETIRED (lane 86F): journey.task_completed / journey.stage_completed /
//     journey.all_tasks_done used to sit here as "no EVENT_TYPES member, not emitted".
//     completeTask (app/actions/journey-tasks.ts) DID emit journey.task_completed — just
//     without processImmediately, and onto a switch with no case. The members now exist
//     (EVENT_TYPES.JOURNEY_*), completeTask processes immediately, and the three types are
//     routed below. stage_completed / all_tasks_done gained their emitter in lane 86F2:
//     lib/portal/journey-milestone-events.ts decides, after each recorded completion, whether
//     it finished its stage / the journey (pure rule: journey-utils detectJourneyMilestones).
//
// ─── WAVE 155 (lane 155B2) — ONE OWNER PER EVENT for the handlers nothing fired (wave 154 gap rows 10, 12–15) ─────
// Evidence per event: the dotted name has NO emitter (stripped-source census, migrations included; live lifecycle_events
// holds zero rows of any of them); the same real-world moment is emitted TODAY under its KernelEvent spelling by the stage
// writer and reaches lib/kernel/event-reactor.ts / event-fanout.ts / notification-engine.ts. Decision per event:
//   · listing.signed      → MERGED onto KernelEvent.LISTING_AGREEMENT_SIGNED (execution-engine.ts emits it twice: via
//                           transitionLifecycle and a direct processKernelEvent). The seller-portal card for that event
//                           already promises "Photography + marketing prep begins" — the procurement + go-live checklist
//                           that promise needs lived ONLY here, unfired. Survivor: reactToListingAgreementSigned (below),
//                           called from event-reactor.ts branch "21d", once per listing (ledger key).
//   · listing.price_reduction → RETIRED: the Reduce Price sheet already runs the same core directly through
//                           app/actions/listing-lifecycle.ts handlePriceReduction (after updateListing writes the price).
//   · transaction.closed  → RETIRED: its core (scheduleReviewRequests) is writer #3 of the five review_requests writers
//                           lib/reputation/review-ask.ts consolidated — wiring it would re-create three platform asks per
//                           client and make the autonomous review sender skip them. Survivor: lib/reputation/review-ask.ts.
//   · credit.partner_referred → RETIRED: the one door is app/actions/credit-copilot.ts referToCreditPartner, which already
//                           calls the same body (recordCreditPartnerReferral); an event too would double-write the referral.
//   · lead.tagged_hot / lead.engaged → RETIRED (both spellings; KernelEvent.LEAD_TAGGED_HOT too): no emitter, and an agent
//                           "hot lead" alert on an unqualified lead contradicts CLAUDE.md §5 (leads are the brokerage's). The
//                           hot-lead path in force is LEAD_SCORED → AI ISA (event-reactor.ts branch 27) → the ISA handoff.
//   · OWNER-HELD, unchanged (the SAFE default is what fires today; see lane 155B2 notes, "Owner decisions"):
//     lead.created (7-day task plan vs the CONTACT_CREATED sequence enrollment already in force), listing.live (manual
//     marketing tasks vs the automated promo video / mail / ads / social drafts LISTING_PUBLISHED already runs),
//     listing.offer_received (a task beside the OFFER_RECEIVED notification), transaction.contingency_cleared /
//     close_approaching (closing-orchestration already raises the walkthrough / CD signals), transaction.closing_soon (a
//     closing GIFT is spend), credit.target_reached, video.published / video.high_engagement (no writer marks the moment).
//
// ─── WAVE 155 (lane 155R24) — THE TEN CONSUMERS NOTHING EMITS, DECIDED ONE BY ONE (arbitration G02; CLAUDE.md §1) ─────
// Reachability, per dotted name (fixed-string sweep of app/ lib/ supabase/ vercel.json, not a regex — `.` had matched the
// underscore kernel spellings): NO emitter in code, no SQL trigger or function, no cron route, no `${baseUrl}/api/…` self-call;
// the only occurrences are this file, lib/events/types.ts and comments. Eight are the SAME MOMENT the kernel bus already reacts
// to, so these consumers were DUPLICATES (case 1) and are retired here, each tombstone naming its survivor:
//   · listing.offer_received → the arrival: lib/inbound-mail/offer-intake.ts:604 afterInboundOfferRead (the listing agent's
//     high-priority notice, :666, with price, terms and "Review it, then present it to your seller"); the release:
//     app/actions/offers/present-to-seller.ts:265 KernelEvent.OFFER_RECEIVED (staff bell lib/kernel/notification-engine.ts:524).
//     The retired body was one "Review offer" task — the same instruction on a second surface (owner question in the notes).
//   · listing.live → KernelEvent.LISTING_PUBLISHED (lib/listings/mls-live-verification.ts:265 on a verified MLS go-live;
//     lib/kernel/event-reactor.ts:598 et seq. — promo video, mail, ads, social drafts); the listing QR: app/actions/
//     listings-kernel.ts:707 launchListing → mintTrackedQr (the SAME `listing:<id>` key this file's handleListingLive used).
//   · lead.created → KernelEvent.CONTACT_CREATED (lib/kernel/event-reactor.ts:402 sequence enrollment; bell
//     notification-engine.ts:523). Leads are the brokerage's (§5): a "reach out in 24 h" card to whoever emitted was the wrong
//     owner. writeSevenDayNurturePlan stays — app/actions/copilot.ts calls it on an agent's request.
//   · credit.status_updated / credit.target_reached → app/actions/credit-copilot.ts:399 triggerCreditFlowActions (the approved
//     stage's kickoff task :500; the funded stage's target_score_reached + celebration task :542). The retired bodies keyed on
//     credit_status 'approved' / 'target_reached' — values the one credit_status writer never stores (needs_work | in_program |
//     good, app/credit-pipeline/page.tsx:46) — and logCreditStatusUpdated writes the UNDERSCORE spelling this switch never saw.
//   · transaction.close_approaching → lib/transactions/closing-orchestration.ts:265 (walkthrough unscheduled) and :283 (wire
//     instructions missing), and lib/kernel/calendar-deadline-watcher.ts:40 KernelEvent.CD_DUE (bell notification-engine.ts:531)
//     — the three task titles the retired body seeded, already raised on the real deadline.
//   · video.published → lib/geo/publish-video-landing.ts:164 publishVideoProjectLanding (the ONE fenced is_published stamp of
//     ai_video_projects) and KernelEvent.SOCIAL_POST_PUBLISHED (event-reactor.ts:3760) for the social channels.
//   · video.high_engagement → KernelEvent.VIDEO_HIGH_PERFORMER_DETECTED (app/api/video/engagement/route.ts thresholds;
//     event-reactor.ts:1015 → Campaign Orchestrator). The retired "respond to comments" task keyed on a comment count no
//     producer records.
// Two have NO producer and NO survivor (case 3) — nothing is invented; they stay DORMANT (nothing runs) pending the owner:
//   · transaction.contingency_cleared — no writer of transactions.*_contingency_removed_at, no trigger, no catalog milestone.
//   · transaction.closing_soon — a closing GIFT (closing_gifts, price_cents) is spend; the hard rule forbids starting one unruled.
//
// ─── ASKED AND ANSWERED: the six copilot/assistant "handlers" do NOT belong here ─────
// app/actions/copilot.ts (handleSuggestionAccepted, handleCoachingSessionBooked,
// handleMorningKickoff) and app/actions/assistant.ts (handleAssistantQuery,
// handleTaskDelegated, handleAutomationTriggered) were repeatedly proposed for this map.
// They are still not being added, and no internal-caller seam is being built for them.
// One of the two reasons has changed and the other has not:
//   · "This map is not consulted" is NO LONGER TRUE — it is now the dispatch path for the
//     cases below. That reason is retired. (Note that app/actions/copilot.ts:24,
//     app/actions/assistant.ts:24 and app/actions/social-publishing.ts:54 still state it;
//     those files belong to other owners and their notes want the same correction.)
//   · There is still no event, and that alone is decisive. `lib/events/types.ts:29-54` is
//     the whole EVENT_TYPES vocabulary and it has no member for any of the six; the
//     nearest, `AI_SUGGESTION_ACTIONED`, is emitted by nothing in the repo. Registering a
//     handler for an event that is never written cannot make it fire.
//   · The credential blocker people kept naming — `emitEventFromCron` carries a SERVICE
//     credential and no session, so session-gated handlers refused every unattended
//     dispatch — is CLOSED (lane 86F, owner ruling "build and fix"; the four video
//     handlers in 86F3). Every registry entry now reaches a server-only core on the
//     service client with the EVENT row's tenant, and this file's own local handlers,
//     markEventProcessed and logProcessingResults moved off createServerClient() with
//     them (scripts/sessionless-use-server-census.ts pins the cores in its HUB section).
// Their real dispositions (user actions, telemetry, one duplicate of the daily-briefing
// cron) are recorded per-function in those two files.
// =====================================================

/** One dispatch contract for every registered handler, whatever its own signature is. */
type EventHandlerInvoker = (event: Event) => Promise<unknown>

// TOMBSTONE (wave 155, lane 155B2): `assistantSuggestionsNotWired` — the throwing invoker for lead.tagged_hot / lead.engaged —
// lived here. Both keys are retired (see the WAVE 155 block above); SURVIVOR for a hot / engaged lead: LEAD_SCORED → AI ISA
// (lib/kernel/event-reactor.ts branch 27) and the ISA handoff.

/**
 * A reaction's `{ success: false, error }` is a FAILURE of the dispatch, not a
 * quiet return — dispatchRegistered records a throw into event_processing_log,
 * which is where a repeated failure becomes a manager signal.
 */
async function mustSucceed<T extends { success: boolean; error?: string }>(label: string, p: Promise<T>): Promise<T> {
  const r = await p
  if (r.success) return r
  throw new Error(`${label} refused: ${r.error ?? "no reason given"}`)
}

// EVERY INVOKER HANDS ITS CORE THE SERVICE CLIENT AND THE EVENT ROW'S TENANT
// (lane 86F). The eight lead/listing/transaction/credit/journey entries used to
// dynamic-import "use server" wrappers on the COOKIE client — app/actions/
// copilot.ts, listing-lifecycle.ts, credit-copilot.ts, journey-tasks.ts — that
// read nothing from a cron or webhook dispatch. Their bodies now live in
// server-only cores (template lib/transactions/dotloop-document-sync.ts) and the
// wrappers are deleted with tombstones naming these survivors. The four video
// entries followed in lane 86F3 (lib/video/video-event-reactions.ts).
const EVENT_HANDLERS: Record<string, EventHandlerInvoker> = {
  // Lead events
  // TOMBSTONE (wave 155, lane 155R24): "lead.created" → writeSevenDayNurturePlan lived here (never dispatched: the switch routed the
  // type to a local handler, and nothing emits it). SURVIVOR: KernelEvent.CONTACT_CREATED, lib/kernel/event-reactor.ts:402.
  // TOMBSTONE (wave 155, lane 155B2): "lead.tagged_hot" and "lead.engaged" (both → assistantSuggestionsNotWired) lived here.
  // SURVIVOR: LEAD_SCORED → AI ISA, lib/kernel/event-reactor.ts branch 27 (see the WAVE 155 block in the header).

  // Listing events
  "listing.appointment_set": async (e) => mustSucceed("appointment tasks", appointmentBookedTasks(createServiceClient(), e.brokerage_id, e.payload ?? {})),
  // TOMBSTONE (wave 155, lane 155B2): "listing.signed" → agreementSignedTasks lived here. SURVIVOR: reactToListingAgreementSigned
  // (this file), run by lib/kernel/event-reactor.ts branch "21d" on KernelEvent.LISTING_AGREEMENT_SIGNED — the go-live checklist,
  // the photography procurement and the agent's card, once per listing.
  // TOMBSTONE (wave 155, lane 155R24): "listing.live" → listingLiveTasks lived here (never dispatched: the switch routed the type to
  // a local handler, and nothing emits it). SURVIVOR: KernelEvent.LISTING_PUBLISHED, lib/kernel/event-reactor.ts:598.
  // TOMBSTONE (wave 155, lane 155B2): "listing.price_reduction" → priceReductionTasks lived here. SURVIVOR: app/actions/
  // listing-lifecycle.ts handlePriceReduction, called by the Reduce Price sheet right after updateListing writes the price.
  // TOMBSTONE (wave 155, lane 155R24): "listing.offer_received" → offerReceivedTasks (one "Review offer" task) lived here; nothing
  // emits the dotted name. SURVIVORS: lib/inbound-mail/offer-intake.ts:604 afterInboundOfferRead (the arrival, the listing agent's
  // notice) and app/actions/offers/present-to-seller.ts:265 KernelEvent.OFFER_RECEIVED (the release, the staff bell).

  // Transaction events
  // TOMBSTONE (wave 154, lane 154A3 — CLAUDE.md §6, coverage-ledger gap row 11): `"transaction.milestone_overdue":
  // assistantSuggestionsNotWired` stood here — a key NOTHING wrote, whose handler only threw. The overdue milestone has ONE
  // spelling, KernelEvent.MILESTONE_OVERDUE ('milestone_overdue'), which lib/events/event-helpers.ts logMilestoneOverdue (called
  // by app/actions/copilot.ts) actually writes. SURVIVOR: the `case KernelEvent.MILESTONE_OVERDUE:` in orchestrateEvent below →
  // handleMilestoneOverdue (the urgent suggestion + the agent notification), which the dotted case label never let it reach.
  // OWNER-HELD, DORMANT (wave 155, lane 155R24 — case 3): no producer of the moment exists; kept, unrun, pending the owner.
  "transaction.contingency_cleared": async (e) => mustSucceed("contingency task", contingencyClearedTasks(createServiceClient(), e.brokerage_id, e.payload ?? {})),
  // TOMBSTONE (wave 155, lane 155R24): "transaction.close_approaching" → closingApproachingTasks (walkthrough / closing disclosure /
  // wire-instruction tasks) lived here; nothing emits it. SURVIVORS: lib/transactions/closing-orchestration.ts:265 and :283, and
  // KernelEvent.CD_DUE from lib/kernel/calendar-deadline-watcher.ts:40.
  // OWNER-HELD, DORMANT (wave 155, lane 155R24 — case 3: a closing gift is spend). The closing gift takes a listings.id, not a payload — see the header.
  "transaction.closing_soon": async (e) =>
    mustSucceed("closing gift", scheduleClosingGiftForListing(createServiceClient(), e.brokerage_id, (e.payload as Record<string, any>)?.listing_id ?? null)),
  // TOMBSTONE (wave 155, lane 155B2): "transaction.closed" → scheduleReviewRequests (three `scheduled` review_requests rows per
  // client) lived here. SURVIVOR: lib/reputation/review-ask.ts — the ONE path from a verified closing to a sent ask.

  // Credit events
  // TOMBSTONE (wave 155, lane 155R24): "credit.status_updated" → reactToCreditPartnerStatus and "credit.target_reached" →
  // reactToCreditTargetReached lived here; nothing emits either dotted name, and both keyed on credit_status values no writer
  // stores. SURVIVOR: app/actions/credit-copilot.ts:399 triggerCreditFlowActions (kickoff task :500, target reached :542).
  // TOMBSTONE (wave 155, lane 155B2): "credit.partner_referred" → reactToCreditPartnerReferred lived here. SURVIVOR: app/actions/
  // credit-copilot.ts referToCreditPartner → lib/credit/credit-event-handlers.ts recordCreditPartnerReferral (the same body).

  // Video events — lane 86F3: the server-only reactions in lib/video/video-event-reactions.ts
  // (the "use server" handlers in app/actions/video-content.ts are retired onto them).
  "video.generated": async (e) => mustSucceed("video ready notification", reactToVideoReady(createServiceClient(), e.brokerage_id, e.payload ?? {}, e.user_id)),
  "video.script_approved": async (e) => mustSucceed("video script approved", reactToVideoScriptApproved(createServiceClient(), e.brokerage_id, e.payload ?? {}, e.user_id)),
  // TOMBSTONE (wave 155, lane 155R24): "video.published" → reactToVideoPublished and "video.high_engagement" →
  // reactToVideoHighEngagement lived here; nothing emits either. SURVIVORS: lib/geo/publish-video-landing.ts:164 (the one
  // is_published stamp) with KernelEvent.SOCIAL_POST_PUBLISHED (lib/kernel/event-reactor.ts:3760), and
  // KernelEvent.VIDEO_HIGH_PERFORMER_DETECTED (lib/kernel/event-reactor.ts:1015).

  // Journey/Portal events — EVENT_TYPES.JOURNEY_* since lane 86F; routed below.
  "journey.task_completed": async (e) => mustSucceed("journey task notification", reactToJourneyTaskCompleted(createServiceClient(), e.brokerage_id, e.payload ?? {})),
  "journey.stage_completed": async (e) => mustSucceed("journey stage message", reactToJourneyStageCompleted(createServiceClient(), e.brokerage_id, e.payload ?? {})),
  "journey.all_tasks_done": async (e) => mustSucceed("journey complete message", reactToJourneyAllTasksDone(createServiceClient(), e.brokerage_id, e.payload ?? {})),
  // Wave 89 lane 89E — two former audit-only echoes with a stated downstream intent and no reader.
  "onboarding.stalled": async (e) => mustSucceed("stalled-onboarding nudge", reactToOnboardingStalled(createServiceClient(), e.brokerage_id, e.payload ?? {})),
  "agent.delegated_to_ai": async (e) => mustSucceed("AI-delegated reply draft", reactToAgentDelegatedToAi(createServiceClient(), e.brokerage_id, e.payload ?? {})),
}

/**
 * Dispatch one event through EVENT_HANDLERS and report the outcome the way every other
 * handler in this file does, so event_processing_log records it. A missing entry is a
 * FAILURE, not a silent skip: a `case` below can only reach this for a type the map is
 * supposed to service, so "no entry" means the two lists drifted apart.
 */
async function dispatchRegistered(event: Event): Promise<ProcessingResult> {
  const startTime = Date.now()
  const handler = `registry:${event.event_type}`
  const invoke = EVENT_HANDLERS[event.event_type]
  if (!invoke) {
    return {
      success: false,
      handler,
      error: `no EVENT_HANDLERS entry for ${event.event_type} — the switch routes it but the registry does not service it`,
      processing_time_ms: Date.now() - startTime,
    }
  }
  try {
    await invoke(event)
    return { success: true, handler, processing_time_ms: Date.now() - startTime }
  } catch (error) {
    return {
      success: false,
      handler,
      error: error instanceof Error ? error.message : "Unknown error",
      processing_time_ms: Date.now() - startTime,
    }
  }
}
/**
 * emitEventFromCron — the trusted-context emitter (cron routes, render callbacks, the
 * image generators). The caller hands a VERIFIED brokerage_id (its own row's tenant).
 *
 * HONEST RESULT (wave 91 lane 91A, 89E §7's open item). This used to answer
 * `{ success: true }` — "non-fatal" — on a REFUSED lifecycle_events insert and on any
 * throw, and it read its dedupe probe without its error (a refused probe read as "no
 * duplicate"). Every caller therefore reported a fan-out that never happened. It was
 * also a SECOND lifecycle_events writer beside lib/events/lifecycle-event-core.ts::
 * recordLifecycleEvent (§1: a duplicate) — that survivor already reads the dedupe
 * error, proves the actor (actor_user_id FKs users; a foreign id is dropped and
 * reported, never a 23503 that loses the row), counts the insert and dispatches. The
 * body now DELEGATES to it; what this adapter keeps is only what differed:
 *   · the dedupe key names ONE occurrence for good (no 24 h window) — every caller
 *     keys on an entity (video / image / the tracker's day-stamped key);
 *   · the entity derivation puts video_id FIRST (a video.generated row is about the
 *     video even when its payload also names the contact) — an explicit
 *     entity_type / entity_id on the input now wins (the tracker passes both; they
 *     were silently ignored before).
 * The legacy `payload` / `user_id` columns are no longer written: no reader selects
 * them (readers use metadata / actor_user_id — the survivor's columns).
 * Result: `success:false` + `error` on every refusal; `dispatched:false` when the row
 * landed but the orchestrator threw (the row stays for a re-run).
 */
export async function emitEventFromCron(input: EventInput): Promise<{ success: boolean; eventId?: string; error?: string; deduped?: boolean; dispatched?: boolean }> {
  if (!input.brokerage_id) {
    return { success: false, error: "brokerage_id is required" }
  }
  try {
    const { createServiceClient: svcCreate } = await import("@/lib/supabase/service")
    const { recordLifecycleEvent } = await import("@/lib/events/lifecycle-event-core")
    const pl = (input.payload ?? {}) as Record<string, any>
    const derivedId: string | null = pl.video_id ?? pl.contact_id ?? pl.listing_id ?? pl.transaction_id ?? null
    const derivedType = pl.video_id ? "video"
                      : pl.contact_id ? "contact"
                      : pl.listing_id ? "listing"
                      : pl.transaction_id ? "transaction"
                      : "brokerage"
    const r = await recordLifecycleEvent(
      svcCreate(),
      input.brokerage_id,
      {
        user_id:     input.user_id,
        event_type:  input.event_type,
        payload:     pl,
        source:      input.source,
        dedupe_key:  input.dedupe_key,
        entity_id:   input.entity_id ?? derivedId ?? input.brokerage_id,
        entity_type: input.entity_type ?? (derivedId ? derivedType : "brokerage"),
      },
      { dedupeWindowHours: null },
    )
    if (!r.ok) return { success: false, error: r.error }
    if (r.deduped) return { success: true, eventId: r.eventId, deduped: true }
    if (r.actorDropped) console.warn(`[emitEventFromCron] ${input.event_type}: ${r.actorDropped}`)
    return { success: true, eventId: r.event.id, deduped: false, dispatched: r.dispatched }
  } catch (err) {
    console.error("[emitEventFromCron] failed:", err)
    return { success: false, error: `emitEventFromCron threw: ${err instanceof Error ? err.message : String(err)}` }
  }
}
export async function orchestrateEvent(event: Event): Promise<void> {
  const startTime = Date.now()
  const results: ProcessingResult[] = []

  console.log(`[v0] Orchestrating event: ${event.event_type}`, event.id)

  try {
    // Route to appropriate handlers based on event type
    switch (event.event_type) {
      // TOMBSTONE (wave 155, lane 155R24): `case EVENT_TYPES.LEAD_CREATED:` → handleLeadCreated lived here (no emitter).
      // SURVIVOR: KernelEvent.CONTACT_CREATED, lib/kernel/event-reactor.ts:402.

      // TOMBSTONE (wave 155, lane 155B2): `case EVENT_TYPES.LEAD_TAGGED_HOT:` → handleLeadTaggedHot lived here (no emitter).
      // SURVIVOR: LEAD_SCORED → AI ISA (lib/kernel/event-reactor.ts branch 27).

      case EVENT_TYPES.LISTING_APPOINTMENT_SET:
        results.push(await handleListingAppointmentSet(event))
        break

      // TOMBSTONE (wave 155, lane 155B2): `case EVENT_TYPES.LISTING_SIGNED:` → handleListingSigned lived here (no emitter).
      // SURVIVOR: reactToListingAgreementSigned below, on KernelEvent.LISTING_AGREEMENT_SIGNED (event-reactor.ts branch "21d").

      // TOMBSTONE (wave 155, lane 155R24): `case EVENT_TYPES.LISTING_LIVE:` → handleListingLive lived here (no emitter).
      // SURVIVOR: KernelEvent.LISTING_PUBLISHED, lib/kernel/event-reactor.ts:598; the QR, app/actions/listings-kernel.ts:707.

      // ONE SPELLING (wave 154, lane 154A3): logMilestoneOverdue writes KernelEvent.MILESTONE_OVERDUE ('milestone_overdue');
      // this case used to wait for EVENT_TYPES.TRANSACTION_MILESTONE_OVERDUE ('transaction.milestone_overdue'), which nothing
      // writes — so every overdue milestone the copilot found landed in the events table and stopped at `default:`.
      case KernelEvent.MILESTONE_OVERDUE:
        results.push(await handleMilestoneOverdue(event))
        break

      // TOMBSTONE (wave 155, lane 155R24): `case EVENT_TYPES.CREDIT_STATUS_UPDATED:` → handleCreditStatusUpdated lived here (no
      // emitter of the dotted name). SURVIVOR: app/actions/credit-copilot.ts:399 triggerCreditFlowActions.

      case EVENT_TYPES.VIDEO_GENERATED:
        results.push(await handleVideoGenerated(event))
        break

      case EVENT_TYPES.IMAGE_GENERATED:
        results.push(await handleImageGenerated(event))
        break

      // ─── Routed THROUGH the registry (EVENT_HANDLERS, above) ──────────────
      // Every case here previously fell to `default:` and logged "No handler",
      // which is why the modules behind them read as built-but-unwired. None of
      // these types is emitted anywhere in the repo today, so wiring them
      // changes no current behaviour — it means the day an emitter is added the
      // handler runs instead of the event landing in the table and stopping.
      // They stay `case EVENT_TYPES.X:` rather than a map lookup in `default:`
      // so the routed set remains readable to
      // scripts/event-dispatch-invariant-guard.ts, which derives it from these
      // case labels.
      // TOMBSTONE (wave 155, lane 155B2): LISTING_PRICE_REDUCTION, TRANSACTION_CLOSED and CREDIT_PARTNER_REFERRED were routed
      // here. SURVIVORS (header, WAVE 155 block): handlePriceReduction, lib/reputation/review-ask.ts, referToCreditPartner.
      // TOMBSTONE (wave 155, lane 155R24): LISTING_OFFER_RECEIVED, TRANSACTION_CLOSE_APPROACHING, CREDIT_TARGET_REACHED,
      // VIDEO_PUBLISHED and VIDEO_HIGH_ENGAGEMENT were routed here. SURVIVORS: the registry tombstones above (header, 155R24 block).
      case EVENT_TYPES.TRANSACTION_CONTINGENCY_CLEARED:
      case EVENT_TYPES.TRANSACTION_CLOSING_SOON:
      case EVENT_TYPES.VIDEO_SCRIPT_APPROVED:
      case EVENT_TYPES.JOURNEY_TASK_COMPLETED:
      case EVENT_TYPES.JOURNEY_STAGE_COMPLETED:
      case EVENT_TYPES.JOURNEY_ALL_TASKS_DONE:
      case EVENT_TYPES.ONBOARDING_STALLED:
      case EVENT_TYPES.AGENT_DELEGATED_TO_AI:
        results.push(await dispatchRegistered(event))
        break

      default:
        console.log(`[v0] No handler for event type: ${event.event_type}`)
        results.push({
          success: true,
          handler: "default",
          processing_time_ms: Date.now() - startTime,
        })
    }

    // Chain registry — trigger any registered multi-step workflow chains for this event.
    // This is additive: inline switch handlers above handle quick reactions while chains
    // handle long-running, multi-step, approval-gated workflows. Both coexist.
    try {
      const chains = getChainsByTrigger(event.event_type)
      const pl = event.payload as Record<string, any>
      for (const chain of chains) {
        const chainResult = await engineStartRun({
          chainKey:       chain.key,
          brokerageId:    event.brokerage_id,
          contactId:      pl?.contact_id ?? null,
          listingId:      pl?.listing_id ?? null,
          transactionId:  pl?.transaction_id ?? null,
          agentUserId:    pl?.agent_user_id ?? event.user_id ?? null,
          triggerEvent:   event.event_type,
          triggerEventId: event.id,
          metadata:       pl ?? {},
        })
        results.push({
          success: !chainResult.error,
          handler: `chain:${chain.key}`,
          error: chainResult.error,
          processing_time_ms: 0,
        })
      }
    } catch (chainErr) {
      console.error(`[v0] Chain dispatch error for event ${event.event_type}:`, chainErr)
    }

    // Log all processing results
    await logProcessingResults(event, results)

    // Mark event as processed
    await markEventProcessed(event)
  } catch (error) {
    console.error(`[v0] Error orchestrating event ${event.id}:`, error)
    await logProcessingResults(event, [
      {
        success: false,
        handler: "orchestrator",
        error: error instanceof Error ? error.message : "Unknown error",
        processing_time_ms: Date.now() - startTime,
      },
    ])
  }
}
// =====================================================
// EVENT HANDLERS - Specific logic for each event type
// =====================================================

// TOMBSTONE (wave 155, lane 155R24 — CLAUDE.md §1/§5): handleLeadCreated (a "New Lead - Follow Up" card to whoever emitted) lived
// here. Nothing emits lead.created; leads are the brokerage's, so a per-emitter follow-up card was the wrong owner as well.
// SURVIVOR: KernelEvent.CONTACT_CREATED — lib/kernel/event-reactor.ts:402 (sequence enrollment) and the staff bell
// (lib/kernel/notification-engine.ts:523).

// TOMBSTONE (wave 155, lane 155B2): handleLeadTaggedHot (a "Hot Lead Alert" card + bell to whoever emitted) lived here — no
// emitter in either spelling. SURVIVOR: LEAD_SCORED → AI ISA (lib/kernel/event-reactor.ts branch 27) and the ISA handoff, which
// is how a lead reaches an agent once qualified (CLAUDE.md §5).

async function handleListingAppointmentSet(event: Event): Promise<ProcessingResult> {
  const startTime = Date.now()
  try {
    const { listing_id, appointment_date, contact_id } = event.payload

    // Create AI suggestion for prep. A home-value or AI-ISA seller has no listing yet
    // (lane 88D: every booking path now fires this event for the SELLER), so the card
    // hangs off the seller contact when there is no listing. The CMA + presentation
    // are produced by the listing-appt-prep chain this same event starts (below), so
    // the card asks the agent to REVIEW them, not to build them.
    await writeEventSuggestion({
      brokerage_id: event.brokerage_id,
      user_id: event.user_id!,
      context_type: listing_id ? "listing" : "contact",
      context_id: listing_id ?? contact_id,
      suggestion_type: "checklist",
      title: "Listing Appointment Prep",
      description: `Appointment scheduled for ${appointment_date}. Your CMA, listing presentation and seller drip are being prepared automatically — review them and print the contract.`,
      action_payload: {
        listing_id,
        contact_id,
        tasks: ["prepare_cma", "print_contracts", "review_comps"],
      },
    })

    return {
      success: true,
      handler: "handleListingAppointmentSet",
      processing_time_ms: Date.now() - startTime,
    }
  } catch (error) {
    return {
      success: false,
      handler: "handleListingAppointmentSet",
      error: error instanceof Error ? error.message : "Unknown error",
      processing_time_ms: Date.now() - startTime,
    }
  }
}

export type ListingAgreementSignedOutcome = {
  decision: "acted" | "replayed" | "unreadable"
  tasksInserted: number
  procurement: "requested" | "not_recommended" | "threw" | "skipped"
  suggestion: "written" | "skipped"
  detail: string
}

/**
 * THE ONE REACTION to a signed listing agreement (wave 155, lane 155B2 — merged from handleListingSigned + the "listing.signed"
 * registry entry, neither of which any emitter reached). Called by lib/kernel/event-reactor.ts branch "21d" on
 * KernelEvent.LISTING_AGREEMENT_SIGNED, the spelling app/actions/seller-listing/execution-engine.ts actually emits (twice per
 * signing: transitionLifecycle + a direct processKernelEvent). ONCE PER LISTING: the agent_action_ledger idempotency key
 * `listing.agreement_signed:<tenant>:<listing>` makes the second emit — and any replay — a no-op, so the agent gets one
 * checklist, one procurement request and one card. Tenant: the event's (the reactor's verified brokerageId); the listing must
 * be in it. The recipient is the LISTING's agent (listings.agent_id is agents-class → agents.user_id, §3), never a guess.
 * What it does (each kept from the retired implementations, nothing new): the go-live task list (lifecycle-event-tasks
 * agreementSignedTasks), the Listing Concierge's photography procurement (lib/kernel/procurement.ts, wave 107B — the
 * "Photography + marketing prep begins" the seller-portal card for this event already promises), and the checklist card.
 */
export async function reactToListingAgreementSigned(
  svc: any,
  input: { brokerageId: string; listingId: string; plannedMlsLiveDate?: string | null },
  deps: {
    procure?: (svc: any, req: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>
    suggest?: typeof writeEventSuggestion
  } = {},
): Promise<ListingAgreementSignedOutcome> {
  const { brokerageId, listingId } = input
  const { data: listing, error: lErr } = await svc
    .from("listings").select("id, agent_id").eq("id", listingId).eq("brokerage_id", brokerageId).maybeSingle()
  if (lErr || !listing) {
    return { decision: "unreadable", tasksInserted: 0, procurement: "skipped", suggestion: "skipped", detail: lErr ? `listing read refused: ${lErr.message}` : `listing ${listingId} is not in brokerage ${brokerageId}` }
  }
  let agentUserId: string | null = null
  if (listing.agent_id) {
    const { data: agent, error: aErr } = await svc
      .from("agents").select("user_id").eq("id", listing.agent_id).eq("brokerage_id", brokerageId).maybeSingle()
    if (aErr) console.error(`[reactToListingAgreementSigned] agent read refused for listing ${listingId}: ${aErr.message}`)
    agentUserId = (agent?.user_id as string | null) ?? null
  }
  const goLive = typeof input.plannedMlsLiveDate === "string" ? input.plannedMlsLiveDate.slice(0, 10) : null
  const { withActionLedger } = await import("@/lib/kernel/action-ledger")
  return withActionLedger<ListingAgreementSignedOutcome>(
    {
      brokerageId,
      action: "listing.agreement.signed_followup",
      actor: { type: "manager", managerKey: "listing_concierge" },
      subject: { type: "listing", id: listingId },
      reasonCode: "UNSPECIFIED",
      reasonDetail: "listing agreement executed → go-live checklist, photography procurement, agent card (once per listing)",
      riskClass: "LOW_RISK_WRITE",
      systemSource: "listing_agreement_signed",
      idempotencyKey: `listing.agreement_signed:${brokerageId}:${listingId}`,
      detail: { listing_id: listingId, planned_mls_live_date: goLive, decided_by: "KernelEvent.LISTING_AGREEMENT_SIGNED (the executed agreement)" },
    },
    async () => {
      const tasks = await agreementSignedTasks(svc, brokerageId, { listing_id: listingId })
      let procurement: ListingAgreementSignedOutcome["procurement"] = "skipped"
      try {
        const procure = deps.procure ?? (async (s: any, req: Record<string, unknown>) => {
          const { requestProcurement } = await import("@/lib/kernel/procurement")
          return requestProcurement(s, req as never) as Promise<{ ok: boolean; error?: string }>
        })
        const r = await procure(svc, {
          brokerageId, serviceType: "photography", listingId, neededBy: goLive,
          requirements: { purpose: "listing launch media", source: "listing_agreement_signed" },
          requestedByUserId: agentUserId,
        })
        procurement = r.ok ? "requested" : "not_recommended"
        if (!r.ok) console.warn(`[reactToListingAgreementSigned] photography procurement not recommended for listing ${listingId}: ${r.error}`)
      } catch (e) {
        procurement = "threw"
        console.error(`[reactToListingAgreementSigned] photography procurement threw for listing ${listingId}:`, e instanceof Error ? e.message : e)
      }
      let suggestion: ListingAgreementSignedOutcome["suggestion"] = "skipped"
      if (agentUserId) {
        try {
          await (deps.suggest ?? writeEventSuggestion)({
            brokerage_id: brokerageId, user_id: agentUserId, context_type: "listing", context_id: listingId, suggestion_type: "checklist",
            title: "Listing Signed - Go Live Checklist",
            description: goLive ? `Listing agreement signed. Complete these steps before ${goLive}.` : "Listing agreement signed. Complete these steps before the listing goes live.",
            action_payload: { listing_id: listingId, tasks: ["order_photography", "write_description", "set_up_lockbox", "input_mls", "create_marketing_materials"] },
          })
          suggestion = "written"
        } catch (e) {
          console.error(`[reactToListingAgreementSigned] checklist card not written for listing ${listingId}:`, e instanceof Error ? e.message : e)
        }
      }
      const inserted = (tasks as { inserted?: number }).inserted ?? 0
      return { decision: "acted", tasksInserted: inserted, procurement, suggestion, detail: tasks.success ? "ok" : `tasks: ${tasks.error}` }
    },
    {
      settle: (o) => o.tasksInserted === 0 && o.procurement !== "requested" && o.suggestion !== "written"
        ? { status: "failed", outcome: "nothing_landed", error: o.detail }
        : { status: "executed", outcome: `tasks:${o.tasksInserted},procurement:${o.procurement},card:${o.suggestion}` },
      replay: (claim) => ({ decision: "replayed", tasksInserted: 0, procurement: "skipped", suggestion: "skipped", detail: `ledger claim ${claim.kind}` }),
    },
    { client: svc },
  )
}

// TOMBSTONE (wave 155, lane 155R24 — CLAUDE.md §1): handleListingLive (the listing QR mint + a "Listing is Live - Marketing
// Time" card of manual tasks) lived here. Nothing emits listing.live. SURVIVORS: the QR — app/actions/listings-kernel.ts:707
// launchListing → lib/marketing/tracked-qr.ts mintTrackedQr on the SAME `listing:<id>` key (this handler's users.id → agents.id
// resolution was already merged there); the go-live reaction — KernelEvent.LISTING_PUBLISHED (lib/listings/mls-live-verification.ts
// :265 → lib/kernel/event-reactor.ts:598: promo video, mail, ads, social drafts). The manual-task card is an owner question (lane
// 155B2 notes, default: automation only).

async function handleMilestoneOverdue(event: Event): Promise<ProcessingResult> {
  const startTime = Date.now()
  try {
    // ONE BODY (wave 155, lane 155B2): the copilot's own suggestion + sendNotificationToAgent used to fire here BESIDE the
    // deadline monitor's activity + notification for the same milestone. Both finders now end in raiseMilestoneOverdue
    // (lib/transactions/deadline-monitor.ts) — one notification, one card, at most once per milestone per day.
    const { milestone_id } = (event.payload ?? {}) as Record<string, any>
    if (!milestone_id) throw new Error("milestone_overdue event carries no milestone_id")
    const { raiseMilestoneOverdue } = await import("@/lib/transactions/deadline-monitor")
    const r = await raiseMilestoneOverdue(createServiceClient(), {
      brokerageId: event.brokerage_id, milestoneId: String(milestone_id), source: event.source === "cron" ? "deadline_monitor" : "copilot", actorUserId: event.user_id ?? null,
    }, {
      suggest: (p) => writeEventSuggestion({
        brokerage_id: p.brokerageId, user_id: p.userId, context_type: "transaction", context_id: p.transactionId, suggestion_type: "alert",
        title: `⚠️ Overdue: ${p.title}`, description: `This milestone is ${p.daysOverdue} days overdue. Take action immediately.`,
        action_payload: { milestone_id: p.milestoneId, transaction_id: p.transactionId, action: "resolve_overdue_milestone", priority: "critical" },
      }),
    })
    if (r.decision === "unreadable") throw new Error(r.detail)

    return {
      success: true,
      handler: "handleMilestoneOverdue",
      processing_time_ms: Date.now() - startTime,
    }
  } catch (error) {
    return {
      success: false,
      handler: "handleMilestoneOverdue",
      error: error instanceof Error ? error.message : "Unknown error",
      processing_time_ms: Date.now() - startTime,
    }
  }
}

// TOMBSTONE (wave 155, lane 155R24 — CLAUDE.md §1): handleCreditStatusUpdated (a "Credit Target Reached" card when a free-text
// status read 'target_reached') lived here. Nothing emits the dotted credit.status_updated, logCreditStatusUpdated writes the
// underscore spelling, and no credit_status writer stores 'target_reached'. SURVIVOR: app/actions/credit-copilot.ts:399
// triggerCreditFlowActions — the funded stage marks target_score_reached and queues the celebration task (:542).

/**
 * THE FAN-OUT. A finished video reaches every channel from here — an email
 * draft, an SMS draft, the listing landing page, one social draft per platform,
 * and an embed into every asset under its marketing campaign.
 *
 * ENGINE-AGNOSTIC BY CONSTRUCTION. This used to read `video_url` +
 * `thumbnail_url` straight off a D-ID-shaped event payload and refuse outright
 * when `video_url` was absent — so a Remotion render (which finishes MOST
 * videos, and files its bytes in remotion_composition_renders before
 * render-composition stamps the branded composite onto ai_video_projects) had
 * no path into any of it. The URL is now resolved through the ONE resolver
 * (lib/video/playable-video), which answers for BOTH engines, so a Remotion
 * video fans out exactly like a D-ID one.
 *
 * IT RESOLVES, IT DOES NOT TRUST THE PAYLOAD. The row is authoritative and the
 * payload is a snapshot: poll-did-videos brands the video AFTER the raw D-ID
 * result exists, and render-composition writes the branded composite URL to the
 * project row. Resolving means the drafts carry the delivered cut and the
 * bucket URL, not whatever was true at emit time. A video the resolver will not
 * call `ready` — still rendering, failed, or refused by the script-compliance
 * postcheck — is REFUSED here with the reason, because every branch below
 * writes that URL somewhere a human or a client eventually clicks.
 */
async function handleVideoGenerated(event: Event): Promise<ProcessingResult> {
  const startTime = Date.now()
  try {
    const {
      video_id,
      video_type,
      render_id,
      listing_id,
      contact_id,
      marketing_campaign_id,
      agent_user_id,
    } = event.payload
    const agentId = agent_user_id ?? event.user_id
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString()
    const summary: string[] = []

    const { createServiceClient: svcCreate } = await import("@/lib/supabase/service")
    const svc = svcCreate()

    const { resolvePlayableVideo } = await import("@/lib/video/playable-video")
    const playable = await resolvePlayableVideo(
      { videoProjectId: video_id ?? null, renderId: render_id ?? null },
      svc,
    )
    if (playable.state !== "ready") {
      const detail = playable.state === "in_progress"
        ? `render still in flight (${playable.source})`
        : playable.reason
      return {
        success: false,
        handler: "handleVideoGenerated",
        error: `no playable video for ${video_id ?? render_id ?? "unknown"}: ${detail}`,
        processing_time_ms: Date.now() - startTime,
      }
    }
    const video_url     = playable.videoUrl
    const thumbnail_url = playable.thumbnailUrl

    // ── 0. THE CONTENT KIT — a finished video is an ANCHOR ASSET: build the
    // proven multi-channel copy around it FIRST (per-channel captions, email
    // subject+blurb, SMS line, portal message — grounded in the video's own
    // script + listing facts, compliance-gated, fact-built fallback) so every
    // section below ships fitting content instead of a generic line.
    // Idempotent; stored on video_metadata.content_kit. Best-effort.
    let contentKit: import("@/lib/marketing/video-content-kit").VideoContentKit | null = null
    try {
      const { buildVideoContentKit } = await import("@/lib/marketing/video-content-kit")
      const kitResult = await buildVideoContentKit(svc, video_id)
      if (kitResult.ok && kitResult.kit) {
        contentKit = kitResult.kit
        summary.push(`content kit ${kitResult.kit.built_by}`)
      }
    } catch (kitErr) {
      console.error("[handleVideoGenerated] Content kit build failed:", kitErr)
    }

    // ── 1. Personal videos to a specific contact → drafts in ai_message_drafts ─
    // Channels: email if contact has email, SMS if contact has phone. Agent
    // reviews + acts on these drafts from their unified inbox.
    // 'memory_video' belongs here and 'home_anniversary' deliberately does NOT.
    // m565 split the two: a memory video is the seller-dictated family history of
    // the house (lib/video/memory-video-gate.ts) and it has no delivery rail of
    // its own, so the per-contact email + SMS drafts below are how the finished
    // keepsake reaches the family. The home-anniversary clip already owns TWO
    // delivery halves — the email sweep and the portal card, both in
    // app/api/cron/intro-video-email-backfill — so drafting here as well would be
    // a third touch to one person about one clip. Membership of this list is the
    // switch; the guard below is the backstop for anything already on a rail.
    const personalVideoTypes = ["thank_you", "personal", "buyer_guide", "memory_video"]
    // A VIDEO THAT ALREADY HAS A DELIVERY RAIL MUST NOT GET A SECOND ONE.
    // lib/video/intro-video-reactor.ts files an `agent_intro_videos` row and
    // stamps its id onto video_metadata.intro_video_id; that row is the ledger
    // app/api/cron/intro-video-email-backfill drives — it sends the email half
    // and stamps the portal card half. Drafting an email + SMS here as well
    // would touch the same contact a third time about one clip.
    //
    // The read is scoped to the case that can actually be affected — a
    // per-contact draft type WITH a contact and an agent — so a listing promo or
    // a market update costs no extra query. The listing-attach and social
    // branches below need no such guard: their types (listing_promo,
    // neighborhood_tour, market_update, agent_introduction) are ones this rail
    // never stamps, and the listing branch additionally needs a listing_id an
    // intro/anniversary video has not got.
    const couldDraft = personalVideoTypes.includes(video_type) && !!contact_id && !!agentId
    let projectMeta: { intro_video_id?: string | null } | null = null
    if (couldDraft && video_id) {
      const { data: metaRow } = await svc
        .from("ai_video_projects")
        .select("video_metadata")
        .eq("id", video_id)
        .maybeSingle()
      projectMeta = ((metaRow as { video_metadata?: unknown } | null)?.video_metadata ?? null) as
        | { intro_video_id?: string | null }
        | null
    }
    const hasOwnDeliveryRail = !!projectMeta?.intro_video_id
    if (hasOwnDeliveryRail) {
      summary.push("per-contact drafts skipped — agent_intro_videos owns this delivery")
    }
    // A MEMORY VIDEO IS DELIVERED ONLY WHEN IT IS THE SELLER'S OWN WORDS (§5;
    // wired 2026-09-03). This branch is the keepsake's ONLY delivery rail, and
    // the metadata is already in hand — isSellerAuthored is the one predicate
    // that reads the stamp lib/video/memory-video.ts writes. Fail closed: a
    // memory_video row that cannot prove authorship gets no draft.
    const memoryVideoUnproven = video_type === "memory_video" && !isSellerAuthored(projectMeta)
    if (couldDraft && memoryVideoUnproven) {
      summary.push("per-contact drafts skipped — memory video is not provably seller-authored (video_metadata.authored_by/dictation missing)")
    }
    if (couldDraft && !hasOwnDeliveryRail && !memoryVideoUnproven) {
      try {
        const { data: contact } = await svc
          .from("contacts")
          .select("first_name, last_name, email, phone")
          .eq("id", contact_id)
          .maybeSingle()
        if (contact) {
          const greeting = contact.first_name ?? "there"
          const sharedRow = {
            brokerage_id:    event.brokerage_id,
            agent_user_id:   agentId,
            contact_id,
            listing_id:      listing_id ?? null,
            trigger_event:   "video.generated",
            context_summary: `${video_type} video for ${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim(),
            status:          "pending",
          }
          if (contact.email) {
            await sentinelWrite(svc, svc.from("ai_message_drafts").insert({
              ...sharedRow,
              channel:       "email",
              draft_subject: "I recorded a quick video for you",
              draft_body:    `Hi ${greeting},\n\nI recorded a short personal video for you — watch it here: ${video_url}\n\n— Your agent`,
            }), { table: "ai_message_drafts", flow: "ai_message_drafts_write", reason: "agent-review draft; the video itself is ready regardless" })
            summary.push("draft email")
          }
          if (contact.phone) {
            await sentinelWrite(svc, svc.from("ai_message_drafts").insert({
              ...sharedRow,
              channel:    "sms",
              draft_body: `Hi ${greeting}, I recorded a quick video for you — ${video_url}`,
            }), { table: "ai_message_drafts", flow: "ai_message_drafts_write", reason: "agent-review draft; the video itself is ready regardless" })
            summary.push("draft text")
          }
        }
      } catch (personalErr) {
        console.error("[handleVideoGenerated] Personal draft failed:", personalErr)
      }
    }

    // ── 1b. WAVE 98 — an APPROVED client-facing video whose render just landed ─────────
    // A video approved before its render finished had no URL to deliver at approval
    // (lib/kernel/approval-queue-aggregator.ts applyMarketingAssetApproval("video")); this
    // render-ready moment is the second and last delivery point. The rule (approved +
    // CLIENT_FACING_VIDEO_TYPES + a contact) and the once-per-video idempotency live in
    // lib/video/client-video-delivery.ts; its kinds are disjoint from personalVideoTypes above,
    // so this never doubles the draft rail.
    if (video_id) {
      const { deliverApprovedClientVideo } = await import("@/lib/video/client-video-delivery")
      const delivery = await deliverApprovedClientVideo(svc as any, video_id)
      if (delivery.card === "written") summary.push("client video portal card")
      if (delivery.email === "sent") summary.push("client video email")
      if (delivery.card === "failed" || delivery.email === "failed") {
        console.error(`[handleVideoGenerated] client video delivery incomplete for ${video_id}: card=${delivery.card} email=${delivery.email} ${delivery.detail ?? ""}`)
      }
    }

    // ── 1c. WAVE 142 (lane 142F) — an APPROVED PUBLIC MARKETING video whose render just landed ─
    // The approval hook (lib/kernel/approval-queue-aggregator.ts applyMarketingAssetApproval
    // "video") queues YouTube only when a file exists; a video approved before its render
    // finished reaches this second and last point. Same classifier, same tenant switch, same
    // idempotency (lib/video/youtube-publish.ts) — a personal or client video is refused with
    // its reason. Never a second post for a video the approval hook already queued.
    if (video_id) {
      const { queueYouTubeAutoPublish } = await import("@/lib/video/youtube-publish")
      const yt = await queueYouTubeAutoPublish(svc as any, video_id)
      if (yt.queued) summary.push(yt.alreadyQueued ? "youtube already queued" : "youtube queued")
      else summary.push(`youtube not queued (${yt.reason})`)
    }

    // ── 2. Listing videos → attach to the property landing page ─────────────
    // listing_media is the canonical table the public listing detail page
    // reads from. media_type='video' + file_url=video_url. We let the
    // approval workflow defaults take over (approval_required=true,
    // is_approved=false) so the agent reviews before it goes live.
    const listingAttachTypes = ["listing_promo", "neighborhood_tour"]
    if (listingAttachTypes.includes(video_type) && listing_id) {
      try {
        await sentinelWrite(svc, svc.from("listing_media").insert({
          brokerage_id:  event.brokerage_id,
          listing_id,
          media_type:    "video",
          file_url:      video_url,
          thumbnail_url: thumbnail_url ?? null,
          uploaded_by:   agentId ?? null,
        }), { table: "listing_media", flow: "listing_media_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
        summary.push("attached to listing landing page")
      } catch (listingErr) {
        console.error("[handleVideoGenerated] Listing attach failed:", listingErr)
      }
    }

    // ── 3. Multi-platform social drafts (one row per platform) ──────────────
    // social_posts is one row per platform — createSocialPost only writes the
    // first platform passed in, so we loop to fan out across FB / IG / LinkedIn.
    const socialVideoTypes = ["listing_promo", "market_update", "neighborhood_tour", "agent_introduction"]
    if (socialVideoTypes.includes(video_type) && agentId) {
      const captionByType: Record<string, string> = {
        listing_promo:      "Just listed! Check out this beautiful property. #JustListed #RealEstate",
        market_update:      "Market update — see what's happening in your local real estate market. #MarketUpdate #RealEstate",
        neighborhood_tour:  "Neighborhood tour — discover what makes this area special. #NeighborhoodTour",
        agent_introduction: "Hi, I'm your local real estate expert. Let's connect! #RealEstate #YourAgent",
      }
      const fallbackCaption = captionByType[video_type] ?? "New video from your real estate team. #RealEstate"
      const platforms = ["facebook", "instagram", "linkedin"]
      try {
        // THE draft writer with an explicit actor (lib/social/create-social-post-draft.ts) — never the session-bound server action,
        // which an event handler without a cookie session could only ever be refused by (and which put the action module on every page).
        const { createSocialPostDraft } = await import("@/lib/social/create-social-post-draft")
        const { kitCaptionFor } = await import("@/lib/marketing/video-content-kit")
        for (const platform of platforms) {
          // CHANNEL-FIT copy from the content kit (owner rule: no hardcoded
          // content, no one-caption-for-all-channels); type-map fallback only
          // when the kit could not be built.
          const caption = contentKit
            ? [kitCaptionFor(contentKit, platform), contentKit.hashtags.map((h) => `#${h}`).join(" ")].filter(Boolean).join("\n\n")
            : fallbackCaption
          await createSocialPostDraft(svc, { userId: agentId, brokerageId: event.brokerage_id }, {
            content:         caption,
            mediaUrls:       [video_url],
            mediaTypes:      ["video"],
            scheduledFor:    tomorrow,
            platforms:       [platform],
            contentType:     video_type === "listing_promo" ? "listing" : "market_update",
            linkedListingId: listing_id ?? undefined,
            generatedByAi:   true,
            aiPrompt:        `Auto-drafted from completed ${video_type} video ${video_id}`,
          })
        }
        summary.push("draft social posts (FB, IG, LinkedIn)")
      } catch (socialErr) {
        console.error("[handleVideoGenerated] Social draft failed:", socialErr)
      }
    }

    // ── 4. Campaign-attached videos → embed in every asset under the umbrella ─
    // ai_video_projects.marketing_campaign_id FKs marketing_campaigns (the
    // umbrella). The actual email body lives on newsletter_campaigns and
    // email_campaigns rows that share the same marketing_campaign_id. We
    // append the video block to each asset's content so the agent finalises
    // and sends with the video embedded.
    if (marketing_campaign_id) {
      const videoBlock = videoThumbnailEmbed(video_url, thumbnail_url)

      try {
        const { data: emailAssets } = await svc
          .from("email_campaigns")
          .select("id, content")
          .eq("marketing_campaign_id", marketing_campaign_id)
        for (const c of (emailAssets ?? []) as Array<{ id: string; content: string | null }>) {
          await sentinelWrite(svc, svc
            .from("email_campaigns")
            .update({ content: (c.content ?? "") + videoBlock })
            .eq("id", c.id), { table: "email_campaigns", flow: "email_campaigns_write", reason: "embed of a finished video into campaign assets; the video is ready regardless" })
        }
        const emailCount = emailAssets?.length ?? 0

        const { data: newsletterAssets } = await svc
          .from("newsletter_campaigns")
          .select("id, content")
          .eq("marketing_campaign_id", marketing_campaign_id)
        for (const c of (newsletterAssets ?? []) as Array<{ id: string; content: string | null }>) {
          await sentinelWrite(svc, svc
            .from("newsletter_campaigns")
            .update({ content: (c.content ?? "") + videoBlock })
            .eq("id", c.id), { table: "newsletter_campaigns", flow: "newsletter_campaigns_write", reason: "embed of a finished video into campaign assets; the video is ready regardless" })
        }
        const newsletterCount = newsletterAssets?.length ?? 0

        const total = emailCount + newsletterCount
        if (total > 0) {
          summary.push(`embedded in ${total} campaign asset${total === 1 ? "" : "s"}`)
        }
      } catch (campaignErr) {
        console.error("[handleVideoGenerated] Campaign embed failed:", campaignErr)
      }
    }

    // ── 4b. Omnipresence repurposer videos → draft per-channel social posts ──
    // No-op unless the project carries repurpose distribution intent
    // (video_metadata.repurpose). Uses the service client (RLS-bypassing) since
    // there is no user session in the cron context. Captions come from the
    // content kit (one voice across channels) with per-platform generation
    // as the legacy fallback.
    try {
      const { distributeRepurposedVideoAsDraft } = await import("@/lib/repurpose/distribute")
      const dist = await distributeRepurposedVideoAsDraft(svc, video_id)
      if (dist.success && dist.created > 0) {
        summary.push(`drafted ${dist.created} repurpose post${dist.created === 1 ? "" : "s"}`)
      }
    } catch (repurposeErr) {
      console.error("[handleVideoGenerated] Repurpose draft distribution failed:", repurposeErr)
    }

    // ── 5. Always notify the agent ──────────────────────────────────────────
    if (agentId) {
      const actionSummary = summary.length ? ` Auto-drafted: ${summary.join(", ")}.` : ""
      await writeEventSuggestion({
        brokerage_id:    event.brokerage_id,
        user_id:         agentId,
        context_type:    "video",
        context_id:      video_id,
        suggestion_type: "review",
        title:           "New Video Ready for Review",
        description:     `AI-generated ${video_type} video is ready.${actionSummary} Review and publish.`,
        action_payload:  { video_id, listing_id, contact_id, marketing_campaign_id, action: "review_and_publish" },
      })
    }

    return {
      success: true,
      handler: "handleVideoGenerated",
      processing_time_ms: Date.now() - startTime,
    }
  } catch (error) {
    return {
      success: false,
      handler: "handleVideoGenerated",
      error: error instanceof Error ? error.message : "Unknown error",
      processing_time_ms: Date.now() - startTime,
    }
  }
}

/**
 * handleImageGenerated — photo equivalent of handleVideoGenerated.
 *
 * Fires when an AI-generated or uploaded image is added to marketing_assets.
 * Routes the image to every destination the agent has wired up, so a single
 * generated graphic can simultaneously land on:
 *
 *   1. The contact's inbox (email + SMS drafts) — for personal sends
 *   2. The listing landing page (listing_marketing_content row, type='photo')
 *   3. Facebook / Instagram / LinkedIn (one social_posts draft per platform)
 *   4. The marketing-campaign assets (email_campaigns + newsletter_campaigns
 *      under the same marketing_campaign_id get the image embedded inline)
 *
 * Payload shape (all optional except brokerage_id + image_url):
 *   image_id, image_type, image_url, thumbnail_url, caption,
 *   listing_id, contact_id, marketing_campaign_id, agent_user_id
 */
async function handleImageGenerated(event: Event): Promise<ProcessingResult> {
  const startTime = Date.now()
  try {
    const {
      image_id,
      image_type,
      image_url,
      caption,
      listing_id,
      contact_id,
      marketing_campaign_id,
      agent_user_id,
      // When set by uploadListingMedia (hero-photo fan-out), the image is
      // already a row in listing_media — don't try to re-insert it.
      skip_listing_attach,
    } = event.payload
    const agentId = agent_user_id ?? event.user_id
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString()
    const summary: string[] = []

    if (!image_url) {
      return { success: false, handler: "handleImageGenerated", error: "image_url missing", processing_time_ms: Date.now() - startTime }
    }

    const { createServiceClient: svcCreate } = await import("@/lib/supabase/service")
    const svc = svcCreate()

    const baseCaption = caption ?? "Check this out!"

    // 1. Personal image to a specific contact → drafts (email + SMS)
    const personalImageTypes = ["personal", "thank_you", "memory_card"]
    if (contact_id && agentId && personalImageTypes.includes(image_type)) {
      try {
        const { data: contact } = await svc
          .from("contacts")
          .select("first_name, last_name, email, phone")
          .eq("id", contact_id)
          .maybeSingle()
        if (contact) {
          const greeting = contact.first_name ?? "there"
          const sharedRow = {
            brokerage_id:    event.brokerage_id,
            agent_user_id:   agentId,
            contact_id,
            listing_id:      listing_id ?? null,
            trigger_event:   "image.generated",
            context_summary: `${image_type} image for ${contact.first_name ?? ""} ${contact.last_name ?? ""}`.trim(),
            status:          "pending",
          }
          if (contact.email) {
            await sentinelWrite(svc, svc.from("ai_message_drafts").insert({
              ...sharedRow,
              channel:       "email",
              draft_subject: "Just for you",
              draft_body:    `Hi ${greeting},\n\n${baseCaption}\n\n${image_url}\n\n— Your agent`,
            }), { table: "ai_message_drafts", flow: "ai_message_drafts_write", reason: "agent-review draft; the image itself is ready regardless" })
            summary.push("draft email")
          }
          if (contact.phone) {
            await sentinelWrite(svc, svc.from("ai_message_drafts").insert({
              ...sharedRow,
              channel:    "sms",
              draft_body: `Hi ${greeting}, ${baseCaption} — ${image_url}`,
            }), { table: "ai_message_drafts", flow: "ai_message_drafts_write", reason: "agent-review draft; the image itself is ready regardless" })
            summary.push("draft text")
          }
        }
      } catch (err) {
        console.error("[handleImageGenerated] Personal draft failed:", err)
      }
    }

    // 2. Listing image → attach to property landing page (listing_media).
    //    Skipped when skip_listing_attach is set — the image is already a
    //    listing_media row (uploaded photo fan-out path).
    if (
      !skip_listing_attach &&
      listing_id &&
      (image_type === "listing_photo" || image_type === "listing_marketing")
    ) {
      try {
        await sentinelWrite(svc, svc.from("listing_media").insert({
          brokerage_id: event.brokerage_id,
          listing_id,
          media_type:   "photo",
          file_url:     image_url,
          uploaded_by:  agentId ?? null,
        }), { table: "listing_media", flow: "listing_media_write", reason: "analytics/cache/annotation row: its loss does not change what the caller reports — logged, never silent" })
        summary.push("attached to listing landing page")
      } catch (err) {
        console.error("[handleImageGenerated] Listing attach failed:", err)
      }
    }

    // 3. Multi-platform social drafts for marketing-oriented images
    const socialImageTypes = ["social_graphic", "listing_marketing", "market_update", "agent_branding", "open_house_flyer"]
    if (socialImageTypes.includes(image_type) && agentId) {
      const platforms = ["facebook", "instagram", "linkedin"]
      try {
        // THE draft writer with an explicit actor (lib/social/create-social-post-draft.ts) — never the session-bound server action,
        // which an event handler without a cookie session could only ever be refused by (and which put the action module on every page).
        const { createSocialPostDraft } = await import("@/lib/social/create-social-post-draft")
        for (const platform of platforms) {
          await createSocialPostDraft(svc, { userId: agentId, brokerageId: event.brokerage_id }, {
            content:         baseCaption,
            mediaUrls:       [image_url],
            mediaTypes:      ["image"],
            scheduledFor:    tomorrow,
            platforms:       [platform],
            contentType:     image_type === "listing_marketing" ? "listing" : "market_update",
            linkedListingId: listing_id ?? undefined,
            generatedByAi:   true,
            aiPrompt:        `Auto-drafted from completed ${image_type} image ${image_id}`,
          })
        }
        summary.push("draft social posts (FB, IG, LinkedIn)")
      } catch (err) {
        console.error("[handleImageGenerated] Social draft failed:", err)
      }
    }

    // 4. Campaign-attached images → embed in every email/newsletter under
    //    the same marketing_campaign_id umbrella.
    if (marketing_campaign_id) {
      const imageBlock =
        `\n\n<div style="margin:24px 0;text-align:center">` +
        `<img src="${image_url}" alt="${(caption ?? "").replace(/"/g, "&quot;")}" ` +
        `style="max-width:600px;width:100%;border-radius:8px"/>` +
        `</div>\n`
      try {
        const { data: emailAssets } = await svc
          .from("email_campaigns")
          .select("id, content")
          .eq("marketing_campaign_id", marketing_campaign_id)
        for (const c of (emailAssets ?? []) as Array<{ id: string; content: string | null }>) {
          await sentinelWrite(svc, svc.from("email_campaigns").update({ content: (c.content ?? "") + imageBlock }).eq("id", c.id), { table: "email_campaigns", flow: "email_campaigns_write", reason: "embed of a finished image into campaign assets" })
        }
        const { data: newsletterAssets } = await svc
          .from("newsletter_campaigns")
          .select("id, content")
          .eq("marketing_campaign_id", marketing_campaign_id)
        for (const c of (newsletterAssets ?? []) as Array<{ id: string; content: string | null }>) {
          await sentinelWrite(svc, svc.from("newsletter_campaigns").update({ content: (c.content ?? "") + imageBlock }).eq("id", c.id), { table: "newsletter_campaigns", flow: "newsletter_campaigns_write", reason: "embed of a finished image into campaign assets" })
        }
        const total = (emailAssets?.length ?? 0) + (newsletterAssets?.length ?? 0)
        if (total > 0) summary.push(`embedded in ${total} campaign asset${total === 1 ? "" : "s"}`)
      } catch (err) {
        console.error("[handleImageGenerated] Campaign embed failed:", err)
      }
    }

    // 5. Notify the agent
    if (agentId) {
      const actionSummary = summary.length ? ` Auto-drafted: ${summary.join(", ")}.` : ""
      await writeEventSuggestion({
        brokerage_id:    event.brokerage_id,
        user_id:         agentId,
        context_type:    "image",
        context_id:      image_id ?? null,
        suggestion_type: "review",
        title:           "New Image Ready for Review",
        description:     `AI-generated ${image_type ?? "image"} is ready.${actionSummary} Review and publish.`,
        action_payload:  { image_id, listing_id, contact_id, marketing_campaign_id, action: "review_and_publish" },
      })
    }

    return { success: true, handler: "handleImageGenerated", processing_time_ms: Date.now() - startTime }
  } catch (error) {
    return {
      success: false,
      handler: "handleImageGenerated",
      error: error instanceof Error ? error.message : "Unknown error",
      processing_time_ms: Date.now() - startTime,
    }
  }
}
// =====================================================
// HELPER FUNCTIONS
// =====================================================

/**
 * The local handlers' suggestion card, through THE writer
 * (lib/assistant/smart-suggestion.ts) on the service client. The card's tenant
 * is the event row's — every call site below passes `event.brokerage_id`. An
 * unwritten card THROWS with its reason, so the handler records a failure into
 * event_processing_log instead of reporting success over a card nobody sees.
 */
async function writeEventSuggestion(input: {
  brokerage_id: string
  user_id: string | null | undefined
  context_type: string
  context_id: string | null | undefined
  suggestion_type: string
  title: string
  description: string
  action_payload: Record<string, unknown>
  priority?: SuggestionPriority
}): Promise<void> {
  const r = await writeSmartSuggestion(createServiceClient(), input.brokerage_id, {
    userId: input.user_id,
    contextType: input.context_type,
    contextId: input.context_id,
    suggestionType: input.suggestion_type,
    title: input.title,
    description: input.description,
    actionPayload: input.action_payload,
    priority: input.priority,
  })
  if (!r.written) throw new Error(`Suggestion card not written: ${r.reason}`)
}

async function markEventProcessed(event: Event): Promise<void> {
  const svc = createServiceClient()
  // Tenant-pinned and COUNTED: an update that matches nothing resolves exactly
  // like one that worked (§3), and an unstamped event is re-processed forever.
  const { data, error } = await svc
    .from("lifecycle_events")
    .update({ processed: true, processed_at: new Date().toISOString() })
    .eq("id", event.id)
    .eq("brokerage_id", event.brokerage_id)
    .select("id")
  if (error) console.error(`[orchestrator] processed stamp refused for event ${event.id}:`, error.message)
  else if (!data?.length) console.error(`[orchestrator] processed stamp matched no lifecycle_events row ${event.id} in brokerage ${event.brokerage_id}`)
}

async function logProcessingResults(event: Event, results: ProcessingResult[]): Promise<void> {
  const supabase = createServiceClient()
  const eventId = event.id

  // The event's own brokerage_id (kernel invariant: every row that has a
  // brokerage_id FK must carry it). It used to be RE-READ through the cookie
  // client, which from a cron read nothing and stamped NULL.
  const brokerageId = event.brokerage_id ?? null

  const logs = results.map((result) => ({
    event_id:           eventId,
    brokerage_id:       brokerageId,
    handler:            result.handler,
    status:             result.success ? "success" : "failure",
    error_message:      result.error || null,
    processing_time_ms: result.processing_time_ms,
  }))

  const { error: logError } = await supabase.from("event_processing_log").insert(logs)
  if (logError) console.error(`[orchestrator] event_processing_log insert refused for event ${eventId}:`, logError.message)

  // READER (orphan doctrine §1.2) for event_processing_log — until now the
  // 5 columns written here (event_id, handler, status, processing_time_ms,
  // error_message) had no reader anywhere. This is the health half: a
  // REPEATED failure on the same handler is a system-health signal, not a
  // per-event error to shrug off. Best-effort and non-blocking — a refused
  // health check must never fail the event it is checking alongside.
  if (brokerageId) {
    const failedHandlers = Array.from(new Set(results.filter((r) => !r.success).map((r) => r.handler)))
    for (const handler of failedHandlers) {
      try {
        const since = new Date(Date.now() - 60 * 60 * 1000).toISOString()
        const { count, error: countErr } = await supabase
          .from("event_processing_log")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId)
          .eq("handler", handler)
          .eq("status", "failure")
          .gte("created_at", since)
        if (countErr) {
          console.error(`[orchestrator] event_processing_log health-check refused for ${handler}:`, countErr.message)
          continue
        }
        const REPEATED_FAILURE_THRESHOLD = 3
        if ((count ?? 0) >= REPEATED_FAILURE_THRESHOLD) {
          const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
          await publishManagerSignal({
            brokerageId,
            fromManager: "cron_manager",
            toManager: "data_steward",
            signalType: "event_processing_repeated_failure",
            message: `Orchestrator handler "${handler}" has failed ${count} times in the last hour.`,
            entityType: "event_processing_handler",
            entityId: handler,
            payload: { handler, failure_count: count, window: "1h" },
          }, supabase as any)
        }
      } catch (err) {
        console.error(`[orchestrator] event_processing_log health-check threw for ${handler}:`, err)
      }
    }
  }
}

// Wire this module's orchestrateEvent as the lib/events dispatcher.
// This runs once when app/actions/orchestrator is first imported by the app layer,
// completing the inversion-of-control loop without any lib→app imports.
registerEventDispatcher(orchestrateEvent)
