// lib/application/listing-lifecycle.ts
// Library service layer — NOT a Server Action entrypoint.
// Imported by both app/actions/ and lib/kernel/. Do NOT add "use server" here.

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

// =====================================================
// LISTING LIFECYCLE APPLICATION SERVICE
// All business logic lives here
// =====================================================

export async function scheduleListingAppointmentService(
  params: {
    listing_id: string
    contact_id: string
    appointment_date: string
    appointment_time: string
    notes?: string
    /** "zoom" → attempt a REAL Zoom meeting on the booking agent's connected
     *  scope (agent → team → brokerage). Honest in-person default otherwise. */
    meeting_mode?: "zoom" | "in_person"
  },
  agentId: string,
  brokerageId: string
) {
  const supabase = await createClient()

  // The seller listing-presentation appointment is a FIRST-CLASS calendar event
  // (flows to the agent's daily briefing, calendar view, and Google sync), with the
  // listing carrying the denormalized time + a FK to the event for the listing card.
  // (Previously written to phantom listings.appointment_date/_time/notes — silently failed.)
  const appointmentAt = new Date(`${params.appointment_date}T${params.appointment_time}`).toISOString()

  // ── Zoom branch (additive, round 39) — never blocks the booking ────────────
  let zoomLocation: string | null = null
  let zoomMetadata: Record<string, unknown> = {}
  if (params.meeting_mode === "zoom") {
    try {
      const { ensureZoomMeetingForAppointment } = await import("@/lib/connections/zoom")
      const { connectionScopeForUserType } = await import("@/lib/connections/field-spec")
      const { createServiceClient } = await import("@/lib/supabase/service")
      const svc = createServiceClient()
      const { data: booker } = await svc
        .from("users").select("user_type, team_id, brokerage_id").eq("id", agentId).maybeSingle()
      const scope = connectionScopeForUserType((booker?.user_type as string) ?? "").scope
      const start = new Date(appointmentAt)
      const outcome = await ensureZoomMeetingForAppointment(svc, {
        host: {
          scope: scope as any,
          agentUserId: agentId,
          teamId: (booker?.team_id as string | null) ?? null,
          brokerageId: (booker?.brokerage_id as string | null) ?? brokerageId,
        },
        topic: "Listing Appointment",
        startAt: start,
        endAt: new Date(start.getTime() + 60 * 60_000),
      })
      if (outcome.created) {
        zoomLocation = outcome.joinUrl
        zoomMetadata = {
          zoom: {
            meeting_id: outcome.meetingId,
            join_url: outcome.joinUrl,
            start_url: outcome.startUrl,
            host_owner_type: outcome.hostOwnerType,
            host_owner_id: outcome.hostOwnerId,
          },
        }
      } else {
        zoomMetadata = { zoom_outcome: { created: false, reason: outcome.reason, detail: outcome.detail } }
      }
    } catch (e: any) {
      zoomMetadata = { zoom_outcome: { created: false, reason: "api_error", detail: e?.message ?? "Zoom lane error" } }
    }
  }

  const { data: calEvent, error: calErr } = await supabase
    .from("calendar_events")
    .insert({
      brokerage_id: brokerageId,
      entity_type: "listing",
      entity_id: params.listing_id,
      event_type: "listing_appointment",
      start_at: appointmentAt,
      is_system_generated: false,
      // agent_user_id lets the Zoom transcript lane resolve the agent later.
      agent_user_id: agentId,
      ...(zoomLocation ? { location: zoomLocation } : {}),
      metadata: { contact_id: params.contact_id, agent_id: agentId, notes: params.notes ?? null, ...zoomMetadata },
    })
    .select("id")
    .single()
  if (calErr) throw calErr

  const { data, error } = await supabase
    .from("listings")
    .update({
      appointment_at:       appointmentAt,
      appointment_notes:    params.notes ?? null,
      appointment_event_id: calEvent.id,
      lifecycle_stage:      "APPOINTMENT_SET",
      updated_at:           new Date().toISOString(),
    })
    .eq("id", params.listing_id)
    .select()
    .single()

  if (error) throw error

  // NOTE: orchestration (the listing-appt-prep chain: CMA → presentation → chapter videos → drip →
  // pre-listing postcard) is triggered explicitly by the scheduleListingAppointment server action via
  // triggerChainsForEvent("listing.appointment_set"), which carries the listing's property_data. This
  // service used to emit a separate logListingAppointmentSet('listing_appointment_scheduled') event
  // that matched NO chain/handler — removed (drift consolidated onto the single canonical trigger).
  return { success: true, listing: data, appointmentEventId: calEvent.id }
}

