"use server"

/**
 * app/actions/open-house.ts
 * System 4.7 — Open House Engine server actions.
 *
 * All queries use getAgentContext() for identity and createServiceClient() for
 * service-role reads/writes. Falls back gracefully if open_house_events table
 * does not exist (it should — see scripts/526-create-open-house-system-v2.sql).
 */

import { revalidatePath } from "next/cache"
import { getAgentContext } from "@/lib/identity"
import { createServiceClient } from "@/lib/supabase/service"
import { createClient } from "@/lib/supabase/server"

// ─────────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────────

export interface OpenHouseEvent {
  id: string
  listing_id: string | null
  brokerage_id: string | null
  agent_id: string | null
  event_date: string
  start_time: string
  end_time: string
  status: string
  description: string | null  // public-facing event description
  notes: string | null        // agent private notes
  max_attendees: number | null
  created_at: string
  // Joined
  listing?: {
    id: string
    address: string | null
    city: string | null
    state: string | null
    zip: string | null
    list_price: number | null
  } | null
  attendee_count?: number
  avg_feedback?: number | null
}

export interface OpenHouseAttendee {
  id: string
  event_id: string
  name: string | null
  email: string | null
  phone: string | null
  contact_id: string | null
  working_with_agent: boolean | null
  interest_level: string | null
  ai_lead_score: number | null
  check_in_time: string | null
  notes: string | null
  feedback_rating: number | null
  feedback_comments: string | null
}

export interface OpenHouseFeedback {
  id: string
  attendee_id: string
  event_id: string
  rating: number | null
  liked_most: string | null
  concerns: string | null
  price_opinion: string | null
  interested_in_offer: boolean | null
  submitted_at: string
  // from attendee join
  attendee_name?: string | null
  attendee_email?: string | null
}

// ─────────────────────────────────────────────────────────────────────────────
// CREATE OPEN HOUSE
// ─────────────────────────────────────────────────────────────────────────────

export async function createOpenHouse(params: {
  listingId: string
  date: string          // ISO date string "YYYY-MM-DD"
  startTime: string     // "HH:MM"
  endTime: string       // "HH:MM"
  maxAttendees?: number
  agentNotes?: string
  publicDescription?: string
  sendInvites?: boolean
}) {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!ctx.brokerageId) return { success: false, error: "No brokerage context" }

    const service = createServiceClient()

    // Verify listing belongs to caller's brokerage
    const { data: listing } = await service
      .from("listings")
      .select("brokerage_id")
      .eq("id", params.listingId)
      .maybeSingle()

    if (!listing || listing.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Listing not found or not authorized" }
    }

    const { data: event, error } = await service
      .from("open_house_events")
      .insert({
        listing_id: params.listingId,
        brokerage_id: ctx.brokerageId,
        agent_id: ctx.agentId ?? null,
        created_by: ctx.userId,
        event_date: params.date,
        start_time: params.startTime,
        end_time: params.endTime,
        max_attendees: params.maxAttendees ?? null,
        notes: params.agentNotes ?? null,
        description: params.publicDescription ?? null,
        status: "scheduled",
        registration_required: false,
      })
      .select()
      .maybeSingle()

    if (error) {
      console.error("[createOpenHouse] insert error:", error.message)
      return { success: false, error: error.message }
    }
    if (!event) return { success: false, error: "Failed to create open house" }

    // Fire-and-forget invites if requested
    if (params.sendInvites && event.id) {
      sendOpenHouseInvites(event.id).catch(() => {/* intentionally silent */})
    }

    revalidatePath("/dashboard/open-houses")
    return { success: true, event }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    return { success: false, error: msg }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET OPEN HOUSES (agent-scoped, with attendee counts)
// ─────────────────────────────────────────────────────────────────────────────

