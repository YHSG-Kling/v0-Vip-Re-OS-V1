"use server"

import { createClient } from "@/lib/supabase/server"
import { logListingAppointmentSet, logListingSigned, logListingLive } from "@/lib/events/event-helpers"
import { revalidatePath } from "next/cache"

// Re-export from listings.ts for backward compatibility
export { getListings, createListing } from "./listings"

// =====================================================
// LISTING LIFECYCLE SERVER ACTIONS
// All actions integrated with event system
// =====================================================

export async function scheduleListingAppointment(params: {
  listing_id: string
  contact_id: string
  appointment_date: string
  appointment_time: string
  notes?: string
}) {
  const supabase = await createClient()

  // Get current user
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  // Get user's brokerage
  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).single()

  if (!profile?.brokerage_id) throw new Error("No brokerage found")

  // Update listing with appointment details
  const { data, error } = await supabase
    .from("listings")
    .update({
      appointment_date: params.appointment_date,
      appointment_time: params.appointment_time,
      notes: params.notes,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.listing_id)
    .select()
    .single()

  if (error) throw error

  await logListingAppointmentSet({
    brokerage_id: profile.brokerage_id,
    user_id: user.id,
    listing_id: params.listing_id,
    contact_id: params.contact_id,
    appointment_date: `${params.appointment_date} ${params.appointment_time}`,
  })

  return { success: true, listing: data }
}

export async function markListingSigned(params: {
  listing_id: string
  listing_agreement_signed_date: string
  go_live_date: string
  commission_rate?: number
}) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).single()
  if (!profile?.brokerage_id) throw new Error("No brokerage found")

  // Update listing to "signed" stage
  const { data, error } = await supabase
    .from("listings")
    .update({
      stage: "signed",
      listing_agreement_signed_date: params.listing_agreement_signed_date,
      go_live_date: params.go_live_date,
      commission_rate: params.commission_rate,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.listing_id)
    .select()
    .single()

  if (error) throw error

  await logListingSigned({
    brokerage_id: profile.brokerage_id,
    user_id: user.id,
    listing_id: params.listing_id,
    go_live_date: params.go_live_date,
  })

  return { success: true, listing: data }
}

export async function markListingLive(params: { listing_id: string; mls_number: string; mls_link?: string }) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  const { data: profile } = await supabase.from("users").select("brokerage_id").eq("id", user.id).single()
  if (!profile?.brokerage_id) throw new Error("No brokerage found")

  // Update listing to "live" stage
  const { data, error } = await supabase
    .from("listings")
    .update({
      stage: "live",
      mls_number: params.mls_number,
      mls_link: params.mls_link,
      live_date: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.listing_id)
    .select()
    .single()

  if (error) throw error

  await logListingLive({
    brokerage_id: profile.brokerage_id,
    user_id: user.id,
    listing_id: params.listing_id,
    mls_number: params.mls_number,
  })

  // Auto-generate listing packet when listing goes live on MLS
  try {
    const { generateListingPacket } = await import("./ai-listing-packet")
    await generateListingPacket({
      listingId: params.listing_id,
      agentId: user.id,
      includeFlyer: true,
      includeDisclosures: true,
      includePropertyReports: true,
      includeBinderCopies: true,
    })
  } catch (packetError) {
    // Don't fail the main operation if packet generation fails
    console.error("[v0] Failed to auto-generate listing packet:", packetError)
  }

  return { success: true, listing: data }
}

export async function updateListingStage(params: { listing_id: string; stage: string; notes?: string }) {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) throw new Error("Not authenticated")

  // Update listing stage
  const { data, error } = await supabase
    .from("listings")
    .update({
      stage: params.stage,
      notes: params.notes,
      updated_at: new Date().toISOString(),
    })
    .eq("id", params.listing_id)
    .select()
    .single()

  if (error) throw error

  return { success: true, listing: data }
}

// =====================================================
// ADVANCED LISTING LIFECYCLE MANAGEMENT
// 17 Stages: Lead → Post-Close Lifetime Customer
// =====================================================

export async function advanceListingStage(listingId: string, toStage: string, agentId: string, notes?: string) {
  const supabase = await createClient()

  // Get current listing
  const { data: listing } = await supabase
    .from("listings")
    .select("*, listing_stage_history(*)")
    .eq("id", listingId)
    .single()

  if (!listing) {
    return { success: false, error: "Listing not found" }
  }

  // Close current stage
  if (listing.current_stage) {
    await supabase
      .from("listing_stage_history")
      .update({
        exited_at: new Date().toISOString(),
        duration_days: Math.floor(
          (new Date().getTime() - new Date(listing.entered_at || new Date()).getTime()) / (1000 * 60 * 60 * 24),
        ),
      })
      .eq("listing_id", listingId)
      .is("exited_at", null)
  }

  // Create new stage record
  await supabase.from("listing_stage_history").insert({
    listing_id: listingId,
    stage_name: toStage,
    entered_at: new Date().toISOString(),
    completed_by: agentId,
    notes,
  })

  // Update listing
  await supabase
    .from("listings")
    .update({
      current_stage: toStage,
      updated_at: new Date().toISOString(),
    })
    .eq("id", listingId)

  // Trigger stage-specific actions
  await triggerStageActions(listingId, toStage, agentId)

  revalidatePath(`/listings/${listingId}`)

  return { success: true, stage: toStage }
}