// markListingSignedService + markListingLiveService were RETIRED — they duplicated the stage spine but
// fired orphaned underscore events the dotted dispatcher never matched. The UI drives every stage
// change through advanceListingStage; canonical-stage automations run at the action layer
// (fireStageAutomations), and the MLS packet queues there on MLS_ACTIVE. No remaining caller.

export async function updateListingStageService(params: {
  listing_id: string
  stage: string
  notes?: string
}) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("listings")
    .update({
      lifecycle_stage: params.stage,
      // notes column doesn't exist on listings table
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.listing_id)
    .select()
    .single()

  if (error) throw error

  return { success: true, listing: data }
}

export async function advanceListingStageService(
  listingId: string,
  toStage: string,
  agentId: string,
  notes?: string
) {
  const supabase = await createClient()

  const { data: listing } = await supabase
    .from("listings")
    .select("*, listing_stage_history(*)")
    .eq("id", listingId)
    .single()

  if (!listing) {
    return { success: false, error: "Listing not found" }
  }

  if (listing.lifecycle_stage) {
    await supabase
      .from("listing_stage_history")
      .update({
        exited_at: new Date().toISOString(),
        duration_days: Math.floor(
          (new Date().getTime() - new Date(listing.stage_entered_at || new Date()).getTime()) / (1000 * 60 * 60 * 24),
        ),
      })
      .eq("listing_id", listingId)
      .is("exited_at", null)
  }

  // listing_stage_history is a separate table — its own entered_at/exited_at
  // columns are NOT the listings.* columns being deprecated; keep these.
  await supabase.from("listing_stage_history").insert({
    listing_id: listingId,
    stage_name: toStage,
    entered_at: new Date().toISOString(),
    completed_by: agentId,
    notes,
  })

  await supabase
    .from("listings")
    .update({
      lifecycle_stage:   toStage,
      stage_entered_at:  new Date().toISOString(),
      updated_at:        new Date().toISOString(),
    })
    .eq("id", listingId)

  // Stage automations run at the ACTION layer keyed on the CANONICAL stages
  // (app/actions/listing-lifecycle.ts::fireStageAutomations). The old triggerStageActions switch +
  // its exclusively-used helpers (generateSellerVideo / postListingToSocial / enrollLifetimeCustomer /
  // scheduleReviewRequests / trackClosingGift / notifySeller) were RETIRED: they never fired (legacy
  // lowercase stage vocabulary vs the canonical UPPERCASE stages) and were redundant with the canonical
  // flows (kernel transaction-close owns lifetime/reviews; marketing agents + crons own social/video).

  revalidatePath(`/listings/${listingId}`)

  return { success: true, stage: toStage }
}

export async function scheduleClosingGift(listingId: string) {
  const supabase = await createClient()
  const { data: listing } = await supabase
    .from("listings")
    .select("estimated_close_date, seller_contact_id, agent_id")
    .eq("id", listingId)
    .single()

  if (listing?.estimated_close_date) {
    const closeDate = new Date(listing.estimated_close_date)
    const orderDate = new Date(closeDate.getTime() - 7 * 24 * 60 * 60 * 1000)
    await supabase.from("closing_gifts").insert({
      listing_id: listingId,
      contact_id: listing.seller_contact_id,
      agent_id: listing.agent_id,
      gift_description: "Closing gift basket",
      price_cents: 7500,
      order_date: orderDate.toISOString(),
      delivery_date: closeDate.toISOString(),
      status: "scheduled",
    })
  }
}

export async function getListingTimelineService(listingId: string) {
  const supabase = await createClient()
  const { data: history } = await supabase
    .from("listing_stage_history")
    .select("*, completed_by:profiles(first_name, last_name)")
    .eq("listing_id", listingId)
    .order("entered_at", { ascending: true })

  return { timeline: history }
}

export async function getListingTasksService(listingId: string) {
  const supabase = await createClient()
  const { data: tasks } = await supabase
    .from("tasks")
    .select("*")
    .eq("listing_id", listingId)
    .order("due_date", { ascending: true })

  return { tasks }
}

export async function completeListingTaskService(taskId: string) {
  const supabase = await createClient()
  await supabase
    .from("tasks")
    .update({ status: "completed", completed_at: new Date().toISOString() })
    .eq("id", taskId)

  revalidatePath("/dashboard")
  return { success: true }
}