export async function getOpenHouses(): Promise<{
  success: boolean
  events?: OpenHouseEvent[]
  error?: string
}> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }

    const service = createServiceClient()

    // Build base query — agent sees their own events; broker sees all brokerage events
    let query = service
      .from("open_house_events")
      .select(`
        id,
        listing_id,
        brokerage_id,
        agent_id,
        event_date,
        start_time,
        end_time,
        status,
        description,
        notes,
        max_attendees,
        created_at,
        listings (
          id,
          address,
          city,
          state,
          zip,
          list_price
        )
      `)
      .order("event_date", { ascending: true })
      .order("start_time", { ascending: true })

    if (ctx.userType === "agent" && !ctx.agentId) {
      return { success: false, error: "Agent identity required" }
    } else if (ctx.userType === "agent" && ctx.agentId) {
      query = query.eq("agent_id", ctx.agentId)
    } else if (ctx.brokerageId) {
      query = query.eq("brokerage_id", ctx.brokerageId)
    } else {
      // Non-agent with no brokerageId — deny rather than expose all events (service client has no RLS)
      return { success: false, error: "Brokerage context required" }
    }

    const { data: events, error } = await query

    if (error) {
      console.error("[getOpenHouses] query error:", error.message)
      return { success: false, error: error.message }
    }

    const eventList = events ?? []
    if (eventList.length === 0) return { success: true, events: [] }

    // Fetch attendee counts
    const eventIds = eventList.map((e) => e.id)
    const { data: attendees } = await service
      .from("open_house_attendees")
      .select("event_id")
      .in("event_id", eventIds)

    // Fetch avg feedback per event from attendees (feedback_rating column)
    const { data: feedbackRows } = await service
      .from("open_house_attendees")
      .select("event_id, feedback_rating")
      .in("event_id", eventIds)
      .not("feedback_rating", "is", null)

    // Build lookup maps
    const attendeeCountMap: Record<string, number> = {}
    for (const a of attendees ?? []) {
      attendeeCountMap[a.event_id] = (attendeeCountMap[a.event_id] ?? 0) + 1
    }

    const feedbackSumMap: Record<string, { sum: number; count: number }> = {}
    for (const f of feedbackRows ?? []) {
      if (f.feedback_rating != null) {
        const cur = feedbackSumMap[f.event_id] ?? { sum: 0, count: 0 }
        feedbackSumMap[f.event_id] = { sum: cur.sum + f.feedback_rating, count: cur.count + 1 }
      }
    }

    const enriched: OpenHouseEvent[] = eventList.map((e) => ({
      id: e.id,
      listing_id: e.listing_id,
      brokerage_id: e.brokerage_id,
      agent_id: e.agent_id,
      event_date: e.event_date,
      start_time: e.start_time,
      end_time: e.end_time,
      status: e.status ?? "scheduled",
      description: e.description,
      notes: e.notes,
      max_attendees: e.max_attendees,
      created_at: e.created_at,
      listing: Array.isArray(e.listings) ? (e.listings[0] ?? null) : (e.listings as OpenHouseEvent["listing"] ?? null),
      attendee_count: attendeeCountMap[e.id] ?? 0,
      avg_feedback: feedbackSumMap[e.id]
        ? Math.round((feedbackSumMap[e.id].sum / feedbackSumMap[e.id].count) * 10) / 10
        : null,
    }))

    return { success: true, events: enriched }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    return { success: false, error: msg }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET ATTENDEES FOR AN EVENT
// ─────────────────────────────────────────────────────────────────────────────

