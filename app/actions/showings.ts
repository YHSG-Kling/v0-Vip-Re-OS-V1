"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"

export async function requestShowing(data: {
  contactId: string
  propertyId: string
  propertyAddress: string
  propertyData?: any
  preferredDates: { date: string; time: string }[]
  clientNotes?: string
}) {
  try {
    const supabase = await createClient()

    const { data: showing, error } = await supabase
      .from("showing_requests")
      .insert({
        contact_id: data.contactId,
        property_id: data.propertyId,
        property_address: data.propertyAddress,
        property_data: data.propertyData || {},
        preferred_dates: data.preferredDates,
        client_notes: data.clientNotes,
        status: "pending",
      })
      .select()
      .single()

    if (error) {
      console.error("[v0] Error creating showing request:", error)
      return { success: false, error: error.message }
    }

    // Track activity
    await supabase.from("client_portal_activity").insert({
      contact_id: data.contactId,
      activity_type: "request_showing",
      activity_data: { property_id: data.propertyId, property_address: data.propertyAddress },
      property_id: data.propertyId,
    })

    revalidatePath(`/portal/${data.contactId}/properties`)
    revalidatePath(`/portal/${data.contactId}/showings`)

    return { success: true, data: showing }
  } catch (error: any) {
    console.error("[v0] Error in requestShowing:", error)
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
