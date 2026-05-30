"use server"

/**
 * Outside-agent showing request — public submission path for buyer agents
 * at OTHER brokerages who want to request a showing on one of our listings.
 * They don't have portal access, so this lives on the listing's public page.
 *
 * Creates a showing_requests row with:
 *   - listing_id set (this is always an in-house listing)
 *   - contact_id NULL (the buyer is not in our system; outside agent
 *     represents them)
 *   - source = 'external_agent'
 *   - buyer_agent_* fields populated from the form
 *
 * Notifies the in-house listing agent + the seller in their portal exactly
 * the same way the in-portal request flow does.
 */

import { createServiceClient } from "@/lib/supabase/service"

export interface OutsideAgentShowingInput {
  listingId: string
  // Outside buyer-agent identity
  buyerAgentName:    string
  buyerAgentEmail:   string
  buyerAgentPhone:   string
  buyerAgentLicense?: string
  buyerAgentBrokerage?: string
  // Showing request details
  preferredDate:     string  // YYYY-MM-DD
  preferredStartTime: string // HH:MM
  preferredEndTime?:  string  // HH:MM
  message?:          string
  // Optional buyer name (no email/phone — outside agent owns that contact)
  buyerName?:        string
}

export async function submitOutsideAgentShowingRequest(
  input: OutsideAgentShowingInput,
): Promise<{ success: boolean; error?: string; requestId?: string }> {
  // Basic validation — these come from a public form, must not trust shape.
  if (!input.listingId || !input.buyerAgentName || !input.buyerAgentEmail) {
    return { success: false, error: "Agent name and email are required" }
  }
  if (!input.preferredDate || !input.preferredStartTime) {
    return { success: false, error: "Preferred date and time are required" }
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.buyerAgentEmail)) {
    return { success: false, error: "Invalid email address" }
  }

  const supabase = createServiceClient()

  // Resolve the listing's brokerage so we can tag the request + notify the
  // right people. Don't trust client-provided brokerage info.
  const { data: listing } = await supabase
    .from("listings")
    .select("id, brokerage_id, agent_id, seller_contact_id, address, city, state")
    .eq("id", input.listingId)
    .maybeSingle()
  if (!listing || !listing.brokerage_id) {
    return { success: false, error: "Listing not found" }
  }

  // Compute a 30-min default end time if the form didn't supply one
  const startHHMM = input.preferredStartTime
  const endHHMM = input.preferredEndTime ?? (() => {
    const [h, m] = startHHMM.split(":").map(Number)
    const total = (h ?? 0) * 60 + (m ?? 0) + 30
    const eh = Math.floor(total / 60) % 24
    const em = total % 60
    return `${String(eh).padStart(2,"0")}:${String(em).padStart(2,"0")}`
  })()

  const propertyAddress = [listing.address, listing.city, listing.state]
    .filter(Boolean).join(", ")
  const buyerLabel = input.buyerName || "(name withheld by buyer agent)"

  const messageBody = [
    `Outside-agent showing request from ${input.buyerAgentName}`,
    input.buyerAgentBrokerage ? ` (${input.buyerAgentBrokerage})` : "",
    `${input.buyerAgentLicense ? ` — License #${input.buyerAgentLicense}` : ""}.`,
    ` Buyer: ${buyerLabel}.`,
    input.message ? ` Notes: ${input.message}` : "",
  ].join("")

  const { data: showing, error: insertError } = await supabase
    .from("showing_requests")
    .insert({
      listing_id:           listing.id,
      brokerage_id:         listing.brokerage_id,
      contact_id:           null,                 // outside agent represents the buyer
      source:               "external_agent",
      buyer_agent_name:     input.buyerAgentName,
      buyer_agent_email:    input.buyerAgentEmail,
      buyer_agent_phone:    input.buyerAgentPhone,
      buyer_agent_license:  input.buyerAgentLicense ?? null,
      property_address:     propertyAddress,
      requested_date:       input.preferredDate,
      requested_start_time: `${startHHMM}:00`,
      requested_end_time:   `${endHHMM}:00`,
      message:              messageBody,
      status:               "pending",
    })
    .select("id")
    .single()

  if (insertError || !showing) {
    return { success: false, error: insertError?.message ?? "Failed to submit request" }
  }

  // Notify the in-house listing agent (via agents → users.id resolution).
  if (listing.agent_id) {
    try {
      const { data: agentRow } = await supabase
        .from("agents")
        .select("user_id")
        .eq("id", listing.agent_id)
        .maybeSingle()
      if (agentRow?.user_id) {
        await supabase.from("notifications").insert({
          user_id:      agentRow.user_id,
          brokerage_id: listing.brokerage_id,
          type:         "showing.request.listing.external_agent",
          title:        "Showing request from outside agent",
          body:         `${input.buyerAgentName}${input.buyerAgentBrokerage ? ` (${input.buyerAgentBrokerage})` : ""} wants to show ${propertyAddress}. Confirm or send alternatives.`,
          entity_type:  "showing_request",
          entity_id:    showing.id,
          priority:     "high",
          channel:      "in_app",
        })
      }
    } catch { /* non-critical */ }
  }

  // Surface to the seller's portal too.
  if (listing.seller_contact_id) {
    try {
      await supabase.from("notifications").insert({
        contact_id:   listing.seller_contact_id,
        brokerage_id: listing.brokerage_id,
        type:         "showing.request.seller",
        title:        "Showing request on your home",
        body:         `An outside agent wants to show ${propertyAddress} to their buyer. Your agent will follow up.`,
        entity_type:  "showing_request",
        entity_id:    showing.id,
        priority:     "high",
        channel:      "in_app",
      })
    } catch { /* non-critical */ }
  }

  return { success: true, requestId: showing.id }
}
