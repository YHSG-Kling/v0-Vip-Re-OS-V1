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

  const { data: calEvent, error: calErr } = await supabase
    .from("calendar_events")
    .insert({
      brokerage_id: brokerageId,
      entity_type: "listing",
      entity_id: params.listing_id,
      event_type: "listing_appointment",
      start_at: appointmentAt,
      is_system_generated: false,
      metadata: { contact_id: params.contact_id, agent_id: agentId, notes: params.notes ?? null },
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

// markListingSignedService + markListingLiveService were RETIRED. They duplicated the canonical stage
// spine (advanceListingStageService → triggerStageActions) but fired orphaned underscore events
// (logListingSigned/logListingLive) that matched NO dotted dispatcher handler, so their post-sign/live
// tasks never ran anyway. The UI drives every stage change through advanceListingStage
// (triggerStageActions owns the listing_agreement_signed + mls_active cases, and the MLS packet queue
// moved into the mls_active case above). No remaining caller.

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

  await triggerStageActions(listingId, toStage, agentId)

  revalidatePath(`/listings/${listingId}`)

  return { success: true, stage: toStage }
}

async function triggerStageActions(listingId: string, stage: string, agentId: string) {
  const supabase = await createClient()
  const { data: listing } = await supabase
    .from("listings")
    .select("*, seller:seller_contact_id(first_name, last_name)")
    .eq("id", listingId)
    .single()

  if (!listing) return

  switch (stage) {
    case "appointment_scheduled":
      await createTask(agentId, listingId, "Prepare CMA for consultation", 1)
      await createTask(agentId, listingId, "Research comparable sales", 1)
      break
    case "cma_prepared":
      await createTask(agentId, listingId, "Schedule listing presentation", 2)
      break
    case "listing_agreement_signed":
      await createTask(agentId, listingId, "Order professional photos", 1)
      await createTask(agentId, listingId, "Create MLS listing draft", 2)
      await createTask(agentId, listingId, "Order sign installation", 3)
      await generateSellerVideo(listing.id, "listing_signed")
      break
    case "pre_listing_ops":
      await createTask(agentId, listingId, "Review photos and select best", 2)
      await createTask(agentId, listingId, "Write compelling listing description", 2)
      await createTask(agentId, listingId, "Input listing into MLS", 3)
      break
    case "coming_soon":
      await createTask(agentId, listingId, "Schedule social media posts", 1)
      await createTask(agentId, listingId, 'Send "coming soon" to agent network', 1)
      await createTask(agentId, listingId, "Activate MLS listing in 48 hours", 2)
      break
    // NOTE: this switch uses a LEGACY lowercase stage vocabulary that no longer matches the canonical
    // UPPERCASE lifecycle stages, so it currently never fires from the UI (flagged for a dedicated
    // reconciliation pass). The high-value automations (prep chain, MLS packet) are fired on the
    // canonical stage names in app/actions/listing-lifecycle.ts::fireStageAutomations until then.
    case "mls_active":
      await createTask(agentId, listingId, "Schedule first open house", 3)
      await createTask(agentId, listingId, "Monitor showing activity daily", 1)
      await postListingToSocial(listing.id)
      break
    case "open_house":
      await createTask(agentId, listingId, "Prepare open house materials", 1)
      await createTask(agentId, listingId, "Follow up with all attendees", 1)
      break
    case "offer_received":
      await createTask(agentId, listingId, "Review offer with seller", 0)
      await createTask(agentId, listingId, "Prepare counter if needed", 1)
      await notifySeller(listing.seller_contact_id, "offer_received")
      break
    case "under_contract":
      await createTask(agentId, listingId, "Create transaction folder", 0)
      await createTask(agentId, listingId, "Order home warranty", 1)
      await createTask(agentId, listingId, "Coordinate inspection access", 3)
      await createTask(agentId, listingId, "Update MLS to Pending", 0)
      await generateSellerVideo(listing.id, "under_contract")
      break
    case "contingent":
      await createTask(agentId, listingId, "Review inspection report with seller", 1)
      await createTask(agentId, listingId, "Negotiate repairs if needed", 2)
      await createTask(agentId, listingId, "Monitor appraisal progress", 3)
      break
    case "pending":
      await createTask(agentId, listingId, "Confirm final walkthrough date", 3)
      await createTask(agentId, listingId, "Verify closing disclosure sent", 1)
      await createTask(agentId, listingId, "Confirm wire instructions with title", 2)
      await scheduleClosingGift(listing.id)
      break
    case "closed":
      await createTask(agentId, listingId, "Deliver keys/garage codes", 0)
      await createTask(agentId, listingId, "Send closing congratulations", 0)
      await trackClosingGift(listing.id)
      await scheduleReviewRequests(listing.seller_contact_id, listing.id)
      await enrollLifetimeCustomer(listing.seller_contact_id, listing.brokerage_id, agentId)
      break
    case "post_close":
      await createTask(agentId, listingId, "30-day check-in call", 30)
      await createTask(agentId, listingId, "90-day market update", 90)
      await createTask(agentId, listingId, "1-year home anniversary", 365)
      break
  }
}

async function createTask(agentId: string, listingId: string, title: string, dueDays: number) {
  const supabase = await createClient()
  await supabase.from("tasks").insert({
    assigned_to_agent_id: agentId,
    listing_id: listingId,
    title,
    due_date: new Date(Date.now() + dueDays * 24 * 60 * 60 * 1000).toISOString(),
    priority: dueDays === 0 ? "urgent" : dueDays <= 2 ? "high" : "medium",
    auto_generated: true,
  })
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

async function trackClosingGift(listingId: string) {
  const supabase = await createClient()
  const { data: gift } = await supabase.from("closing_gifts").select("*").eq("listing_id", listingId).single()

  if (gift && gift.status === "scheduled") {
    await supabase
      .from("closing_gifts")
      .update({ status: "ordered", ordered_at: new Date().toISOString() })
      .eq("id", gift.id)

    await supabase.from("tasks").insert({
      assigned_to_agent_id: gift.agent_id,
      listing_id: listingId,
      title: "Confirm closing gift delivered",
      due_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      priority: "medium",
    })
  }
}

async function scheduleReviewRequests(contactId: string, _transactionId: string) {
  const supabase = await createClient()
  // review_requests is contact-keyed, one row per platform (no transaction_id /
  // scheduled_send_date columns; platform is singular). Matches lib/kernel/reputation.ts.
  const platforms = ["google", "zillow", "facebook"]
  for (const platform of platforms) {
    await supabase.from("review_requests").insert({
      contact_id: contactId,
      platform,
      status: "scheduled",
    })
  }
}

async function enrollLifetimeCustomer(contactId: string, brokerageId: string, userId: string) {
  const supabase = await createClient()
  await supabase
    .from("contacts")
    .update({ status: "lifetime_customer" })
    .eq("id", contactId)

  // agent_id FK targets agents.id, not users.id — resolve the caller's agent row.
  const { data: agentRow } = await supabase
    .from("agents")
    .select("id")
    .eq("user_id", userId)
    .maybeSingle()
  if (!agentRow?.id) {
    console.error("[listing-lifecycle] enrollLifetimeCustomer: no agent row for user", userId)
    return
  }

  // touchpoint_type CHECK-valid values; scheduled_date NOT NULL (date); brokerage_id+agent_id
  // NOT NULL; no message_template column → engagement_data jsonb.
  const touchpoints = [
    { days: 30,  type: "post_close_30_day", channel: "sms",   message: "How are you settling in?" },
    { days: 90,  type: "market_update",     channel: "email", message: "Quarterly market report" },
    { days: 180, type: "custom",            channel: "email", message: "Seasonal maintenance tips" },
    { days: 365, type: "home_anniversary",  channel: "video", message: "Happy home anniversary!" },
  ]

  for (const touchpoint of touchpoints) {
    await supabase.from("lifetime_customer_touchpoints").insert({
      brokerage_id:    brokerageId,
      contact_id:      contactId,
      agent_id:        agentRow.id,
      touchpoint_type: touchpoint.type,
      channel:         touchpoint.channel,
      scheduled_date:  new Date(Date.now() + touchpoint.days * 24 * 60 * 60 * 1000).toISOString().split("T")[0],
      status:          "scheduled",
      engagement_data: { message: touchpoint.message },
    })
  }
}

async function generateSellerVideo(listingId: string, videoType: string) {
  const supabase = await createClient()
  const { data: listing } = await supabase
    .from("listings")
    .select("*, seller:seller_contact_id(first_name, last_name), agent:agent_id(first_name, last_name)")
    .eq("id", listingId)
    .single()

  if (!listing) return

  const scripts: Record<string, string> = {
    listing_signed: `Hi ${listing.seller?.first_name}! I'm so excited to get your home at ${listing.address} on the market. We're going to do an amazing job showcasing everything that makes it special. First step: professional photos scheduled for this week. I'll keep you posted every step of the way!`,
    under_contract: `Great news ${listing.seller?.first_name}! We're officially under contract on ${listing.address}! I know the process from here can feel like a lot, but I'm going to handle everything and keep you in the loop. Next up: buyer's inspection. Let's do this!`,
    closing_congrats: `Congratulations ${listing.seller?.first_name}! Today's the day - ${listing.address} is officially sold! It's been an honor helping you through this journey. Enjoy your next chapter, and remember - I'm always here if you need anything!`,
  }

  const script = scripts[videoType] || ""

  const { data: scriptRecord } = await supabase
    .from("video_scripts")
    .insert({
      contact_id: listing.seller_contact_id,
      agent_id: listing.agent_id,
      script_text: script,
      script_purpose: videoType,
      approval_status: "pending",
    })
    .select()
    .single()

  if (scriptRecord) {
    await supabase.from("notifications").insert({
      user_id: listing.agent_id,
      type: "video_approval_needed",
      title: "Video Script Ready for Approval",
      body: `Review ${videoType} video script for ${listing.seller?.first_name}`,
      entity_type: "video_script",
      entity_id: scriptRecord.id,
    })
  }
}

async function notifySeller(sellerId: string, notificationType: string) {
  const supabase = await createClient()
  const messages: Record<string, string> = {
    offer_received: "Great news! We just received an offer on your property. I'll review it and call you shortly.",
  }
  // Seller is a CONTACT — notifications carries contact_id for portal surfacing.
  await supabase.from("notifications").insert({
    contact_id: sellerId,
    type: notificationType,
    title: "Important Update",
    body: messages[notificationType] || "You have a new update.",
  })
}

async function postListingToSocial(listingId: string) {
  const supabase = await createClient()
  const { data: listing } = await supabase
    .from("listings")
    .select("*, agent_id, address, list_price, bedrooms, bathrooms, sqft")
    .eq("id", listingId)
    .single()

  if (!listing?.agent_id) return

  const { data: accounts } = await supabase
    .from("social_media_accounts")
    .select("*")
    .eq("agent_id", listing.agent_id)
    .eq("is_active", true)

  if (!accounts || accounts.length === 0) return

  for (const account of accounts) {
    await supabase.from("social_posts").insert({
      agent_id: listing.agent_id,
      listing_id: listingId,
      platform: account.platform,
      post_type: "new_listing",
      content: `Just Listed! ${listing.address} - $${listing.list_price?.toLocaleString() || "Call for price"} | ${listing.bedrooms || 0} BD | ${listing.bathrooms || 0} BA | ${listing.sqft?.toLocaleString() || "N/A"} sqft`,
      media_urls: [], // photos are in separate listing_media table
      status: "scheduled",
      scheduled_for: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
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

export async function handleListingAppointmentBookedService(payload: any) {
  const supabase = await createClient()
  const { listing_id, contact_id } = payload
  const tasks = [
    { title: "Prepare CMA for consultation", dueDays: 1 },
    { title: "Research comparable sales", dueDays: 1 },
    { title: "Review property info", dueDays: 0 },
  ]
  for (const task of tasks) {
    await supabase.from("tasks").insert({
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
  const tasks = [
    { title: "Order professional photography", dueDays: 1 },
    { title: "Write compelling listing description", dueDays: 2 },
    { title: "Set up lockbox", dueDays: 3 },
    { title: "Input listing into MLS", dueDays: 3 },
    { title: "Create marketing materials", dueDays: 2 },
  ]
  for (const task of tasks) {
    await supabase.from("tasks").insert({
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
  const tasks = [
    { title: "Share on social media", dueDays: 0 },
    { title: "Send to sphere of influence", dueDays: 1 },
    { title: "Schedule first open house", dueDays: 3 },
    { title: "Create video tour", dueDays: 2 },
  ]
  for (const task of tasks) {
    await supabase.from("tasks").insert({
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
  await supabase.from("tasks").insert({
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
  await supabase.from("tasks").insert({
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
  await supabase.from("tasks").insert({
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
  const tasks = [
    { title: "Confirm final walkthrough scheduled", dueDays: 0 },
    { title: "Verify closing disclosure sent", dueDays: 0 },
    { title: "Confirm wire instructions with title", dueDays: 1 },
  ]
  for (const task of tasks) {
    await supabase.from("tasks").insert({
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
