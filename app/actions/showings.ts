"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

export async function requestShowing(data: {
  contactId: string
  // For agent-created seller listings this is a UUID; for MLS buyer properties it is an MLS number string.
  // We store it as listing_id when it is a valid UUID, otherwise it goes in the message field only.
  propertyId: string
  propertyAddress: string
  propertyData?: any
  preferredDates: { date: string; time: string }[]
  clientNotes?: string
}) {
  try {
    const supabase = await createClient()

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
    const { data: { user } } = await supabase.auth.getUser()

    // Determine if propertyId is a valid UUID (agent listing) vs MLS string (buyer MLS search)
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const isUuid = uuidRe.test(data.propertyId)

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

    const { data: showing, error } = await supabase
      .from("showing_requests")
      .insert({
        listing_id:           isUuid ? data.propertyId : null,
        contact_id:           data.contactId,
        brokerage_id:         brokerageId,
        requested_date:       firstDate?.date ?? null,
        requested_start_time: firstDate?.time ? `${firstDate.time}:00` : null,
        message:              msgParts,
        status:               "pending",
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

      const assignedAgentId = contact?.agent_id ?? (user?.id ?? null)

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
        activity_data: {
          property_address: data.propertyAddress,
          mls_number:       !isUuid ? data.propertyId : undefined,
          listing_id:       isUuid  ? data.propertyId : undefined,
          showing_request_id: showing.id,
        },
      })
    } catch { /* non-critical */ }

    // Notify the assigned agent in-app.
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

    revalidatePath(`/portal/${data.contactId}/properties`)
    revalidatePath(`/portal/${data.contactId}/showings`)
    revalidatePath(`/dashboard/buyers/${data.contactId}`)

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
  status: "pending" | "confirmed" | "completed" | "cancelled" | "rescheduled",
  confirmedDate?: string,
  agentNotes?: string
) {
  try {
    const supabase = await createClient()

    const { error } = await supabase
      .from("showing_requests")
      .update({
        status,
        confirmed_date: confirmedDate,
        agent_notes: agentNotes,
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

export async function submitShowingFeedback(
  showingId: string,
  feedbackRating: number,
  feedbackNotes: string,
  interestedLevel: "very_interested" | "interested" | "neutral" | "not_interested"
) {
  try {
    const supabase = await createClient()

    const { error } = await supabase
      .from("showing_requests")
      .update({
        feedback_rating: feedbackRating,
        feedback_notes: feedbackNotes,
        interested_level: interestedLevel,
        status: "completed",
        updated_at: new Date().toISOString(),
      })
      .eq("id", showingId)

    if (error) {
      console.error("Error submitting feedback:", error)
      return { success: false, error: error.message }
    }

    return { success: true }
  } catch (error: any) {
    console.error("Error in submitShowingFeedback:", error)
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

    const { data, error } = await supabase
      .from("showing_requests")
      .insert({
        contact_id: params.contactId,
        property_id: params.propertyId,
        property_address: params.propertyAddress,
        confirmed_date: `${params.scheduledDate} ${params.scheduledTime}`,
        status: "confirmed",
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
        agent_notes: reason,
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
        status:         "confirmed",
        confirmed_date: confirmedDate,
        updated_at:     new Date().toISOString(),
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
    revalidatePath(`/dashboard/buyers/${data.contact_id}`)

    return { success: true, showing: data }
  } catch (error: any) {
    return { success: false, error: error.message }
  }
}

export async function getShowingFeedback(showingId: string) {
  try {
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("showing_requests")
      .select("feedback_rating, feedback_notes, interested_level")
      .eq("id", showingId)
      .single()

    if (error) throw error

    return { success: true, feedback: data }
  } catch (error: any) {
    console.error("Error in getShowingFeedback:", error)
    return { success: false, error: error.message }
  }
}
