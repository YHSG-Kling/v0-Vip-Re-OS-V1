"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { requireActiveBBA } from "@/lib/buyer-broker/gate"
import { guardShowingFinancialGate } from "@/lib/buyer-execution/showing-financial-policy"

export async function requestShowing(data: {
  contactId: string
  /** UUID when the property is an in-house listing; otherwise pass undefined
   *  and supply the external property fields below. */
  listingId?: string
  /** Required regardless of whether the property is in-house or external. */
  propertyAddress: string
  /** External property details (Rentcast / IDX / MLS lookup). Supply these
   *  when listingId is undefined so the listing agent can be contacted and
   *  the request shows up in the buyer agent's queue with full context. */
  propertyCity?: string
  propertyState?: string
  propertyZip?: string
  mlsNumber?: string
  listPrice?: number
  primaryPhotoUrl?: string
  /** When the listing is external, the listing-agent contact info the buyer
   *  agent will use to schedule (ShowingTime fallback / direct text / email). */
  listingAgentName?: string
  listingAgentPhone?: string
  listingAgentEmail?: string
  listingAgentCompany?: string
  /** Where this request originated. */
  source?: 'buyer_portal' | 'agent_input' | 'tour_planner' | 'message' | 'external_agent'
  /** Optional link back to the saved_properties row this request came from. */
  savedPropertyId?: string
  preferredDates: { date: string; time: string }[]
  clientNotes?: string
},
/**
 * Sessionless-caller overload (voice webhook): a caller-verified client runs
 * the SAME insert + notification chain (the BBA gate below uses its own
 * service client and fires regardless of lane — never bypassed). The cookie
 * client stays the default, so every existing caller (buyer portal, agent
 * dashboard) is untouched. A browser cannot spoof this param — a forged
 * plain-object client has no working .from and the call fails closed.
 */
caller?: { client: { from: (t: string) => any; auth?: unknown }; actorUserId?: string | null },
) {
  try {
    if (caller && typeof caller.client?.from !== "function") {
      return { success: false, error: "Invalid caller client" }
    }
    const supabase: any = caller ? caller.client : await createClient()

    // Resolve brokerage_id from the contact (NOT from the auth user — when
    // requestShowing fires from the buyer portal, the auth user is the
    // contact, not a brokerage staff user, so users.brokerage_id resolves
    // to null and downstream notifications/activities lose tenancy).
    const { data: contactBrokerage } = await supabase
      .from("contacts")
      .select("brokerage_id")
      .eq("id", data.contactId)
      .maybeSingle()
    const brokerageId: string | null = contactBrokerage?.brokerage_id ?? null
    // The auth user id feeds only the assigned-agent fallback below; on the
    // sessionless caller lane it comes from the caller's verified actor.
    const authUserId: string | null = caller
      ? (caller.actorUserId ?? null)
      : ((await (supabase as Awaited<ReturnType<typeof createClient>>).auth.getUser()).data.user?.id ?? null)

    // ── NAR 2024 Settlement: BBA gate ──────────────────────────────────────
    // Before scheduling a showing, the buyer must have a signed Buyer Broker
    // Agreement with their assigned agent. Skip when there's no assigned
    // agent (yet) — those are pre-representation inquiries that go through
    // the lead-pickup flow, not the BBA-gated showing flow.
    const { data: contactForBBA } = await supabase
      .from("contacts")
      .select("agent_id")
      .eq("id", data.contactId)
      .maybeSingle()
    if (contactForBBA?.agent_id) {
      const gate = await requireActiveBBA({
        buyerContactId: data.contactId,
        agentId:        contactForBBA.agent_id,
        brokerageId:    brokerageId ?? undefined,
      })
      if (!gate.allowed) {
        return { success: false, error: gate.reason ?? "BBA gate failed", errorCode: "bba_required" }
      }
    }

    // ── Buyer financial gate — TENANT SETTING (m377) ───────────────────────
    // Off by default and for every existing brokerage, in which case this
    // returns immediately and nothing about this path changes. When a brokerage
    // has opted in, the buyer must be financially verified before a showing is
    // set. The refusal carries the gate's OWN reason so "your lender hasn't
    // confirmed financials yet" never arrives looking like a server error.
    const finGate = await guardShowingFinancialGate({
      contactId:   data.contactId,
      brokerageId: brokerageId,
      userId:      authUserId,
    })
    if (finGate.blocked) {
      return { success: false, error: finGate.reason, errorCode: finGate.errorCode }
    }

    // Build a readable message from preferred dates and notes
    const datesText = data.preferredDates
      .map((d, i) => `Option ${i + 1}: ${d.date} at ${d.time}`)
      .join(", ")
    const msgParts = [
      `Showing request for ${data.propertyAddress}.`,
      datesText ? `Preferred dates: ${datesText}.` : "",
      data.clientNotes ? `Notes: ${data.clientNotes}` : "",
    ].filter(Boolean).join(" ")

    // Use first preferred date/time for the structured date fields
    const firstDate = data.preferredDates[0]

    // Compute requested_end_time (default 30 minute slot) — required by NOT NULL
    const startHHMM = firstDate?.time
    const endHHMM = startHHMM
      ? (() => {
          const [h, m] = startHHMM.split(":").map(Number)
          const total = h * 60 + m + 30
          const eh = Math.floor(total / 60) % 24
          const em = total % 60
          return `${String(eh).padStart(2,"0")}:${String(em).padStart(2,"0")}:00`
        })()
      : null

    const { data: showing, error } = await supabase
      .from("showing_requests")
      .insert({
        listing_id:            data.listingId ?? null,
        contact_id:            data.contactId,
        brokerage_id:          brokerageId,
        // External property fields — populated when listingId is null so the
        // request still has enough context for the buyer agent to act on it.
        property_address:      data.propertyAddress,
        property_city:         data.propertyCity ?? null,
        property_state:        data.propertyState ?? null,
        property_zip:          data.propertyZip ?? null,
        mls_number:            data.mlsNumber ?? null,
        list_price:            data.listPrice ?? null,
        primary_photo_url:     data.primaryPhotoUrl ?? null,
        listing_agent_name:    data.listingAgentName ?? null,
        listing_agent_phone:   data.listingAgentPhone ?? null,
        listing_agent_email:   data.listingAgentEmail ?? null,
        listing_agent_company: data.listingAgentCompany ?? null,
        source:                data.source ?? 'buyer_portal',
        saved_property_id:     data.savedPropertyId ?? null,
        requested_date:        firstDate?.date ?? null,
        requested_start_time:  startHHMM ? `${startHHMM}:00` : null,
        requested_end_time:    endHHMM,
        message:               msgParts,
        status:                "pending",
      })
      .select()
      .single()

    if (error) {
      return { success: false, error: error.message }
    }

    // Create an activities row on the assigned agent's feed so they can confirm or change the time.
    // This is the entry point for the agent to action the request — no calendar_events yet,
    // those are written only when the agent confirms.
    try {
      // Resolve the contact's assigned agent to surface the activity on the right agent's feed
      const { data: contact } = await supabase
        .from("contacts")
        .select("agent_id")
        .eq("id", data.contactId)
        .maybeSingle()

      const assignedAgentId = contact?.agent_id ?? authUserId

      if (assignedAgentId) {
        await supabase.from("activities").insert({
          brokerage_id:  brokerageId,
          agent_id:      assignedAgentId,
          contact_id:    data.contactId,
          activity_type: "showing_request",
          title:         `Showing request — ${data.propertyAddress}`,
          description:   msgParts,
          scheduled_at:  firstDate?.date
            ? `${firstDate.date}T${firstDate?.time ?? "10:00"}:00`
            : null,
          status:        "pending",
          priority:      "high",
        })
      }
    } catch { /* non-critical */ }

    // Log portal activity (best-effort)
    try {
      await supabase.from("client_portal_activity").insert({
        contact_id:    data.contactId,
        activity_type: "request_showing",
        metadata: {
          property_address:   data.propertyAddress,
          mls_number:         data.mlsNumber ?? null,
          listing_id:         data.listingId ?? null,
          showing_request_id: showing.id,
          source:             data.source ?? 'buyer_portal',
        },
      })
    } catch { /* non-critical */ }

    // Notify the assigned (buyer) agent in-app.
    // contacts.agent_id stores agents.id (NOT users.id), but
    // notifications.user_id is the auth.users id. Resolve via the agents
    // table — without this, the notification was inserted with user_id =
    // agents.id and silently never appeared in any user's bell.
    try {
      const { data: contact } = await supabase
        .from("contacts")
        .select("agent_id, first_name, last_name, brokerage_id")
        .eq("id", data.contactId)
        .maybeSingle()
      if (contact?.agent_id) {
        const { data: agentRow } = await supabase
          .from("agents")
          .select("user_id")
          .eq("id", contact.agent_id)
          .maybeSingle()
        if (agentRow?.user_id) {
          await supabase.from("notifications").insert({
            user_id:      agentRow.user_id,
            brokerage_id: brokerageId,
            type:         "showing.request",
            title:        "New showing request",
            body:         `${contact.first_name} ${contact.last_name} wants to see ${data.propertyAddress}. Confirm or reschedule.`,
            entity_type:  "showing_request",
            entity_id:    showing.id,
            priority:     "high",
            channel:      "in_app",
          })
        }
      }
    } catch { /* non-critical */ }

    // For IN-HOUSE listings: also notify the listing agent + the seller
    // contact in their portal. The buyer agent above is one path; the
    // listing-side path is what makes the request actionable on the seller
    // side.
    if (data.listingId) {
      try {
        const { data: listing } = await supabase
          .from("listings")
          .select("agent_id, seller_contact_id, address")
          .eq("id", data.listingId)
          .maybeSingle()

        // 1. Listing agent in-app notification
        if (listing?.agent_id) {
          const { data: listingAgentRow } = await supabase
            .from("agents")
            .select("user_id")
            .eq("id", listing.agent_id)
            .maybeSingle()
          if (listingAgentRow?.user_id) {
            await supabase.from("notifications").insert({
              user_id:      listingAgentRow.user_id,
              brokerage_id: brokerageId,
              type:         "showing.request.listing",
              title:        "New showing request on your listing",
              body:         `${data.propertyAddress} — buyer wants to see it. Confirm a time or send alternatives.`,
              entity_type:  "showing_request",
              entity_id:    showing.id,
              priority:     "high",
              channel:      "in_app",
            })
          }
        }

        // 2. Seller contact portal notification — surfaces in their
        //    PortalNotificationBell so they see incoming showing requests
        //    on their listing, not just their agent.
        if (listing?.seller_contact_id) {
          await supabase.from("notifications").insert({
            contact_id:   listing.seller_contact_id,
            brokerage_id: brokerageId,
            type:         "showing.request.seller",
            title:        "Showing request on your home",
            body:         `A buyer wants to see ${data.propertyAddress}. Your agent will follow up to confirm a time.`,
            entity_type:  "showing_request",
            entity_id:    showing.id,
            priority:     "high",
            channel:      "in_app",
          })
        }
      } catch { /* non-critical */ }
    }

    revalidatePath(`/portal/${data.contactId}/properties`)
    revalidatePath(`/portal/${data.contactId}/showings`)
    revalidatePath(`/crm/contacts/${data.contactId}`)

    return { success: true, data: showing }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

export async function getShowings(contactId: string) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("showing_requests")
      .select("*")
      .eq("contact_id", contactId)
      .order("created_at", { ascending: false })

    if (error) {
      console.error("[v0] Error fetching showings:", error)
      return []
    }

    return data || []
  } catch (error) {
    console.error("[v0] Error in getShowings:", error)
    return []
  }
}

