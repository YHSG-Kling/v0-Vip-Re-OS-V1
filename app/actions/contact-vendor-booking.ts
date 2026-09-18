"use server"

/**
 * Contact-initiated vendor booking — buyer/seller/lifetime customer
 * requests a vendor service from their portal. Agent gets a notification
 * for review/approval before the vendor is engaged.
 *
 * Flow:
 *   1. Contact taps "Request Booking" on a vendor card in /portal/[id]/vendors
 *   2. Form: service description + preferred time window + message
 *   3. We insert vendor_bookings row with status='booked' and
 *      request_origin='contact'
 *   4. Agent gets notification + activity logged on contact timeline
 *   5. Agent reviews in transaction or contact view; can confirm or decline
 */

import { createClient } from "@/lib/supabase/server"
import { createServiceClient } from "@/lib/supabase/service"

export interface ContactVendorRequestInput {
  contactId: string
  vendorId: string
  serviceType: string
  message?: string
  preferredTimeWindow?: string
}

export async function requestContactVendorBooking(
  input: ContactVendorRequestInput
): Promise<{ success: boolean; bookingId?: string; error?: string }> {
  // Auth gate — caller must be either the contact themselves (portal session)
  // or an agent/admin in the same brokerage as the contact. Previously this
  // function was wide open — any caller could trigger vendor bookings under
  // any contact.
  const authClient = await createClient()
  const { data: { user: authUser } } = await authClient.auth.getUser()
  if (!authUser) return { success: false, error: "Unauthorized" }

  const svc = createServiceClient()

  // Resolve contact + agent + brokerage + active transaction (best-effort)
  const { data: contact } = await svc
    .from("contacts")
    .select("id, brokerage_id, agent_id, first_name, last_name, contact_user_id, email")
    .eq("id", input.contactId)
    .maybeSingle()

  if (!contact) return { success: false, error: "Contact not found" }

  // Access gate:
  //  - Contact themselves: contact_user_id matches OR email matches
  //  - Agent / admin: caller's brokerage matches contact's brokerage
  const isContactSelf =
    contact.contact_user_id === authUser.id ||
    (contact.email && authUser.email && contact.email.toLowerCase() === authUser.email.toLowerCase())

  let isAgentInBrokerage = false
  if (!isContactSelf) {
    const { data: callerRow } = await svc
      .from("users")
      .select("brokerage_id")
      .eq("id", authUser.id)
      .maybeSingle()
    isAgentInBrokerage = !!callerRow?.brokerage_id && callerRow.brokerage_id === contact.brokerage_id
  }

  if (!isContactSelf && !isAgentInBrokerage) {
    return { success: false, error: "Forbidden" }
  }

  // Find an active transaction for the contact (optional — booking allowed without)
  const { data: tx } = await svc
    .from("transactions")
    .select("id")
    .or(`buyer_contact_id.eq.${input.contactId},seller_contact_id.eq.${input.contactId},contact_id.eq.${input.contactId}`)
    .not("status", "in", "(cancelled,closed)")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  // Insert the booking request
  const { data: booking, error } = await svc
    .from("vendor_bookings")
    .insert({
      vendor_id: input.vendorId,
      brokerage_id: contact.brokerage_id,
      transaction_id: tx?.id ?? null,
      contact_id: input.contactId,
      service_type: input.serviceType,
      status: "booked",  // initial state; agent confirms → "confirmed"
      request_origin: "contact",
      request_message: input.message ?? null,
      preferred_time_window: input.preferredTimeWindow ?? null,
      booked_at: new Date().toISOString(),
    })
    .select("id")
    .single()

  if (error || !booking) {
    return { success: false, error: error?.message ?? "Failed to create booking" }
  }

  // Resolve the agent's user_id so we can notify them
  let agentUserId: string | null = null
  if (contact.agent_id) {
    const { data: agentRow } = await svc
      .from("agents")
      .select("user_id")
      .eq("id", contact.agent_id)
      .maybeSingle()
    agentUserId = agentRow?.user_id ?? null
  }

  // Vendor name for richer notification text
  const { data: vendor } = await svc
    .from("vendors")
    .select("name, category")
    .eq("id", input.vendorId)
    .maybeSingle()

  const contactName = [contact.first_name, contact.last_name].filter(Boolean).join(" ") || "Your client"
  const vendorLabel = vendor?.name ?? "a vendor"

  // Activity on contact timeline. This row is what tells the agent their client
  // asked for a vendor at all — the booking row alone is not on the timeline.
  const { error: vendorRequestActivityError } = await svc.from("activities").insert({
    contact_id: input.contactId,
    brokerage_id: contact.brokerage_id,
    agent_user_id: agentUserId,
    activity_type: "vendor_request_from_contact",
    description: `${contactName} requested booking with ${vendorLabel} (${input.serviceType})`,
    metadata: {
      booking_id: booking.id,
      vendor_id: input.vendorId,
      message: input.message,
      preferred_time_window: input.preferredTimeWindow,
    },
  })
  if (vendorRequestActivityError) {
    console.error("[contactVendorBooking] vendor_request_from_contact activity REJECTED — the booking exists but the contact timeline will not show it:", vendorRequestActivityError.message)
  }

  // Notify the agent
  if (agentUserId) {
    await svc.from("notifications").insert({
      user_id: agentUserId,
      brokerage_id: contact.brokerage_id,
      title: "🛠️ Vendor request from your client",
      body: `${contactName} requested ${vendorLabel} for ${input.serviceType}. Review + approve.`,
      type: "vendor_request",
      entity_type: "vendor_booking",
      entity_id: booking.id,
      priority: "medium",
      is_read: false,
    })
  }

  // VENDOR LOOP — propose a client vendor-intro into the gate (Deal Coordinator).
  // Best-effort: a deliverable proposal never fails the booking request.
  try {
    const { produceVendorIntro } = await import("@/lib/agents/vendor-loop-producer")
    await produceVendorIntro(contact.brokerage_id, booking.id, svc)
  } catch (err) {
    console.error("[contact-vendor-booking] vendor intro proposal failed:", err)
  }

  return { success: true, bookingId: booking.id }
}

