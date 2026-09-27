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

import { registerEventDispatcher, type OrchestratorEvent as WorkflowEvent } from "@/lib/events"
import type { Event, EventInput } from "@/lib/orchestrator"
import { EVENT_TYPES } from "@/lib/orchestrator"

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
import { sendNotificationToAgent } from "@/app/actions/communications"
import {
  appointmentBookedTasks,
  agreementSignedTasks,
  listingLiveTasks,
  priceReductionTasks,
  offerReceivedTasks,
  contingencyClearedTasks,
  closingApproachingTasks,
  scheduleReviewRequests,
  scheduleClosingGiftForListing,
} from "@/lib/listing-lifecycle/lifecycle-event-tasks"
import {
  reactToCreditPartnerStatus,
  reactToCreditTargetReached,
  reactToCreditPartnerReferred,
} from "@/lib/credit/credit-event-handlers"
import {
  reactToJourneyTaskCompleted,
  reactToJourneyStageCompleted,
  reactToJourneyAllTasksDone,
} from "@/lib/portal/journey-event-handlers"
import { writeSevenDayNurturePlan } from "@/lib/copilot/seven-day-plan"
import {
  reactToVideoReady,
  reactToVideoScriptApproved,
  reactToVideoPublished,
  reactToVideoHighEngagement,
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

/**
 * The three keys that point at `generateAssistantSuggestions(agentId, { page, … })`.
 * FAILS CLOSED (§4): if a `case` is ever added for one of these without deciding what
 * page context the event carries, the dispatch reports a failure into
 * event_processing_log instead of calling the handler with a wrong shape.
 */
const assistantSuggestionsNotWired: EventHandlerInvoker = async (event) => {
  throw new Error(
    `${event.event_type} maps to app/actions/assistant.ts:generateAssistantSuggestions(agentId, { page, entity_id, entity_type }) — ` +
      `a UI page context this event does not carry. Recorded, not guessed; decide the mapping before adding a case.`,
  )
}

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
  "lead.created": async (e) => mustSucceed("7-day nurture plan", writeSevenDayNurturePlan(createServiceClient(), e.brokerage_id, e.payload ?? {}, e.user_id)),
  "lead.tagged_hot": assistantSuggestionsNotWired,
  "lead.engaged": assistantSuggestionsNotWired,

  // Listing events
  "listing.appointment_set": async (e) => mustSucceed("appointment tasks", appointmentBookedTasks(createServiceClient(), e.brokerage_id, e.payload ?? {})),
  "listing.signed": async (e) => mustSucceed("agreement-signed tasks", agreementSignedTasks(createServiceClient(), e.brokerage_id, e.payload ?? {})),
  "listing.live": async (e) => mustSucceed("listing-live tasks", listingLiveTasks(createServiceClient(), e.brokerage_id, e.payload ?? {})),
  "listing.price_reduction": async (e) => mustSucceed("price-reduction task", priceReductionTasks(createServiceClient(), e.brokerage_id, e.payload ?? {})),
  "listing.offer_received": async (e) => mustSucceed("offer-received task", offerReceivedTasks(createServiceClient(), e.brokerage_id, e.payload ?? {})),

  // Transaction events
  "transaction.milestone_overdue": assistantSuggestionsNotWired,
  "transaction.contingency_cleared": async (e) => mustSucceed("contingency task", contingencyClearedTasks(createServiceClient(), e.brokerage_id, e.payload ?? {})),
  "transaction.close_approaching": async (e) => mustSucceed("closing tasks", closingApproachingTasks(createServiceClient(), e.brokerage_id, e.payload ?? {})),
  // The closing gift takes a listings.id, not a payload — see the header.
  "transaction.closing_soon": async (e) =>
    mustSucceed("closing gift", scheduleClosingGiftForListing(createServiceClient(), e.brokerage_id, (e.payload as Record<string, any>)?.listing_id ?? null)),
  "transaction.closed": async (e) => mustSucceed("review requests", scheduleReviewRequests(createServiceClient(), e.brokerage_id, e.payload ?? {})),

  // Credit events
  "credit.status_updated": async (e) => mustSucceed("credit partner status", reactToCreditPartnerStatus(createServiceClient(), e.brokerage_id, e.payload ?? {}, e.user_id)),
  "credit.target_reached": async (e) => mustSucceed("credit target reached", reactToCreditTargetReached(createServiceClient(), e.brokerage_id, e.payload ?? {}, e.user_id)),
  "credit.partner_referred": async (e) => mustSucceed("credit partner referral", reactToCreditPartnerReferred(createServiceClient(), e.brokerage_id, e.payload ?? {}, e.user_id)),

  // Video events — lane 86F3: the server-only reactions in lib/video/video-event-reactions.ts
  // (the "use server" handlers in app/actions/video-content.ts are retired onto them).
  "video.generated": async (e) => mustSucceed("video ready notification", reactToVideoReady(createServiceClient(), e.brokerage_id, e.payload ?? {}, e.user_id)),
  "video.script_approved": async (e) => mustSucceed("video script approved", reactToVideoScriptApproved(createServiceClient(), e.brokerage_id, e.payload ?? {}, e.user_id)),
  "video.published": async (e) => mustSucceed("video published", reactToVideoPublished(createServiceClient(), e.brokerage_id, e.payload ?? {}, e.user_id)),
  "video.high_engagement": async (e) => mustSucceed("video engagement", reactToVideoHighEngagement(createServiceClient(), e.brokerage_id, e.payload ?? {}, e.user_id)),

  // Journey/Portal events — EVENT_TYPES.JOURNEY_* since lane 86F; routed below.
  "journey.task_completed": async (e) => mustSucceed("journey task notification", reactToJourneyTaskCompleted(createServiceClient(), e.brokerage_id, e.payload ?? {})),
  "journey.stage_completed": async (e) => mustSucceed("journey stage message", reactToJourneyStageCompleted(createServiceClient(), e.brokerage_id, e.payload ?? {})),
  "journey.all_tasks_done": async (e) => mustSucceed("journey complete message", reactToJourneyAllTasksDone(createServiceClient(), e.brokerage_id, e.payload ?? {})),
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
export async function emitEventFromCron(input: EventInput): Promise<{ success: boolean; eventId?: string; error?: string }> {
  try {
    const { createServiceClient: svcCreate } = await import("@/lib/supabase/service")
    const svc = svcCreate()

    if (!input.brokerage_id) {
      return { success: false, error: "brokerage_id is required" }
    }

    if (input.dedupe_key) {
      const { data: existing } = await svc
        .from("lifecycle_events")
        .select("id")
        .eq("dedupe_key", input.dedupe_key)
        .eq("brokerage_id", input.brokerage_id)
        .maybeSingle()
      if (existing) return { success: true, eventId: existing.id }
    }

    const pl = (input.payload ?? {}) as Record<string, any>
    const entityId   = pl.video_id ?? pl.contact_id ?? pl.listing_id ?? pl.transaction_id ?? input.brokerage_id
    const entityType = pl.video_id       ? "video"
                     : pl.contact_id     ? "contact"
                     : pl.listing_id     ? "listing"
                     : pl.transaction_id ? "transaction"
                     : "brokerage"
    const { data: event, error } = await svc
      .from("lifecycle_events")
      .insert({
        brokerage_id:  input.brokerage_id,
        actor_user_id: input.user_id ?? null,
        user_id:       input.user_id ?? null,
        event_type:    input.event_type,
        payload:       pl,
        metadata:      pl,
        source:        input.source,
        dedupe_key:    input.dedupe_key ?? null,
        processed:     false,
        entity_id:     entityId,
        entity_type:   entityType,
      })
      .select()
      .single()

    if (error || !event) {
      return { success: true } // non-fatal
    }

    // Orchestrate immediately — cron context is async by definition
    await orchestrateEvent(event as Event)
    return { success: true, eventId: event.id }
  } catch (err) {
    console.error("[emitEventFromCron] failed:", err)
    return { success: true } // non-fatal
  }
}
export async function orchestrateEvent(event: Event): Promise<void> {
  const startTime = Date.now()
  const results: ProcessingResult[] = []

  console.log(`[v0] Orchestrating event: ${event.event_type}`, event.id)

  try {
    // Route to appropriate handlers based on event type
    switch (event.event_type) {
      case EVENT_TYPES.LEAD_CREATED:
        results.push(await handleLeadCreated(event))
        break

      case EVENT_TYPES.LEAD_TAGGED_HOT:
        results.push(await handleLeadTaggedHot(event))
        break

      case EVENT_TYPES.LISTING_APPOINTMENT_SET:
        results.push(await handleListingAppointmentSet(event))
        break

      case EVENT_TYPES.LISTING_SIGNED:
        results.push(await handleListingSigned(event))
        break

      case EVENT_TYPES.LISTING_LIVE:
        results.push(await handleListingLive(event))
        break

      case EVENT_TYPES.TRANSACTION_MILESTONE_OVERDUE:
        results.push(await handleMilestoneOverdue(event))
        break

      case EVENT_TYPES.CREDIT_STATUS_UPDATED:
        results.push(await handleCreditStatusUpdated(event))
        break

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
      case EVENT_TYPES.LISTING_PRICE_REDUCTION:
      case EVENT_TYPES.LISTING_OFFER_RECEIVED:
      case EVENT_TYPES.TRANSACTION_CONTINGENCY_CLEARED:
      case EVENT_TYPES.TRANSACTION_CLOSE_APPROACHING:
      case EVENT_TYPES.TRANSACTION_CLOSING_SOON:
      case EVENT_TYPES.TRANSACTION_CLOSED:
      case EVENT_TYPES.CREDIT_TARGET_REACHED:
      case EVENT_TYPES.CREDIT_PARTNER_REFERRED:
      case EVENT_TYPES.VIDEO_SCRIPT_APPROVED:
      case EVENT_TYPES.VIDEO_PUBLISHED:
      case EVENT_TYPES.VIDEO_HIGH_ENGAGEMENT:
      case EVENT_TYPES.JOURNEY_TASK_COMPLETED:
      case EVENT_TYPES.JOURNEY_STAGE_COMPLETED:
      case EVENT_TYPES.JOURNEY_ALL_TASKS_DONE:
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

async function handleLeadCreated(event: WorkflowEvent): Promise<ProcessingResult> {
  const startTime = Date.now()
  try {
    // `timeline` rides the event payload from the lead/contact row. Its
    // vocabulary is constants/crm-standards.ts:STANDARD_TIMELINES, and the two
    // tests below key on `immediate`, which survived the consolidation of six
    // spellings unchanged — so this handler needed no repoint, only a name for
    // the list it is testing against.
    const { contact_id, source, timeline } = event.payload

    // Create AI suggestion for follow-up
    await writeEventSuggestion({
      brokerage_id: event.brokerage_id,
      user_id: event.user_id!,
      context_type: "contact",
      context_id: contact_id,
      suggestion_type: "outreach",
      title: "New Lead - Follow Up",
      description: `New ${source} lead created. ${timeline === "immediate" ? "URGENT: " : ""}Reach out within 24 hours.`,
      action_payload: {
        contact_id,
        action: "send_initial_message",
        priority: timeline === "immediate" ? "high" : "medium",
      },
    })

    return {
      success: true,
      handler: "handleLeadCreated",
      processing_time_ms: Date.now() - startTime,
    }
  } catch (error) {
    return {
      success: false,
      handler: "handleLeadCreated",
      error: error instanceof Error ? error.message : "Unknown error",
      processing_time_ms: Date.now() - startTime,
    }
  }
}

async function handleLeadTaggedHot(event: Event): Promise<ProcessingResult> {
  const startTime = Date.now()
  try {
    const { contact_id, reason } = event.payload

    // Create urgent AI suggestion
    await writeEventSuggestion({
      brokerage_id: event.brokerage_id,
      user_id: event.user_id!,
      context_type: "contact",
      context_id: contact_id,
      suggestion_type: "outreach",
      title: "🔥 Hot Lead Alert",
      description: `Lead marked as HOT. ${reason}. Schedule a call ASAP.`,
      action_payload: {
        contact_id,
        action: "schedule_call",
        priority: "critical",
      },
    })

    // Send push notification to agent
    await sendNotificationToAgent(event.user_id!, {
      title: "Hot Lead Alert",
      message: `Contact flagged as hot lead. Action needed now.`,
      priority: "high",
    })

    return {
      success: true,
      handler: "handleLeadTaggedHot",
      processing_time_ms: Date.now() - startTime,
    }
  } catch (error) {
    return {
      success: false,
      handler: "handleLeadTaggedHot",
      error: error instanceof Error ? error.message : "Unknown error",
      processing_time_ms: Date.now() - startTime,
    }
  }
}

async function handleListingAppointmentSet(event: Event): Promise<ProcessingResult> {
  const startTime = Date.now()
  try {
    const { listing_id, appointment_date, contact_id } = event.payload

    // Create AI suggestion for prep
    await writeEventSuggestion({
      brokerage_id: event.brokerage_id,
      user_id: event.user_id!,
      context_type: "listing",
      context_id: listing_id,
      suggestion_type: "checklist",
      title: "Listing Appointment Prep",
      description: `Appointment scheduled for ${appointment_date}. Prepare CMA, listing presentation, and contract.`,
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

async function handleListingSigned(event: Event): Promise<ProcessingResult> {
  const startTime = Date.now()
  try {
    const { listing_id, go_live_date } = event.payload

    // Create checklist for going live
    await writeEventSuggestion({
      brokerage_id: event.brokerage_id,
      user_id: event.user_id!,
      context_type: "listing",
      context_id: listing_id,
      suggestion_type: "checklist",
      title: "Listing Signed - Go Live Checklist",
      description: `Listing agreement signed. Complete these steps before ${go_live_date}.`,
      action_payload: {
        listing_id,
        tasks: ["order_photography", "write_description", "set_up_lockbox", "input_mls", "create_marketing_materials"],
      },
    })

    return {
      success: true,
      handler: "handleListingSigned",
      processing_time_ms: Date.now() - startTime,
    }
  } catch (error) {
    return {
      success: false,
      handler: "handleListingSigned",
      error: error instanceof Error ? error.message : "Unknown error",
      processing_time_ms: Date.now() - startTime,
    }
  }
}

async function handleListingLive(event: Event): Promise<ProcessingResult> {
  const startTime = Date.now()
  try {
    const { listing_id, mls_number } = event.payload
    const extras: string[] = []

    // Auto-mint a QR code pointing to the public listing landing page so the
    // agent has it ready for yard signs, flyers, postcards, and brochures.
    //
    // MERGED-THEN-DELETED: this used to be its own `qr_codes` insert deduping on
    // (brokerage_id, target_url). app/actions/listings-kernel.ts:launchListing minted for the
    // SAME listing deduping on (listing_id, brokerage_id, purpose) — two different keys, so
    // neither could see the other and a listing that both launched and fired listing.live ended
    // up with TWO tracked codes splitting its scans between them. Both paths now call the one
    // minter with the SAME key, `listing:<listingId>`, so whichever fires first mints and the
    // other reuses. What this path contributed and kept: the users.id → agents.id resolution
    // (qr_codes.agent_id FKs agents(id), and a users id there is a refused insert) and the
    // "QR code minted" note on the smart suggestion, which now fires only on a REAL mint.
    try {
      const { createServiceClient: svcCreate } = await import("@/lib/supabase/service")
      const svc = svcCreate()
      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.vipre.os"

      // qr_codes.agent_id FKs agents(id), not users(id). Look up the agents
      // row from the event's user_id; fall back to null when no agent record
      // exists (qr_codes.agent_id is nullable).
      let agentRowId: string | null = null
      if (event.user_id) {
        const { data: agentRow, error: agentError } = await svc
          .from("agents")
          .select("id")
          .eq("user_id", event.user_id)
          .maybeSingle()
        if (agentError) console.error("[handleListingLive] agent lookup refused:", agentError.message)
        agentRowId = agentRow?.id ?? null
      }

      const { mintTrackedQr, listingQrLabel } = await import("@/lib/marketing/tracked-qr")
      const minted = await mintTrackedQr({
        brokerageId:     event.brokerage_id,
        agentId:         agentRowId,
        label:           listingQrLabel(String(listing_id)),
        destinationType: "listing_detail",
        targetUrl:       `${appUrl}/listings/${listing_id}`,
        listingId:       String(listing_id),
        purpose:         "listing",
        origin:          appUrl,
      }, svc)

      if (minted?.created) {
        extras.push("QR code minted for landing page")
      } else if (!minted) {
        console.error(`[handleListingLive] QR mint refused for listing ${mls_number ?? listing_id}`)
      }
    } catch (qrErr) {
      console.error("[handleListingLive] QR code creation failed:", qrErr)
    }

    await writeEventSuggestion({
      brokerage_id: event.brokerage_id,
      user_id: event.user_id!,
      context_type: "listing",
      context_id: listing_id,
      suggestion_type: "marketing",
      title: "Listing is Live - Marketing Time",
      description: `MLS# ${mls_number} is now active.${extras.length ? " " + extras.join(", ") + "." : ""} Boost visibility with these marketing tactics.`,
      action_payload: {
        listing_id,
        actions: ["share_on_social", "send_to_sphere", "schedule_open_house", "create_video_tour", "print_qr_yard_sign"],
      },
    })

    return {
      success: true,
      handler: "handleListingLive",
      processing_time_ms: Date.now() - startTime,
    }
  } catch (error) {
    return {
      success: false,
      handler: "handleListingLive",
      error: error instanceof Error ? error.message : "Unknown error",
      processing_time_ms: Date.now() - startTime,
    }
  }
}

async function handleMilestoneOverdue(event: Event): Promise<ProcessingResult> {
  const startTime = Date.now()
  try {
    const { milestone_id, milestone_title, days_overdue, listing_id } = event.payload

    // Create urgent suggestion
    await writeEventSuggestion({
      brokerage_id: event.brokerage_id,
      user_id: event.user_id!,
      context_type: "transaction",
      context_id: listing_id,
      suggestion_type: "alert",
      title: `⚠️ Overdue: ${milestone_title}`,
      description: `This milestone is ${days_overdue} days overdue. Take action immediately.`,
      action_payload: {
        milestone_id,
        listing_id,
        action: "resolve_overdue_milestone",
        priority: "critical",
      },
    })

    // Send notification
    await sendNotificationToAgent(event.user_id!, {
      title: "Milestone Overdue",
      message: `${milestone_title} is ${days_overdue} days overdue`,
      priority: "high",
    })

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

async function handleCreditStatusUpdated(event: Event): Promise<ProcessingResult> {
  const startTime = Date.now()
  try {
    const { contact_id, old_status, new_status, score_band } = event.payload

    if (new_status === "target_reached") {
      // Contact reached target credit score
      await writeEventSuggestion({
        brokerage_id: event.brokerage_id,
        user_id: event.user_id!,
        context_type: "contact",
        context_id: contact_id,
        suggestion_type: "outreach",
        title: "🎉 Credit Target Reached",
        description: `Contact reached target credit score (${score_band}). Re-engage for home buying.`,
        action_payload: {
          contact_id,
          action: "celebrate_and_reengage",
          priority: "high",
        },
      })
    }

    return {
      success: true,
      handler: "handleCreditStatusUpdated",
      processing_time_ms: Date.now() - startTime,
    }
  } catch (error) {
    return {
      success: false,
      handler: "handleCreditStatusUpdated",
      error: error instanceof Error ? error.message : "Unknown error",
      processing_time_ms: Date.now() - startTime,
    }
  }
}

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
            await svc.from("ai_message_drafts").insert({
              ...sharedRow,
              channel:       "email",
              draft_subject: "I recorded a quick video for you",
              draft_body:    `Hi ${greeting},\n\nI recorded a short personal video for you — watch it here: ${video_url}\n\n— Your agent`,
            })
            summary.push("draft email")
          }
          if (contact.phone) {
            await svc.from("ai_message_drafts").insert({
              ...sharedRow,
              channel:    "sms",
              draft_body: `Hi ${greeting}, I recorded a quick video for you — ${video_url}`,
            })
            summary.push("draft text")
          }
        }
      } catch (personalErr) {
        console.error("[handleVideoGenerated] Personal draft failed:", personalErr)
      }
    }

    // ── 2. Listing videos → attach to the property landing page ─────────────
    // listing_media is the canonical table the public listing detail page
    // reads from. media_type='video' + file_url=video_url. We let the
    // approval workflow defaults take over (approval_required=true,
    // is_approved=false) so the agent reviews before it goes live.
    const listingAttachTypes = ["listing_promo", "neighborhood_tour"]
    if (listingAttachTypes.includes(video_type) && listing_id) {
      try {
        await svc.from("listing_media").insert({
          brokerage_id:  event.brokerage_id,
          listing_id,
          media_type:    "video",
          file_url:      video_url,
          thumbnail_url: thumbnail_url ?? null,
          uploaded_by:   agentId ?? null,
        })
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
        const { createSocialPost } = await import("@/app/actions/social-publishing")
        const { kitCaptionFor } = await import("@/lib/marketing/video-content-kit")
        for (const platform of platforms) {
          // CHANNEL-FIT copy from the content kit (owner rule: no hardcoded
          // content, no one-caption-for-all-channels); type-map fallback only
          // when the kit could not be built.
          const caption = contentKit
            ? [kitCaptionFor(contentKit, platform), contentKit.hashtags.map((h) => `#${h}`).join(" ")].filter(Boolean).join("\n\n")
            : fallbackCaption
          await createSocialPost({
            content:         caption,
            mediaUrls:       [video_url],
            mediaTypes:      ["video"],
            scheduledFor:    tomorrow,
            platforms:       [platform],
            contentType:     video_type === "listing_promo" ? "listing" : "market_update",
            linkedListingId: listing_id ?? undefined,
            generatedByAi:   true,
            aiPrompt:        `Auto-drafted from completed ${video_type} video ${video_id}`,
            userId:          agentId,
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
          await svc
            .from("email_campaigns")
            .update({ content: (c.content ?? "") + videoBlock })
            .eq("id", c.id)
        }
        const emailCount = emailAssets?.length ?? 0

        const { data: newsletterAssets } = await svc
          .from("newsletter_campaigns")
          .select("id, content")
          .eq("marketing_campaign_id", marketing_campaign_id)
        for (const c of (newsletterAssets ?? []) as Array<{ id: string; content: string | null }>) {
          await svc
            .from("newsletter_campaigns")
            .update({ content: (c.content ?? "") + videoBlock })
            .eq("id", c.id)
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
            await svc.from("ai_message_drafts").insert({
              ...sharedRow,
              channel:       "email",
              draft_subject: "Just for you",
              draft_body:    `Hi ${greeting},\n\n${baseCaption}\n\n${image_url}\n\n— Your agent`,
            })
            summary.push("draft email")
          }
          if (contact.phone) {
            await svc.from("ai_message_drafts").insert({
              ...sharedRow,
              channel:    "sms",
              draft_body: `Hi ${greeting}, ${baseCaption} — ${image_url}`,
            })
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
        await svc.from("listing_media").insert({
          brokerage_id: event.brokerage_id,
          listing_id,
          media_type:   "photo",
          file_url:     image_url,
          uploaded_by:  agentId ?? null,
        })
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
        const { createSocialPost } = await import("@/app/actions/social-publishing")
        for (const platform of platforms) {
          await createSocialPost({
            content:         baseCaption,
            mediaUrls:       [image_url],
            mediaTypes:      ["image"],
            scheduledFor:    tomorrow,
            platforms:       [platform],
            contentType:     image_type === "listing_marketing" ? "listing" : "market_update",
            linkedListingId: listing_id ?? undefined,
            generatedByAi:   true,
            aiPrompt:        `Auto-drafted from completed ${image_type} image ${image_id}`,
            userId:          agentId,
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
          await svc.from("email_campaigns").update({ content: (c.content ?? "") + imageBlock }).eq("id", c.id)
        }
        const { data: newsletterAssets } = await svc
          .from("newsletter_campaigns")
          .select("id, content")
          .eq("marketing_campaign_id", marketing_campaign_id)
        for (const c of (newsletterAssets ?? []) as Array<{ id: string; content: string | null }>) {
          await svc.from("newsletter_campaigns").update({ content: (c.content ?? "") + imageBlock }).eq("id", c.id)
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