export async function updateShowingStatus(
  showingId: string,
  status: "pending" | "approved" | "needs_reschedule" | "denied" | "cancelled",
  sellerNotes?: string
) {
  try {
    const supabase = await createClient()

    const { error } = await supabase
      .from("showing_requests")
      .update({
        status, // CHECK: pending|approved|needs_reschedule|denied|cancelled
        ...(sellerNotes !== undefined ? { seller_notes: sellerNotes } : {}),
        ...(status === "approved" ? { seller_approved: true, seller_approved_at: new Date().toISOString() } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", showingId)

    if (error) {
      console.error("[v0] Error updating showing status:", error)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (error: any) {
    console.error("[v0] Error in updateShowingStatus:", error)
    return { success: false, error: error.message }
  }
}

// Mark an actual scheduled showing (showings table) as completed. The mobile
// day-panel operates on showings rows, not showing_requests.
export async function completeShowing(showingId: string) {
  try {
    const supabase = await createClient()

    const { error } = await supabase
      .from("showings")
      .update({ status: "completed", completed_at: new Date().toISOString() })
      .eq("id", showingId)

    if (error) {
      console.error("Error completing showing:", error)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (error: any) {
    console.error("Error in completeShowing:", error)
    return { success: false, error: error.message }
  }
}

export async function createShowing(params: {
  contactId: string
  propertyId: string
  propertyAddress: string
  scheduledDate: string
  scheduledTime: string
  agentId: string
}) {
  try {
    const supabase = await createClient()

    // brokerage_id + requested_date/start/end are NOT NULL on showing_requests.
    const { data: c, error: contactErr } = await supabase
      .from("contacts").select("brokerage_id").eq("id", params.contactId).maybeSingle()
    if (contactErr) {
      console.error("Error loading contact for createShowing:", contactErr)
      return { success: false, error: contactErr.message }
    }

    // ── Buyer financial gate — TENANT SETTING (m377) ───────────────────────
    // No-op unless this brokerage opted in. When it did, an agent creating the
    // showing directly is the same "setting a showing" moment the owner named,
    // so it is gated exactly like the buyer-initiated request path.
    const { data: { user: creator } } = await supabase.auth.getUser()
    const finGate = await guardShowingFinancialGate({
      contactId:   params.contactId,
      brokerageId: c?.brokerage_id ?? null,
      userId:      creator?.id ?? null,
    })
    if (finGate.blocked) {
      return { success: false, error: finGate.reason, errorCode: finGate.errorCode }
    }

    const startTime = `${params.scheduledTime}:00`
    const [eh, em] = params.scheduledTime.split(":").map(Number)
    const endTotal = eh * 60 + em + 30
    const endTime = `${String(Math.floor(endTotal / 60) % 24).padStart(2, "0")}:${String(endTotal % 60).padStart(2, "0")}:00`

    const { data, error } = await supabase
      .from("showing_requests")
      .insert({
        contact_id:           params.contactId,
        brokerage_id:         c?.brokerage_id ?? null,
        listing_id:           params.propertyId, // real column is listing_id
        property_address:     params.propertyAddress,
        requested_date:       params.scheduledDate,
        requested_start_time: startTime,
        requested_end_time:   endTime,
        status:               "approved", // CHECK-valid; "confirmed" is not allowed
        seller_approved:      true,
        seller_approved_at:   new Date().toISOString(),
        source:               "agent_input",
      })
      .select()
      .single()

    if (error) throw error

    revalidatePath(`/portal/${params.contactId}/showings`)
    revalidatePath("/dashboard")

    return { success: true, showing: data }
  } catch (error: any) {
    console.error("Error in createShowing:", error)
    return { success: false, error: error.message }
  }
}

export async function updateShowing(showingId: string, updates: any) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("showing_requests")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("id", showingId)
      .select()
      .single()

    if (error) throw error

    revalidatePath("/dashboard")

    return { success: true, showing: data }
  } catch (error: any) {
    console.error("Error in updateShowing:", error)
    return { success: false, error: error.message }
  }
}

export async function cancelShowing(showingId: string, reason?: string) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("showing_requests")
      .update({
        status: "cancelled",
        ...(reason !== undefined ? { seller_notes: reason } : {}),
        updated_at: new Date().toISOString(),
      })
      .eq("id", showingId)
      .select()
      .single()

    if (error) throw error

    revalidatePath("/dashboard")

    return { success: true, showing: data }
  } catch (error: any) {
    console.error("Error in cancelShowing:", error)
    return { success: false, error: error.message }
  }
}

export async function confirmShowing(showingId: string, confirmedDate: string) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("showing_requests")
      .update({
        status:             "approved", // CHECK-valid; "confirmed" is not allowed
        seller_approved:    true,
        seller_approved_at: new Date().toISOString(),
        updated_at:         new Date().toISOString(),
      })
      .eq("id", showingId)
      .select("id, contact_id, brokerage_id, listing_id, requested_date")
      .single()

    if (error) throw error

    // Write the agent's calendar_event — only appears now that it is confirmed.
    // The contact's calendar event is written separately when the tour is sent/confirmed.
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (user) {
        const { data: u } = await supabase.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
        await supabase.from("calendar_events").insert({
          brokerage_id:        u?.brokerage_id ?? data.brokerage_id,
          entity_type:         "showing_request",
          entity_id:           data.id,
          event_type:          "showing",
          start_at:            confirmedDate,
          is_system_generated: true,
        })
      }
    } catch { /* non-critical */ }

    // Update activities row status to completed
    try {
      await supabase
        .from("activities")
        .update({ status: "completed", completed_at: new Date().toISOString() })
        .eq("entity_type", "showing_request")
        .eq("entity_id", showingId)
    } catch { /* non-critical */ }

    revalidatePath("/dashboard")
    revalidatePath(`/crm/contacts/${data.contact_id}`)

    return { success: true, showing: data }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

// NOTE: getShowingFeedback (by listingId) is canonically defined in seller-updates.ts —
// the showing_requests-based duplicate that lived here wrote/read phantom feedback
// columns and had no live consumer, so it was removed. See app/actions/index.ts.