// ── PASS 5 (NOT NULL contract): tasks requires brokerage_id +
// assigned_to_agent_id. Every handler below used to insert with only
// listing_id — ALWAYS rejected, so no listing-lifecycle task ever landed.
// The listing's own agent is the honest assignee; no agent → honest skip.
async function listingTaskContext(
  supabase: any,
  listingId: string,
): Promise<{ brokerageId: string; agentId: string } | null> {
  const { data } = await supabase
    .from("listings")
    .select("brokerage_id, agent_id") // listings.agent_id FKs agents(id)
    .eq("id", listingId)
    .maybeSingle()
  if (!data?.brokerage_id || !data?.agent_id) return null
  return { brokerageId: data.brokerage_id, agentId: data.agent_id }
}

export async function handleListingAppointmentBookedService(payload: any) {
  const supabase = await createClient()
  const { listing_id, contact_id } = payload
  const taskCtx = await listingTaskContext(supabase, listing_id)
  if (!taskCtx) return { success: false, error: "Listing has no agent/brokerage — tasks not created" }
  const tasks = [
    { title: "Prepare CMA for consultation", dueDays: 1 },
    { title: "Research comparable sales", dueDays: 1 },
    { title: "Review property info", dueDays: 0 },
  ]
  for (const task of tasks) {
    await supabase.from("tasks").insert({
      brokerage_id: taskCtx.brokerageId,
      assigned_to_agent_id: taskCtx.agentId,
      listing_id,
      contact_id,
      title: task.title,
      due_date: new Date(Date.now() + task.dueDays * 24 * 60 * 60 * 1000).toISOString(),
      priority: task.dueDays === 0 ? "urgent" : "high",
      auto_generated: true,
    })
  }
  return { success: true }
}

export async function handleListingAgreementSignedService(payload: any) {
  const supabase = await createClient()
  const { listing_id } = payload
  const taskCtx = await listingTaskContext(supabase, listing_id)
  if (!taskCtx) return { success: false, error: "Listing has no agent/brokerage — tasks not created" }
  const tasks = [
    { title: "Order professional photography", dueDays: 1 },
    { title: "Write compelling listing description", dueDays: 2 },
    { title: "Set up lockbox", dueDays: 3 },
    { title: "Input listing into MLS", dueDays: 3 },
    { title: "Create marketing materials", dueDays: 2 },
  ]
  for (const task of tasks) {
    await supabase.from("tasks").insert({
      brokerage_id: taskCtx.brokerageId,
      assigned_to_agent_id: taskCtx.agentId,
      listing_id,
      title: task.title,
      due_date: new Date(Date.now() + task.dueDays * 24 * 60 * 60 * 1000).toISOString(),
      priority: "high",
      auto_generated: true,
    })
  }
  return { success: true }
}

export async function handleListingLiveService(payload: any) {
  const supabase = await createClient()
  const { listing_id } = payload
  const taskCtx = await listingTaskContext(supabase, listing_id)
  if (!taskCtx) return { success: false, error: "Listing has no agent/brokerage — tasks not created" }
  const tasks = [
    { title: "Share on social media", dueDays: 0 },
    { title: "Send to sphere of influence", dueDays: 1 },
    { title: "Schedule first open house", dueDays: 3 },
    { title: "Create video tour", dueDays: 2 },
  ]
  for (const task of tasks) {
    await supabase.from("tasks").insert({
      brokerage_id: taskCtx.brokerageId,
      assigned_to_agent_id: taskCtx.agentId,
      listing_id,
      title: task.title,
      due_date: new Date(Date.now() + task.dueDays * 24 * 60 * 60 * 1000).toISOString(),
      priority: task.dueDays === 0 ? "urgent" : "high",
      auto_generated: true,
    })
  }
  return { success: true }
}

export async function handlePriceReductionService(payload: any) {
  const supabase = await createClient()
  const { listing_id } = payload
  const taskCtx = await listingTaskContext(supabase, listing_id)
  if (!taskCtx) return { success: false, error: "Listing has no agent/brokerage — tasks not created" }
  await supabase.from("tasks").insert({
    brokerage_id: taskCtx.brokerageId,
    assigned_to_agent_id: taskCtx.agentId,
    listing_id,
    title: "Update all marketing with new price",
    due_date: new Date().toISOString(),
    priority: "urgent",
    auto_generated: true,
  })
  return { success: true }
}