// Trigger automated actions based on stage
async function triggerStageActions(listingId: string, stage: string, agentId: string) {
  const supabase = await createClient()
  const { data: listing } = await supabase
    .from("listings")
    .select("*, seller:seller_id(*)")
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
      // Send congratulations video to seller
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

    case "mls_active":
      await createTask(agentId, listingId, "Schedule first open house", 3)
      await createTask(agentId, listingId, "Monitor showing activity daily", 1)
      // Auto-post to social media
      await postListingToSocial(listing.id)
      break

    case "open_house":
      await createTask(agentId, listingId, "Prepare open house materials", 1)
      await createTask(agentId, listingId, "Follow up with all attendees", 1)
      break

    case "offer_received":
      await createTask(agentId, listingId, "Review offer with seller", 0)
      await createTask(agentId, listingId, "Prepare counter if needed", 1)
      // Notify seller immediately
      await notifySeller(listing.seller_id, "offer_received")
      break

    case "under_contract":
      await createTask(agentId, listingId, "Create transaction folder", 0)
      await createTask(agentId, listingId, "Order home warranty", 1)
      await createTask(agentId, listingId, "Coordinate inspection access", 3)
      await createTask(agentId, listingId, "Update MLS to Pending", 0)
      // Congrats video to seller
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
      // Order closing gift (7 days before close)
      await scheduleClosingGift(listing.id)
      break

    case "closed":
      await createTask(agentId, listingId, "Deliver keys/garage codes", 0)
      await createTask(agentId, listingId, "Send closing congratulations", 0)
      // Track closing gift delivery
      await trackClosingGift(listing.id)
      // Schedule review requests (Day 3, 5, 7)
      await scheduleReviewRequests(listing.seller_id, listing.id)
      // Enroll in lifetime customer sequence
      await enrollLifetimeCustomer(listing.seller_id)
      break

    case "post_close":
      await createTask(agentId, listingId, "30-day check-in call", 30)
      await createTask(agentId, listingId, "90-day market update", 90)
      await createTask(agentId, listingId, "1-year home anniversary", 365)
      break
  }
}

// Helper: Create task
async function createTask(agentId: string, listingId: string, title: string, dueDays: number) {
  const supabase = await createClient()

  await supabase.from("tasks").insert({
    assigned_to: agentId,
    listing_id: listingId,
    title,
    due_date: new Date(Date.now() + dueDays * 24 * 60 * 60 * 1000).toISOString(),
    priority: dueDays === 0 ? "urgent" : dueDays <= 2 ? "high" : "medium",
    auto_generated: true,
  })
}

// Helper: Schedule closing gift (7 days before close)
async function scheduleClosingGift(listingId: string) {
  const supabase = await createClient()

  const { data: listing } = await supabase
    .from("listings")
    .select("estimated_close_date, seller_id, agent_id")
    .eq("id", listingId)
    .single()

  if (listing?.estimated_close_date) {
    const closeDate = new Date(listing.estimated_close_date)
    const orderDate = new Date(closeDate.getTime() - 7 * 24 * 60 * 60 * 1000)

    await supabase.from("closing_gifts").insert({
      listing_id: listingId,
      contact_id: listing.seller_id,
      agent_id: listing.agent_id,
      gift_description: "Closing gift basket",
      price_cents: 7500, // $75
      order_date: orderDate.toISOString(),
      delivery_date: closeDate.toISOString(),
      status: "scheduled",
    })
  }
}

// Helper: Track closing gift delivery
async function trackClosingGift(listingId: string) {
  const supabase = await createClient()

  const { data: gift } = await supabase.from("closing_gifts").select("*").eq("listing_id", listingId).single()

  if (gift && gift.status === "scheduled") {
    // Update status to ordered
    await supabase
      .from("closing_gifts")
      .update({ status: "ordered", ordered_at: new Date().toISOString() })
      .eq("id", gift.id)

    // Create follow-up task to confirm delivery
    await supabase.from("tasks").insert({
      assigned_to: gift.agent_id,
      listing_id: listingId,
      title: "Confirm closing gift delivered",
      due_date: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString(),
      priority: "medium",
    })
  }
}

