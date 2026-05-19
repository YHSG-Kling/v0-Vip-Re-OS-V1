"use server"

/**
 * Contact-initiated vendor booking — buyer/seller/lifetime customer
 * requests a vendor service from their portal. Agent gets a notification
 * for review/approval before the vendor is engaged.
 *
 * Flow:
 *   1. Contact taps "Request Booking" on a vendor card in /portal/[id]/vendors
 *   2. Form: service description + preferred time window + message
 *   3. We insert vendor_bookings row with status='pending_review' and
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
      status: "pending_review",
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

  // Activity on contact timeline
  await svc.from("activities").insert({
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

  return { success: true, bookingId: booking.id }
}
