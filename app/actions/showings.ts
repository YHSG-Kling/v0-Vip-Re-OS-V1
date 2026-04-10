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

    // Resolve the agent's brokerage_id (for portal calls the user is the buyer contact, so we skip this gracefully)
    const { data: { user } } = await supabase.auth.getUser()
    let brokerageId: string | null = null
    if (user) {
      const { data: u } = await supabase.from("users").select("brokerage_id").eq("id", user.id).maybeSingle()
      brokerageId = u?.brokerage_id ?? null
    }

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

    // Log portal activity (best-effort — table may not exist for all envs)
    try {
      await supabase.from("client_portal_activity").insert({
        contact_id:    data.contactId,
        activity_type: "request_showing",
        activity_data: {
          property_address: data.propertyAddress,
          mls_number:       !isUuid ? data.propertyId : undefined,
          listing_id:       isUuid  ? data.propertyId : undefined,
        },
      })
    } catch { /* non-critical */ }

    revalidatePath(`/portal/${data.contactId}/properties`)
    revalidatePath(`/portal/${data.contactId}/showings`)

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
        status: "confirmed",
        confirmed_date: confirmedDate,
        updated_at: new Date().toISOString(),
      })
      .eq("id", showingId)
      .select()
      .single()

    if (error) throw error

    revalidatePath("/dashboard")

    return { success: true, showing: data }
  } catch (error: any) {
    console.error("Error in confirmShowing:", error)
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