// Helper: Schedule review requests (Day 3, 5, 7 after close)
async function scheduleReviewRequests(contactId: string, transactionId: string) {
  const supabase = await createClient()
  const reviewDays = [3, 5, 7]

  for (const days of reviewDays) {
    await supabase.from("review_requests").insert({
      transaction_id: transactionId,
      contact_id: contactId,
      scheduled_send_date: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
      platforms: ["google", "zillow", "facebook"],
      status: "scheduled",
    })
  }
}

// Helper: Enroll in lifetime customer plan
async function enrollLifetimeCustomer(contactId: string) {
  const supabase = await createClient()

  // Update contact status
  await supabase
    .from("contacts")
    .update({
      status: "past_client",
      lifetime_customer: true,
    })
    .eq("id", contactId)

  // Schedule anniversary touchpoints
  const touchpoints = [
    { days: 30, type: "check_in", message: "How are you settling in?" },
    { days: 90, type: "market_update", message: "Quarterly market report" },
    { days: 180, type: "home_maintenance", message: "Seasonal maintenance tips" },
    { days: 365, type: "anniversary", message: "Happy home anniversary!" },
  ]

  for (const touchpoint of touchpoints) {
    await supabase.from("past_client_touchpoints").insert({
      contact_id: contactId,
      touchpoint_type: touchpoint.type,
      scheduled_date: new Date(Date.now() + touchpoint.days * 24 * 60 * 60 * 1000).toISOString(),
      message_template: touchpoint.message,
    })
  }
}

// Generate seller video for stage
async function generateSellerVideo(listingId: string, videoType: string) {
  const supabase = await createClient()
  const { data: listing } = await supabase
    .from("listings")
    .select("*, seller:seller_id(*), agent:agent_id(*)")
    .eq("id", listingId)
    .single()

  if (!listing) return

  const scripts: Record<string, string> = {
    listing_signed: `Hi ${listing.seller?.first_name}! I'm so excited to get your home at ${listing.address} on the market. We're going to do an amazing job showcasing everything that makes it special. First step: professional photos scheduled for this week. I'll keep you posted every step of the way!`,
    under_contract: `Great news ${listing.seller?.first_name}! We're officially under contract on ${listing.address}! 🎉 I know the process from here can feel like a lot, but I'm going to handle everything and keep you in the loop. Next up: buyer's inspection. Let's do this!`,
    closing_congrats: `Congratulations ${listing.seller?.first_name}! Today's the day - ${listing.address} is officially sold! 🏡 It's been an honor helping you through this journey. Enjoy your next chapter, and remember - I'm always here if you need anything!`,
  }

  const script = scripts[videoType] || ""

  // Create video script record
  const { data: scriptRecord } = await supabase
    .from("video_scripts")
    .insert({
      contact_id: listing.seller_id,
      agent_id: listing.agent_id,
      script_text: script,
      script_purpose: videoType,
      approval_status: "pending",
    })
    .select()
    .single()

  if (scriptRecord) {
    // Notify agent to approve
    await supabase.from("notifications").insert({
      recipient_id: listing.agent_id,
      notification_type: "video_approval_needed",
      title: "Video Script Ready for Approval",
      message: `Review ${videoType} video script for ${listing.seller?.first_name}`,
      related_entity_type: "video_script",
      related_entity_id: scriptRecord.id,
    })
  }
}

// Notify seller helper
async function notifySeller(sellerId: string, notificationType: string) {
  const supabase = await createClient()

  const messages: Record<string, string> = {
    offer_received: "Great news! We just received an offer on your property. I'll review it and call you shortly.",
  }

  await supabase.from("notifications").insert({
    recipient_id: sellerId,
    notification_type: notificationType,
    title: "Important Update",
    message: messages[notificationType] || "You have a new update.",
  })
}

// Post listing to social media helper
async function postListingToSocial(listingId: string) {
  const supabase = await createClient()
  
  // Get listing details
  const { data: listing } = await supabase
    .from("listings")
    .select("*, agent_id, address, price, bedrooms, bathrooms, square_footage, photos")
    .eq("id", listingId)
    .single()
  
  if (!listing || !listing.agent_id) {
    console.warn("[listing-lifecycle] Cannot post to social - listing or agent not found:", listingId)
    return
  }
  
  // Get agent's connected social accounts
  const { data: accounts } = await supabase
    .from("social_media_accounts")
    .select("*")
    .eq("agent_id", listing.agent_id)
    .eq("is_active", true)
  
  if (!accounts || accounts.length === 0) {
    console.log("[listing-lifecycle] No connected social accounts for agent:", listing.agent_id)
    return
  }
  
  // Create scheduled posts for each platform
  const platforms = accounts.map(a => a.platform)
  
  for (const platform of platforms) {
    await supabase.from("social_posts").insert({
      agent_id: listing.agent_id,
      listing_id: listingId,
      platform,
      post_type: "new_listing",
      content: `Just Listed! ${listing.address} - $${listing.price?.toLocaleString() || 'Call for price'} | ${listing.bedrooms || 0} BD | ${listing.bathrooms || 0} BA | ${listing.square_footage?.toLocaleString() || 'N/A'} sqft`,
      media_urls: listing.photos || [],
      status: "scheduled",
      scheduled_for: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(), // 2 hours from now
    })
  }
  
  console.log(`[listing-lifecycle] Scheduled ${platforms.length} social posts for listing:`, listingId)
}

