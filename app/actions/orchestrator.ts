
import { registerEventDispatcher, type OrchestratorEvent as WorkflowEvent } from "@/lib/events"
import type { Event, EventInput } from "@/lib/orchestrator"
import { EVENT_TYPES } from "@/lib/orchestrator"

import { createServerClient } from "@/lib/supabase/server"
import { generateSmartSuggestion } from "./assistant"
import { sendNotificationToAgent } from "./communications"
import { supabaseService } from "@/services/supabaseService"
import { getChainsByTrigger } from "@/lib/workflow-orchestrator/chains"
import { startRun as engineStartRun } from "@/lib/workflow-orchestrator/engine"

// =====================================================
// EVENT TYPES - Standardized event type constants
// =====================================================

// Re-export canonical types from lib/ so existing importers of this action keep working.
export { EVENT_TYPES, type EventInput, type Event } from "@/lib/orchestrator"

interface ProcessingResult {
  success: boolean
  handler: string
  error?: string
  processing_time_ms: number
  skipped?: boolean
}

// =====================================================
// EVENT HANDLER REGISTRY - Dynamic lazy-loading of handlers
// =====================================================

const EVENT_HANDLERS = {
  // Lead events
  "lead.created": () => import("./copilot").then((m) => m.generate7DayPlan),
  "lead.tagged_hot": () => import("./assistant").then((m) => m.generateAssistantSuggestions),
  "lead.engaged": () => import("./assistant").then((m) => m.generateAssistantSuggestions),

  // Listing events
  "listing.appointment_set": () => import("./listing-lifecycle").then((m) => m.handleListingAppointmentBooked),
  "listing.signed": () => import("./listing-lifecycle").then((m) => m.handleListingAgreementSigned),
  "listing.live": () => import("./listing-lifecycle").then((m) => m.handleListingLive),
  "listing.price_reduction": () => import("./listing-lifecycle").then((m) => m.handlePriceReduction),
  "listing.offer_received": () => import("./listing-lifecycle").then((m) => m.handleOfferReceived),

  // Transaction events
  "transaction.milestone_overdue": () => import("./assistant").then((m) => m.generateAssistantSuggestions),
  "transaction.contingency_cleared": () => import("./listing-lifecycle").then((m) => m.handleContingencyCleared),
  "transaction.close_approaching": () => import("./listing-lifecycle").then((m) => m.handleClosingApproaching),
  "transaction.closing_soon": () => import("./listing-lifecycle").then((m) => m.scheduleClosingGift),
  "transaction.closed": () => import("./listing-lifecycle").then((m) => m.triggerReviewSequence),

  // Credit events
  "credit.status_updated": () => import("./credit-copilot").then((m) => m.handlePartnerStatusUpdate),
  "credit.target_reached": () => import("./credit-copilot").then((m) => m.handleTargetReached),
  "credit.partner_referred": () => import("./credit-copilot").then((m) => m.handlePartnerReferral),

  // Video events
  "video.generated": () => import("./video-content").then((m) => m.handleVideoGenerated),
  "video.script_approved": () => import("./video-content").then((m) => m.approveAndGenerateVideo),
  "video.published": () => import("./video-content").then((m) => m.handleVideoPublished),
  "video.high_engagement": () => import("./video-content").then((m) => m.handleHighEngagement),

  // Journey/Portal events
  "journey.task_completed": () => import("./journey-tasks").then((m) => m.handleTaskCompletedEvent),
  "journey.stage_completed": () => import("./journey-tasks").then((m) => m.handleStageCompletedEvent),
  "journey.all_tasks_done": () => import("./journey-tasks").then((m) => m.handleAllTasksCompletedEvent),
} as const

// =====================================================
// ORCHESTRATE BY EVENT ID - Loads event from DB and processes it
// =====================================================