export async function getOpenHouseAttendees(openHouseId: string): Promise<{
  success: boolean
  attendees?: OpenHouseAttendee[]
  error?: string
}> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }

    const service = createServiceClient()

    // Verify the event belongs to the caller's brokerage
    const { data: eventCheck } = await service
      .from("open_house_events")
      .select("brokerage_id, agent_id")
      .eq("id", openHouseId)
      .maybeSingle()

    if (!eventCheck) return { success: false, error: "Event not found" }
    if (ctx.brokerageId && eventCheck.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    if (ctx.userType === "agent") {
      if (!ctx.agentId || eventCheck.agent_id !== ctx.agentId) {
        return { success: false, error: "Unauthorized" }
      }
    }

    const { data, error } = await service
      .from("open_house_attendees")
      .select(
        "id, event_id, name, email, phone, contact_id, working_with_agent, interest_level, ai_lead_score, check_in_time, notes, feedback_rating, feedback_comments"
      )
      .eq("event_id", openHouseId)
      .order("check_in_time", { ascending: false })

    if (error) return { success: false, error: error.message }

    return { success: true, attendees: (data ?? []) as OpenHouseAttendee[] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    return { success: false, error: msg }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET FEEDBACK FOR AN EVENT
// ─────────────────────────────────────────────────────────────────────────────

export async function getOpenHouseFeedback(openHouseId: string): Promise<{
  success: boolean
  feedback?: OpenHouseFeedback[]
  error?: string
}> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }

    const service = createServiceClient()

    // Verify the event belongs to the caller's brokerage
    const { data: eventCheck } = await service
      .from("open_house_events")
      .select("brokerage_id, agent_id")
      .eq("id", openHouseId)
      .maybeSingle()

    if (!eventCheck) return { success: false, error: "Event not found" }
    if (ctx.brokerageId && eventCheck.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }
    if (ctx.userType === "agent" && !ctx.agentId) {
      return { success: false, error: "Agent identity required" }
    }
    if (ctx.userType === "agent" && ctx.agentId && eventCheck.agent_id !== ctx.agentId) {
      return { success: false, error: "Unauthorized" }
    }

    // Try open_house_feedback table first (may exist), else fall back to
    // feedback_rating/feedback_comments columns on open_house_attendees
    const { data: fbRows, error: fbError } = await service
      .from("open_house_feedback")
      .select("id, attendee_id, event_id, rating, liked_most, concerns, price_opinion, interested_in_offer, submitted_at")
      .eq("event_id", openHouseId)
      .order("submitted_at", { ascending: false })

    if (!fbError && fbRows) {
      // Enrich with attendee name/email
      const attendeeIds = fbRows.map((f) => f.attendee_id).filter(Boolean)
      let attendeeMap: Record<string, { name: string | null; email: string | null }> = {}
      if (attendeeIds.length > 0) {
        const { data: attendeeRows } = await service
          .from("open_house_attendees")
          .select("id, name, email")
          .in("id", attendeeIds)
        for (const a of attendeeRows ?? []) {
          attendeeMap[a.id] = { name: a.name, email: a.email }
        }
      }

      const feedback: OpenHouseFeedback[] = fbRows.map((f) => ({
        id: f.id,
        attendee_id: f.attendee_id,
        event_id: f.event_id,
        rating: f.rating,
        liked_most: f.liked_most,
        concerns: f.concerns,
        price_opinion: f.price_opinion,
        interested_in_offer: f.interested_in_offer,
        submitted_at: f.submitted_at,
        attendee_name: attendeeMap[f.attendee_id]?.name ?? null,
        attendee_email: attendeeMap[f.attendee_id]?.email ?? null,
      }))
      return { success: true, feedback }
    }

    // Fallback: read from attendees table
    const { data: attendees, error: attError } = await service
      .from("open_house_attendees")
      .select("id, event_id, name, email, feedback_rating, feedback_comments, check_in_time")
      .eq("event_id", openHouseId)
      .not("feedback_rating", "is", null)

    if (attError) return { success: false, error: attError.message }

    const feedback: OpenHouseFeedback[] = (attendees ?? []).map((a) => ({
      id: a.id,
      attendee_id: a.id,
      event_id: a.event_id,
      rating: a.feedback_rating,
      liked_most: null,
      concerns: a.feedback_comments,
      price_opinion: null,
      interested_in_offer: null,
      submitted_at: a.check_in_time ?? new Date().toISOString(),
      attendee_name: a.name,
      attendee_email: a.email,
    }))

    return { success: true, feedback }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    return { success: false, error: msg }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SEND INVITES (fire-and-forget)
// ─────────────────────────────────────────────────────────────────────────────

export async function sendOpenHouseInvites(openHouseId: string): Promise<{
  success: boolean
  sent?: number
  error?: string
}> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }
    if (!ctx.brokerageId) return { success: false, error: "No brokerage context" }

    const service = createServiceClient()

    // Fetch the event to get listing_id
    const { data: event } = await service
      .from("open_house_events")
      .select("id, listing_id, brokerage_id, event_date")
      .eq("id", openHouseId)
      .maybeSingle()

    if (!event) return { success: false, error: "Event not found" }

    if (event.brokerage_id !== ctx.brokerageId) {
      return { success: false, error: "Unauthorized" }
    }

    // Find buyer contacts with active searches in brokerage
    // When caller is an agent, scope to their own contacts only
    if (ctx.userType === "agent" && !ctx.agentId) {
      return { success: false, error: "Agent identity required" }
    }
    if (!ctx.brokerageId) {
      return { success: false, error: "Brokerage context required" }
    }

    let contactsQuery = service
      .from("contacts")
      .select("id, first_name, last_name, email")
      .eq("brokerage_id", ctx.brokerageId)
      .eq("contact_type", "buyer")
      .not("email", "is", null)
      .limit(100)

    if (ctx.agentId) {
      contactsQuery = contactsQuery.eq("agent_id", ctx.agentId)
    }

    const { data: contacts } = await contactsQuery

    if (!contacts || contacts.length === 0) return { success: true, sent: 0 }

    // Insert invitations (skip duplicates via on-conflict)
    const invitations = contacts.map((c) => ({
      event_id: openHouseId,
      contact_id: c.id,
      brokerage_id: ctx.brokerageId,
      agent_id: ctx.agentId,
      channel: "email",
      status: "pending",
      sent_at: new Date().toISOString(),
    }))

    const { error: upsertError } = await service
      .from("open_house_invitations")
      .upsert(invitations, { onConflict: "event_id,contact_id", ignoreDuplicates: true })
    if (upsertError) {
      console.error("[sendOpenHouseInvites] upsert failed:", upsertError.message)
      return { success: false, error: upsertError.message }
    }

    // Update event status
    const { error: statusError } = await service
      .from("open_house_events")
      .update({ status: "invitations_sent" })
      .eq("id", openHouseId)
    if (statusError) {
      // Non-fatal — invites were sent, just status flag failed
      console.warn("[sendOpenHouseInvites] status update failed:", statusError.message)
    }

    revalidatePath("/dashboard/open-houses")
    return { success: true, sent: contacts.length }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    return { success: false, error: msg }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RECORD ATTENDEE (check-in)