// Get listing timeline
export async function getListingTimeline(listingId: string) {
  const supabase = await createClient()

  const { data: history } = await supabase
    .from("listing_stage_history")
    .select("*, completed_by:profiles(first_name, last_name)")
    .eq("listing_id", listingId)
    .order("entered_at", { ascending: true })

  return { timeline: history }
}

// Get listing tasks
export async function getListingTasks(listingId: string) {
  const supabase = await createClient()

  const { data: tasks } = await supabase
    .from("tasks")
    .select("*")
    .eq("listing_id", listingId)
    .order("due_date", { ascending: true })

  return { tasks }
}

// Complete listing task
export async function completeListingTask(taskId: string) {
  const supabase = await createClient()

  await supabase
    .from("tasks")
    .update({
      status: "completed",
      completed_at: new Date().toISOString(),
    })
    .eq("id", taskId)

  revalidatePath("/dashboard")

  return { success: true }
}

// =====================================================
// EVENT HANDLERS - Called by orchestrator
// =====================================================

export async function handleListingAppointmentBooked(payload: any) {
  const supabase = await createClient()
  const { listing_id, contact_id, appointment_date } = payload

  // Create prep tasks
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

export async function handleListingAgreementSigned(payload: any) {
  const supabase = await createClient()
  const { listing_id, go_live_date } = payload

  // Create go-live checklist tasks
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

export async function handleListingLive(payload: any) {
  const supabase = await createClient()
  const { listing_id, mls_number } = payload

  // Create marketing tasks
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

export async function handlePriceReduction(payload: any) {
  const supabase = await createClient()
  const { listing_id, old_price, new_price } = payload

  // Notify seller and create marketing update tasks
  await supabase.from("tasks").insert({
    listing_id,
    title: "Update all marketing with new price",
    due_date: new Date().toISOString(),
    priority: "urgent",
    auto_generated: true,
  })

  return { success: true }
}

export async function handleOfferReceived(payload: any) {
  const supabase = await createClient()
  const { listing_id, offer_amount, buyer_name } = payload

  // Create urgent review task
  await supabase.from("tasks").insert({
    listing_id,
    title: `Review offer from ${buyer_name || "buyer"} - $${(offer_amount || 0).toLocaleString()}`,
    due_date: new Date().toISOString(),
    priority: "urgent",
    auto_generated: true,
  })

  return { success: true }
}

export async function handleContingencyCleared(payload: any) {
  const supabase = await createClient()
  const { listing_id, contingency_type } = payload

  // Create follow-up task
  await supabase.from("tasks").insert({
    listing_id,
    title: `${contingency_type} contingency cleared - update transaction status`,
    due_date: new Date().toISOString(),
    priority: "high",
    auto_generated: true,
  })

  return { success: true }
}

export async function handleClosingApproaching(payload: any) {
  const supabase = await createClient()
  const { listing_id, closing_date, days_until } = payload

  // Create closing prep tasks
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

export async function triggerReviewSequence(payload: any) {
  const supabase = await createClient()
  const { listing_id, contact_id } = payload

  // Schedule review requests for days 3, 5, 7
  const reviewDays = [3, 5, 7]
  for (const days of reviewDays) {
    await supabase.from("review_requests").insert({
      listing_id,
      contact_id,
      scheduled_send_date: new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString(),
      platforms: ["google", "zillow", "facebook"],
      status: "scheduled",
    })
  }

  return { success: true }
}

// Export for orchestrator
export { scheduleClosingGift }

// Send review request
export async function sendReviewRequest(requestId: string, platform: string) {
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

  // Send SMS via external service
  if (request.contact?.phone) {
    const { sendTwilioSMS } = await import("./external-services")
    const smsResult = await sendTwilioSMS({
      to: request.contact.phone,
      message,
      contactId: request.contact_id,
    })
    if (!smsResult.success) {
      console.error("[listing-lifecycle] SMS send failed:", smsResult.error)
    }
  }

  // Update request
  await supabase
    .from("review_requests")
    .update({
      request_sent_at: new Date().toISOString(),
      platform_sent: platform,
    })
    .eq("id", requestId)

  return { success: true }
}