export async function orchestrateEventById(eventId: string) {
  const supabase = await createServerClient()
  try {
    // Query lifecycle_events — the actual table in the DB
    const { data: event, error: fetchError } = await supabase
      .from("lifecycle_events")
      .select("id, brokerage_id, actor_user_id, event_type, metadata, processed")
      .eq("id", eventId)
      .maybeSingle()

    if (fetchError || !event) {
      return { success: false, error: "Event not found" }
    }

    if (event.processed) {
      return { success: true, skipped: true }
    }

    const handlerLoader = EVENT_HANDLERS[event.event_type as keyof typeof EVENT_HANDLERS]
    if (!handlerLoader) {
      await supabase
        .from("lifecycle_events")
        .update({ processed: true, processed_at: new Date().toISOString(), error: "No handler registered" })
        .eq("id", eventId)
      return { success: false, error: "No handler registered" }
    }

    // Reconstruct the Event shape that handlers expect, mapping schema columns back
    const eventAsEvent: Event = {
      id:           event.id,
      brokerage_id: event.brokerage_id,
      user_id:      event.actor_user_id ?? undefined,
      event_type:   event.event_type,
      payload:      (event.metadata as Record<string, any>) ?? {},
      source:       "system",
      created_at:   new Date().toISOString(),
    }

    const handler = await handlerLoader()
    const result = await (handler as (agentId: string, payload: Record<string, any>) => Promise<any>)(
      event.actor_user_id ?? event.brokerage_id,
      eventAsEvent.payload,
    )

    await supabase
      .from("lifecycle_events")
      .update({
        processed:    true,
        processed_at: new Date().toISOString(),
        error:        result?.success ? null : result?.error || null,
      })
      .eq("id", eventId)

    return result
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    await supabase
      .from("lifecycle_events")
      .update({ processed: true, processed_at: new Date().toISOString(), error: errorMessage })
      .eq("id", eventId)
    return { success: false, error: errorMessage }
  }
}

// =====================================================
// EMIT EVENT - Creates and optionally processes an event
// =====================================================

export async function emitEvent(input: EventInput, processImmediately = false): Promise<{ success: boolean; eventId?: string; error?: string }> {
  try {
    const supabase = await createServerClient()
    
    // Check for duplicate events using dedupe_key (scoped to brokerage)
    if (input.dedupe_key && input.brokerage_id) {
      const { data: existing } = await supabase
        .from("lifecycle_events")
        .select("id")
        .eq("dedupe_key", input.dedupe_key)
        .eq("brokerage_id", input.brokerage_id)
        .maybeSingle()
      
      if (existing) {
        return { success: true, eventId: existing.id } // Already exists, skip
      }
    }
    
    // Guard: brokerage_id is always required (kernel RLS invariant)
    if (!input.brokerage_id) {
      console.error("[v0] emitEvent: brokerage_id missing for event", input.event_type)
      return { success: false, error: "brokerage_id is required" }
    }

    // Insert the event — lifecycle_events requires both payload (NOT NULL)
    // and entity_id/entity_type (NOT NULL). entity falls back to brokerage
    // when no specific entity is in the payload.
    const pl = (input.payload ?? {}) as Record<string, any>
    const entityId   = pl.contact_id ?? pl.listing_id ?? pl.video_id ?? pl.transaction_id ?? input.brokerage_id
    const entityType = pl.contact_id     ? "contact"
                     : pl.listing_id     ? "listing"
                     : pl.video_id       ? "video"
                     : pl.transaction_id ? "transaction"
                     : "brokerage"
    const { data: event, error } = await supabase
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
    
    if (error) {
      // Table might not exist, log and continue
      console.log("[v0] Event table not available, skipping event emission:", input.event_type)
      return { success: true } // Don't fail the calling function
    }
    
    // Optionally process immediately
    if (processImmediately && event) {
      await orchestrateEvent(event as Event)
    }
    
    return { success: true, eventId: event?.id }
  } catch (error) {
    console.error("[v0] Error emitting event:", error)
    return { success: true } // Don't fail the calling function even if event emission fails
  }
}

/**
 * Service-client variant of emitEvent — safe to call from cron/webhook route
 * handlers where there is no user session. Uses service role to bypass RLS.
 * Inserts the lifecycle_event then immediately runs orchestrateEvent.
 */
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