// ─────────────────────────────────────────────────────────────────────────────

export async function recordAttendee(
  openHouseId: string,
  attendeeData: {
    name: string
    email?: string
    phone?: string
    workingWithAgent?: boolean
    interestLevel?: string
    notes?: string
    tcpaConsent?: boolean
  }
): Promise<{ success: boolean; attendeeId?: string; error?: string }> {
  try {
    const ctx = await getAgentContext()
    const service = createServiceClient()

    // Validate event exists
    const { data: event } = await service
      .from("open_house_events")
      .select("id, brokerage_id, agent_id, status")
      .eq("id", openHouseId)
      .maybeSingle()

    if (!event) return { success: false, error: "Event not found" }

    if (ctx.isAuthenticated) {
      // Authenticated callers must belong to the same brokerage as the event
      if (ctx.brokerageId && ctx.brokerageId !== event.brokerage_id) {
        return { success: false, error: "Unauthorized" }
      }
      // Agents can only record attendees for their own events
      if (ctx.userType === "agent" && ctx.agentId && ctx.agentId !== event.agent_id) {
        return { success: false, error: "Unauthorized" }
      }
    } else {
      // Unauthenticated (public QR check-in): only allow for active events
      const activeStatuses = ["active", "live", "scheduled", "open"]
      if (!activeStatuses.includes(event.status ?? "")) {
        return { success: false, error: "Event is not accepting check-ins" }
      }
    }

    const { data, error } = await service
      .from("open_house_attendees")
      .insert({
        event_id: openHouseId,
        brokerage_id: event.brokerage_id,
        name: attendeeData.name,
        email: attendeeData.email ?? null,
        phone: attendeeData.tcpaConsent ? (attendeeData.phone ?? null) : null,
        working_with_agent: attendeeData.workingWithAgent ?? false,
        interest_level: attendeeData.interestLevel ?? null,
        notes: attendeeData.notes ?? null,
        check_in_time: new Date().toISOString(),
        tcpa_consent: attendeeData.tcpaConsent ?? false,
      })
      .select("id")
      .maybeSingle()

    if (error) return { success: false, error: error.message }

    revalidatePath("/dashboard/open-houses")
    return { success: true, attendeeId: data?.id }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    return { success: false, error: msg }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET AGENT LISTINGS (for the schedule dialog dropdown)
// ─────────────────────────────────────────────────────────────────────────────

export async function getAgentListings(): Promise<{
  success: boolean
  listings?: Array<{ id: string; address: string; city: string | null; state: string | null; status: string }>
  error?: string
}> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated) return { success: false, error: "Not authenticated" }

    const service = createServiceClient()

    let query = service
      .from("listings")
      .select("id, address, city, state, status")
      .in("status", ["active", "coming_soon", "pending"])
      .order("created_at", { ascending: false })
      .limit(50)

    if (ctx.agentId) {
      query = query.eq("agent_id", ctx.agentId)
    } else if (ctx.brokerageId) {
      query = query.eq("brokerage_id", ctx.brokerageId)
    } else {
      // No scoping context — deny rather than expose all listings via service client
      return { success: false, error: "No scoping context available" }
    }

    const { data, error } = await query

    if (error) return { success: false, error: error.message }
    return { success: true, listings: data ?? [] }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    return { success: false, error: msg }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CANCEL OPEN HOUSE
// ─────────────────────────────────────────────────────────────────────────────

export async function cancelOpenHouse(openHouseId: string): Promise<{
  success: boolean
  error?: string
}> {
  try {
    const ctx = await getAgentContext()
    if (!ctx.isAuthenticated || !ctx.brokerageId) return { success: false, error: "Unauthorized" }

    const service = createServiceClient()

    // Scope update to the user's brokerage; non-broker agents are further
    // scoped to only their own events so they cannot cancel others' events.
    const isBrokerOrAdmin = ctx.userType === "broker" || ctx.userType === "admin" || ctx.userType === "superadmin"

    let query = service
      .from("open_house_events")
      .update({ status: "cancelled" })
      .eq("id", openHouseId)
      .eq("brokerage_id", ctx.brokerageId)

    if (!isBrokerOrAdmin) {
      if (!ctx.agentId) return { success: false, error: "Unauthorized" }
      query = query.eq("agent_id", ctx.agentId)
    }

    const { data: updated, error } = await query.select("id")

    if (error) return { success: false, error: error.message }
    if (!updated?.length) return { success: false, error: "Event not found or not cancellable" }

    revalidatePath("/dashboard/open-houses")
    return { success: true }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown error"
    return { success: false, error: msg }
  }
}