/**
 * Client rates a completed vendor booking from their portal — the DOOR the
 * post-completion review request (lib/agents/vendor-loop-producer.ts ::
 * buildVendorReviewRequest) points at. Before this action existed the message
 * asked the client for "a 1–5" with nowhere to put it, and
 * vendor_ratings.avg_client_rating aggregated an always-empty set.
 *
 * ONLY the contact themselves may write client_rating — that is the second
 * rating column's whole point (agent_rating is the agent's verdict, written by
 * app/actions/vendor-marketplace.ts). So unlike requestContactVendorBooking
 * above, there is NO agent-in-brokerage branch here: an agent rating a vendor
 * on the client's behalf would launder one voice into two.
 */
export async function rateVendorBookingAsClient(input: {
  contactId: string
  bookingId: string
  rating: number
}): Promise<{ success: boolean; error?: string }> {
  // Validate the rating BEFORE any read: integer 1-5, nothing else.
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) {
    return { success: false, error: "Rating must be a whole number from 1 to 5" }
  }

  // Auth gate — same pattern as requestContactVendorBooking above.
  const authClient = await createClient()
  const { data: { user: authUser } } = await authClient.auth.getUser()
  if (!authUser) return { success: false, error: "Unauthorized" }

  const svc = createServiceClient()

  const { data: contact, error: contactError } = await svc
    .from("contacts")
    .select("id, brokerage_id, contact_user_id, email")
    .eq("id", input.contactId)
    .maybeSingle()
  if (contactError) {
    console.error("[contactVendorBooking] rate: contact read refused:", contactError.message)
    return { success: false, error: "Could not verify access" }
  }
  if (!contact) return { success: false, error: "Contact not found" }

  // Access gate — the isContactSelf test from requestContactVendorBooking,
  // verbatim. Deliberately NOT followed by the agent-in-brokerage fallback.
  const isContactSelf =
    contact.contact_user_id === authUser.id ||
    (contact.email && authUser.email && contact.email.toLowerCase() === authUser.email.toLowerCase())

  if (!isContactSelf) {
    return { success: false, error: "Forbidden" }
  }

  // Booking read scoped by BOTH id and the caller's OWN contact_id — a booking
  // id from another contact (or another tenant) must resolve to nothing rather
  // than to someone else's service. §3: error destructured and read.
  const { data: booking, error: bookingError } = await svc
    .from("vendor_bookings")
    .select("id, vendor_id, brokerage_id, status, client_rating")
    .eq("id", input.bookingId)
    .eq("contact_id", input.contactId)
    .maybeSingle()
  if (bookingError) {
    console.error("[contactVendorBooking] rate: booking read refused:", bookingError.message)
    return { success: false, error: "Could not load booking" }
  }
  if (!booking) return { success: false, error: "Booking not found" }

  if (booking.status !== "completed") {
    return { success: false, error: "You can rate a service once it's completed" }
  }
  if (booking.client_rating != null) {
    return { success: false, error: "You've already rated this service" }
  }

  // Counted update (§3): a zero-row UPDATE resolves exactly like success, so the
  // write re-states every predicate — id, contact_id, completed, still unrated
  // (the .is() also closes the race where two tabs submit at once) — and counts
  // what came back. Zero rows here IS a refusal, not a quiet no-op.
  const { data: rated, error: rateError } = await svc
    .from("vendor_bookings")
    .update({ client_rating: input.rating })
    .eq("id", input.bookingId)
    .eq("contact_id", input.contactId)
    .eq("status", "completed")
    .is("client_rating", null)
    .select("id")
  if (rateError) {
    return { success: false, error: rateError.message }
  }
  if (!rated || rated.length === 0) {
    return { success: false, error: "Rating was not recorded — the booking may have changed. Refresh and try again." }
  }

  // Refresh the vendor_ratings aggregate (shared rollup — §6, one computation).
  // Best-effort: the rating row is already recorded; a rollup failure logs
  // inside the helper and must not un-succeed the client's submission.
  try {
    const { recalculateVendorRatingsCore } = await import("@/lib/vendor-marketplace/vendor-ratings")
    await recalculateVendorRatingsCore(svc, booking.vendor_id, booking.brokerage_id)
  } catch (err) {
    console.error("[contactVendorBooking] rate: vendor_ratings recompute failed:", err)
  }

  return { success: true }
}