// =====================================================
// MAIN ORCHESTRATOR - Routes events to appropriate handlers
// =====================================================

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
    await logProcessingResults(event.id, results)

    // Mark event as processed
    await markEventProcessed(event.id)
  } catch (error) {
    console.error(`[v0] Error orchestrating event ${event.id}:`, error)
    await logProcessingResults(event.id, [
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
    const { contact_id, source, timeline } = event.payload

    // Create AI suggestion for follow-up
    await generateSmartSuggestion({
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
    await generateSmartSuggestion({
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
    await generateSmartSuggestion({
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
    await generateSmartSuggestion({
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

    // Create marketing suggestions
    await generateSmartSuggestion({
      brokerage_id: event.brokerage_id,
      user_id: event.user_id!,
      context_type: "listing",
      context_id: listing_id,
      suggestion_type: "marketing",
      title: "Listing is Live - Marketing Time",
      description: `MLS# ${mls_number} is now active. Boost visibility with these marketing tactics.`,
      action_payload: {
        listing_id,
        actions: ["share_on_social", "send_to_sphere", "schedule_open_house", "create_video_tour"],
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
    await generateSmartSuggestion({
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
      await generateSmartSuggestion({
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

async function handleVideoGenerated(event: Event): Promise<ProcessingResult> {
  const startTime = Date.now()
  try {
    const { video_id, video_type, video_url, listing_id, agent_user_id } = event.payload
    const agentId = agent_user_id ?? event.user_id
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString()

    // For listing promo, market update, neighborhood tour, and agent intro:
    // auto-draft one social post per platform. social_posts is one row per
    // platform — createSocialPost only writes the first platform passed in,
    // so we loop here to actually create the multi-platform fan-out.
    const socialVideoTypes = ["listing_promo", "market_update", "neighborhood_tour", "agent_introduction"]
    let draftCreated = false
    if (socialVideoTypes.includes(video_type) && video_url && agentId) {
      const captionByType: Record<string, string> = {
        listing_promo:      "Just listed! Check out this beautiful property. #JustListed #RealEstate",
        market_update:      "Market update — see what's happening in your local real estate market. #MarketUpdate #RealEstate",
        neighborhood_tour:  "Neighborhood tour — discover what makes this area special. #NeighborhoodTour",
        agent_introduction: "Hi, I'm your local real estate expert. Let's connect! #RealEstate #YourAgent",
      }
      const caption = captionByType[video_type] ?? "New video from your real estate team. #RealEstate"
      const platforms = ["facebook", "instagram", "linkedin"]
      try {
        const { createSocialPost } = await import("@/app/actions/social-publishing")
        for (const platform of platforms) {
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
        draftCreated = true
      } catch (socialErr) {
        console.error("[handleVideoGenerated] Draft social post failed:", socialErr)
      }
    }

    // Notify the agent so they can review and publish
    if (agentId) {
      await generateSmartSuggestion({
        brokerage_id:    event.brokerage_id,
        user_id:         agentId,
        context_type:    "video",
        context_id:      video_id,
        suggestion_type: "review",
        title:           "New Video Ready for Review",
        description:     `AI-generated ${video_type} video is ready.${draftCreated ? " A draft social post has been queued on Facebook, Instagram, and LinkedIn — review and publish from the Social Planner." : ""}`,
        action_payload:  { video_id, listing_id, action: "review_and_publish" },
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

// =====================================================
// HELPER FUNCTIONS
// =====================================================

async function markEventProcessed(eventId: string): Promise<void> {
  const supabase = await createServerClient()

  // Update both processed flag and processed_at timestamp on lifecycle_events
  await supabase
    .from("lifecycle_events")
    .update({ processed: true, processed_at: new Date().toISOString() })
    .eq("id", eventId)
}

async function logProcessingResults(eventId: string, results: ProcessingResult[]): Promise<void> {
  const supabase = await createServerClient()

  // Fetch the event's brokerage_id so we can insert it into the processing log
  // (kernel invariant: every row that has a brokerage_id FK must carry it)
  const { data: ev } = await supabase
    .from("lifecycle_events")
    .select("brokerage_id")
    .eq("id", eventId)
    .maybeSingle()

  const brokerageId = ev?.brokerage_id ?? null

  const logs = results.map((result) => ({
    event_id:           eventId,
    brokerage_id:       brokerageId,
    handler:            result.handler,
    status:             result.success ? "success" : "failure",
    error_message:      result.error || null,
    processing_time_ms: result.processing_time_ms,
  }))

  await supabase.from("event_processing_log").insert(logs)
}

// Wire this module's orchestrateEvent as the lib/events dispatcher.
// This runs once when app/actions/orchestrator is first imported by the app layer,
// completing the inversion-of-control loop without any lib→app imports.
registerEventDispatcher(orchestrateEvent)
