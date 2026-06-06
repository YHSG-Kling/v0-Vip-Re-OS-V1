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

import { createServerClient } from "@/lib/supabase/server"
import { generateSmartSuggestion } from "@/app/actions/assistant"
import { sendNotificationToAgent } from "@/app/actions/communications"
import { supabaseService } from "@/services/supabaseService"
import { getChainsByTrigger } from "@/lib/workflow-orchestrator/chains"
import { startRun as engineStartRun } from "@/lib/workflow-orchestrator/engine"

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
  "lead.created": () => import("@/app/actions/copilot").then((m) => m.generate7DayPlan),
  "lead.tagged_hot": () => import("@/app/actions/assistant").then((m) => m.generateAssistantSuggestions),
  "lead.engaged": () => import("@/app/actions/assistant").then((m) => m.generateAssistantSuggestions),

  // Listing events
  "listing.appointment_set": () => import("@/app/actions/listing-lifecycle").then((m) => m.handleListingAppointmentBooked),
  "listing.signed": () => import("@/app/actions/listing-lifecycle").then((m) => m.handleListingAgreementSigned),
  "listing.live": () => import("@/app/actions/listing-lifecycle").then((m) => m.handleListingLive),
  "listing.price_reduction": () => import("@/app/actions/listing-lifecycle").then((m) => m.handlePriceReduction),
  "listing.offer_received": () => import("@/app/actions/listing-lifecycle").then((m) => m.handleOfferReceived),

  // Transaction events
  "transaction.milestone_overdue": () => import("@/app/actions/assistant").then((m) => m.generateAssistantSuggestions),
  "transaction.contingency_cleared": () => import("@/app/actions/listing-lifecycle").then((m) => m.handleContingencyCleared),
  "transaction.close_approaching": () => import("@/app/actions/listing-lifecycle").then((m) => m.handleClosingApproaching),
  "transaction.closing_soon": () => import("@/app/actions/listing-lifecycle").then((m) => m.scheduleClosingGift),
  "transaction.closed": () => import("@/app/actions/listing-lifecycle").then((m) => m.triggerReviewSequence),

  // Credit events
  "credit.status_updated": () => import("@/app/actions/credit-copilot").then((m) => m.handlePartnerStatusUpdate),
  "credit.target_reached": () => import("@/app/actions/credit-copilot").then((m) => m.handleTargetReached),
  "credit.partner_referred": () => import("@/app/actions/credit-copilot").then((m) => m.handlePartnerReferral),

  // Video events
  "video.generated": () => import("@/app/actions/video-content").then((m) => m.handleVideoGenerated),
  "video.script_approved": () => import("@/app/actions/video-content").then((m) => m.approveAndGenerateVideo),
  "video.published": () => import("@/app/actions/video-content").then((m) => m.handleVideoPublished),
  "video.high_engagement": () => import("@/app/actions/video-content").then((m) => m.handleHighEngagement),

  // Journey/Portal events
  "journey.task_completed": () => import("@/app/actions/journey-tasks").then((m) => m.handleTaskCompletedEvent),
  "journey.stage_completed": () => import("@/app/actions/journey-tasks").then((m) => m.handleStageCompletedEvent),
  "journey.all_tasks_done": () => import("@/app/actions/journey-tasks").then((m) => m.handleAllTasksCompletedEvent),
} as const
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
    const extras: string[] = []

    // Auto-mint a QR code pointing to the public listing landing page so the
    // agent has it ready for yard signs, flyers, postcards, and brochures.
    try {
      const { createServiceClient: svcCreate } = await import("@/lib/supabase/service")
      const svc = svcCreate()
      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? "https://app.vipre.os"
      const targetUrl = `${appUrl}/listings/${listing_id}`

      // qr_codes.agent_id FKs agents(id), not users(id). Look up the agents
      // row from the event's user_id; fall back to null when no agent record
      // exists (qr_codes.agent_id is nullable).
      let agentRowId: string | null = null
      if (event.user_id) {
        const { data: agentRow } = await svc
          .from("agents")
          .select("id")
          .eq("user_id", event.user_id)
          .maybeSingle()
        agentRowId = agentRow?.id ?? null
      }

      // qr_codes.slug is globally unique, so suffix with a timestamp.
      const slug = `listing-${String(listing_id).slice(0, 8)}-${Date.now().toString(36)}`.toLowerCase()
      const { data: existing } = await svc
        .from("qr_codes")
        .select("id")
        .eq("brokerage_id", event.brokerage_id)
        .eq("target_url", targetUrl)
        .maybeSingle()
      if (!existing) {
        await svc.from("qr_codes").insert({
          brokerage_id: event.brokerage_id,
          agent_id:     agentRowId,
          label:        `Listing ${mls_number ?? listing_id}`,
          slug,
          target_url:   targetUrl,
          purpose:      "listing",
          listing_id,
          scan_count:   0,
          lead_count:   0,
          is_active:    true,
        })
        extras.push("QR code minted for landing page")
      }
    } catch (qrErr) {
      console.error("[handleListingLive] QR code creation failed:", qrErr)
    }

    await generateSmartSuggestion({
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
    const {
      video_id,
      video_type,
      video_url,
      thumbnail_url,
      listing_id,
      contact_id,
      marketing_campaign_id,
      agent_user_id,
    } = event.payload
    const agentId = agent_user_id ?? event.user_id
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString()
    const summary: string[] = []

    if (!video_url) {
      return { success: false, handler: "handleVideoGenerated", error: "video_url missing", processing_time_ms: Date.now() - startTime }
    }

    const { createServiceClient: svcCreate } = await import("@/lib/supabase/service")
    const svc = svcCreate()

    // ── 1. Personal videos to a specific contact → drafts in ai_message_drafts ─
    // Channels: email if contact has email, SMS if contact has phone. Agent
    // reviews + acts on these drafts from their unified inbox.
    const personalVideoTypes = ["thank_you", "personal", "buyer_guide", "memory_video"]
    if (personalVideoTypes.includes(video_type) && contact_id && agentId) {
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
      const videoBlock =
        `\n\n<div style="margin:24px 0;text-align:center">` +
        `<a href="${video_url}" target="_blank">` +
        (thumbnail_url
          ? `<img src="${thumbnail_url}" alt="Watch video" style="max-width:480px;width:100%;border-radius:8px"/>`
          : `<span style="display:inline-block;padding:14px 28px;background:#2563eb;color:#fff;border-radius:6px;font-weight:600">Watch the video</span>`) +
        `</a></div>\n`

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
    // there is no user session in the cron context.
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
      await generateSmartSuggestion({
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
      await generateSmartSuggestion({
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