export async function handleOfferReceivedService(payload: any) {
  const supabase = await createClient()
  const { listing_id, offer_amount, buyer_name } = payload
  const taskCtx = await listingTaskContext(supabase, listing_id)
  if (!taskCtx) return { success: false, error: "Listing has no agent/brokerage — tasks not created" }
  await supabase.from("tasks").insert({
    brokerage_id: taskCtx.brokerageId,
    assigned_to_agent_id: taskCtx.agentId,
    listing_id,
    title: `Review offer from ${buyer_name || "buyer"} - $${(offer_amount || 0).toLocaleString()}`,
    due_date: new Date().toISOString(),
    priority: "urgent",
    auto_generated: true,
  })
  return { success: true }
}

export async function handleContingencyClearedService(payload: any) {
  const supabase = await createClient()
  const { listing_id, contingency_type } = payload
  const taskCtx = await listingTaskContext(supabase, listing_id)
  if (!taskCtx) return { success: false, error: "Listing has no agent/brokerage — tasks not created" }
  await supabase.from("tasks").insert({
    brokerage_id: taskCtx.brokerageId,
    assigned_to_agent_id: taskCtx.agentId,
    listing_id,
    title: `${contingency_type} contingency cleared - update transaction status`,
    due_date: new Date().toISOString(),
    priority: "high",
    auto_generated: true,
  })
  return { success: true }
}

export async function handleClosingApproachingService(payload: any) {
  const supabase = await createClient()
  const { listing_id } = payload
  const taskCtx = await listingTaskContext(supabase, listing_id)
  if (!taskCtx) return { success: false, error: "Listing has no agent/brokerage — tasks not created" }
  const tasks = [
    { title: "Confirm final walkthrough scheduled", dueDays: 0 },
    { title: "Verify closing disclosure sent", dueDays: 0 },
    { title: "Confirm wire instructions with title", dueDays: 1 },
  ]
  for (const task of tasks) {
    await supabase.from("tasks").insert({
      brokerage_id: taskCtx.brokerageId,
      assigned_to_agent_id: taskCtx.agentId,
      listing_id,
      title: task.title,
      due_date: new Date(Date.now() + task.dueDays * 24 * 60 * 60 * 1000).toISOString(),
      priority: "urgent",
      auto_generated: true,
    })
  }
  return { success: true }
}

export async function triggerReviewSequenceService(payload: any) {
  const supabase = await createClient()
  const { contact_id } = payload
  // review_requests is contact-keyed, one row per platform. listing_id /
  // scheduled_send_date / platforms were phantom columns.
  const platforms = ["google", "zillow", "facebook"]
  for (const platform of platforms) {
    await supabase.from("review_requests").insert({
      contact_id,
      platform,
      status: "scheduled",
    })
  }
  return { success: true }
}

export async function sendReviewRequestService(requestId: string, platform: string) {
  const supabase = await createClient()

  const { data: request } = await supabase
    .from("review_requests")
    .select("*, contact:contacts(*), transaction:listings(*)")
    .eq("id", requestId)
    .single()

  if (!request) return { success: false }

  const reviewLinks: Record<string, string> = {
    google: `https://g.page/r/YOUR_GOOGLE_PLACE_ID/review`,
    zillow: `https://zillow.com/profile/YOUR_AGENT_ID/reviews`,
    facebook: `https://facebook.com/YOUR_PAGE/reviews`,
  }

  const message = `Hi ${request.contact?.first_name}! Hope you're loving your new home at ${request.transaction?.address}! Your feedback means everything. Would you mind sharing your experience? Takes 60 seconds: ${reviewLinks[platform]}`

  if (request.contact?.phone) {
    // Route through the gate (consent/opt-out/DNC/quiet-hours/de-confliction) — no raw send.
    const { dispatchSms } = await import("@/lib/providers/dispatch")
    const smsResult = await dispatchSms({
      brokerageId: (request.contact as any).brokerage_id ?? "",
      to: request.contact.phone,
      message,
      contactId: request.contact_id,
      systemSource: "review_request",
    })
    if (!smsResult.success) {
      console.error("[listing-lifecycle] SMS send failed:", smsResult.error)
    }
  }

  await supabase
    .from("review_requests")
    .update({ sent_at: new Date().toISOString(), status: "sent" })
    .eq("id", requestId)

  return { success: true }
}
