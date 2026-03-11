"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import { KernelEvent } from "@/lib/kernel/events"

/**
 * Log a touchpoint for a past client
 */
export async function logTouchpoint({
  contactId,
  touchpointType,
  notes,
  channel = "manual",
}: {
  contactId: string
  touchpointType: string
  notes?: string
  channel?: string
}) {
  const supabase = await createClient()
  const { agentId, brokerageId } = await getAgentContext()

  const { data, error } = await supabase
    .from("past_client_touchpoints")
    .insert({
      contact_id: contactId,
      agent_id: agentId,
      brokerage_id: brokerageId,
      touchpoint_type: touchpointType,
      channel,
      notes,
      status: "completed",
      sent_at: new Date().toISOString(),
    })
    .select()
    .single()

  if (error) {
    console.error("Error logging touchpoint:", error)
    return { success: false, error: error.message }
  }

  // Record activity with kernel event reference
  await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    user_id: agentId,
    contact_id: contactId,
    activity_type: "past_client_touchpoint_sent",
    status: "completed",
    metadata: {
      touchpoint_type: touchpointType,
      channel,
      notes,
      kernel_event: KernelEvent.PAST_CLIENT_TOUCHPOINT_SENT,
    },
  }).catch(err => console.error("Error recording activity:", err))

  return { success: true, touchpoint: data }
}

/**
 * Send a market update to a past client (draft-first)
 */
export async function sendMarketUpdate({
  contactId,
  messageBody,
}: {
  contactId: string
  messageBody: string
}) {
  const supabase = await createClient()
  const { agentId, brokerageId } = await getAgentContext()

  // Insert client portal message
  const { data: message, error: msgError } = await supabase
    .from("client_portal_messages")
    .insert({
      contact_id: contactId,
      agent_id: agentId,
      brokerage_id: brokerageId,
      message_body: messageBody,
      direction: "outbound",
      channel: "portal",
      read_at: null,
    })
    .select()
    .single()

  if (msgError) {
    console.error("Error sending market update:", msgError)
    return { success: false, error: msgError.message }
  }

  // Insert touchpoint record
  const { error: touchpointError } = await supabase
    .from("past_client_touchpoints")
    .insert({
      contact_id: contactId,
      agent_id: agentId,
      brokerage_id: brokerageId,
      touchpoint_type: "market_update",
      channel: "portal",
      status: "completed",
      sent_at: new Date().toISOString(),
    })

  if (touchpointError) {
    console.error("Error logging touchpoint:", touchpointError)
  }

  // Record activity with kernel event reference
  await supabase.from("activities").insert({
    brokerage_id: brokerageId,
    user_id: agentId,
    contact_id: contactId,
    activity_type: "market_update_sent",
    status: "completed",
    metadata: {
      message_id: message.id,
      message_preview: messageBody.substring(0, 100),
      kernel_event: KernelEvent.MARKET_UPDATE_SENT,
    },
  }).catch(err => console.error("Error recording activity:", err))

  return { success: true, message }
}

/**
 * Get past clients with engagement scores
 */
export async function getPastClients({
  search,
  lastContactFilter,
  engagementFilter,
}: {
  search?: string
  lastContactFilter?: string
  engagementFilter?: string
} = {}) {
  const supabase = await createClient()
  const { agentId, brokerageId } = await getAgentContext()

  // Get past clients (contacts with closed transactions)
  let query = supabase
    .from("contacts")
    .select(`
      *,
      transactions!inner(id, actual_close_date, status, property_address, sale_price),
      client_engagement_scores(engagement_score, referral_potential_score, last_touchpoint_date, computed_at)
    `)
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .eq("transactions.status", "closed")

  if (search) {
    query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`)
  }

  const { data: pastClients, error } = await query

  if (error) {
    console.error("Error fetching past clients:", error)
    return { success: false, error: error.message }
  }

  // Post-filter by engagement if needed
  let filtered = pastClients || []

  if (engagementFilter && engagementFilter !== "all") {
    filtered = filtered.filter((client) => {
      const score = client.client_engagement_scores?.[0]?.engagement_score || 0
      if (engagementFilter === "hot") return score >= 70
      if (engagementFilter === "warm") return score >= 40 && score < 70
      if (engagementFilter === "cold") return score < 40
      return true
    })
  }

  // Post-filter by last contact
  if (lastContactFilter && lastContactFilter !== "all") {
    const now = new Date()
    filtered = filtered.filter((client) => {
      const lastTouchpoint = client.client_engagement_scores?.[0]?.last_touchpoint_date
      if (!lastTouchpoint) return lastContactFilter === "never"

      const daysSince = Math.floor((now.getTime() - new Date(lastTouchpoint).getTime()) / (1000 * 60 * 60 * 24))
      if (lastContactFilter === "1m") return daysSince <= 30
      if (lastContactFilter === "3m") return daysSince <= 90
      if (lastContactFilter === "6m") return daysSince <= 180
      if (lastContactFilter === "1yr") return daysSince <= 365
      if (lastContactFilter === "never") return !lastTouchpoint
      return true
    })
  }

  return { success: true, clients: filtered }
}

/**
 * Get touchpoint timeline for a contact
 */
export async function getTouchpointTimeline(contactId: string) {
  const supabase = await createClient()
  const { agentId, brokerageId } = await getAgentContext()

  const { data, error } = await supabase
    .from("past_client_touchpoints")
    .select("*")
    .eq("contact_id", contactId)
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .order("sent_at", { ascending: false })
    .limit(20)

  if (error) {
    console.error("Error fetching touchpoint timeline:", error)
    return { success: false, error: error.message }
  }

  return { success: true, touchpoints: data }
}

/**
 * Get upcoming anniversaries (close date within 30 days)
 */
export async function getUpcomingAnniversaries() {
  const supabase = await createClient()
  const { agentId, brokerageId } = await getAgentContext()

  const today = new Date()
  const thirtyDaysFromNow = new Date(today)
  thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30)

  // Get transactions with close dates in the current month range
  const currentMonthDay = today.getDate()
  const endMonthDay = thirtyDaysFromNow.getDate()

  const { data: transactions, error } = await supabase
    .from("transactions")
    .select(`
      id,
      actual_close_date,
      property_address,
      sale_price,
      contacts!inner(id, first_name, last_name, email, phone)
    `)
    .eq("status", "closed")
    .eq("contacts.agent_id", agentId)
    .not("actual_close_date", "is", null)

  if (error) {
    console.error("Error fetching anniversaries:", error)
    return { success: false, error: error.message }
  }

  // Filter for anniversary dates
  const upcomingAnniversaries = (transactions || []).filter((t) => {
    const closeDate = new Date(t.actual_close_date)
    const anniversaryThisYear = new Date(
      today.getFullYear(),
      closeDate.getMonth(),
      closeDate.getDate()
    )

    // Check if anniversary is within next 30 days
    return anniversaryThisYear >= today && anniversaryThisYear <= thirtyDaysFromNow
  })

  return { success: true, anniversaries: upcomingAnniversaries }
}

/**
 * Schedule a touchpoint for the future
 */
export async function scheduleTouchpoint({
  contactId,
  touchpointType,
  scheduledFor,
  notes,
}: {
  contactId: string
  touchpointType: string
  scheduledFor: string
  notes?: string
}) {
  const supabase = await createClient()
  const { agentId, brokerageId } = await getAgentContext()

  const { data, error } = await supabase
    .from("scheduled_touchpoints")
    .insert({
      contact_id: contactId,
      agent_id: agentId,
      brokerage_id: brokerageId,
      touchpoint_type: touchpointType,
      scheduled_for: scheduledFor,
      notes,
      status: "pending",
    })
    .select()
    .single()

  if (error) {
    console.error("Error scheduling touchpoint:", error)
    return { success: false, error: error.message }
  }

  return { success: true, scheduled: data }
}

/**
 * Get AI-suggested next touchpoint for a contact
 */
export async function getAISuggestedTouchpoint(contactId: string) {
  const supabase = await createClient()
  const { agentId, brokerageId } = await getAgentContext()

  // Get contact info and last touchpoint
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select(`
      *,
      client_engagement_scores(engagement_score, last_touchpoint_date),
      transactions(actual_close_date, property_address)
    `)
    .eq("id", contactId)
    .single()

  if (contactError || !contact) {
    return { success: false, error: "Contact not found" }
  }

  const lastTouchpointDate = contact.client_engagement_scores?.[0]?.last_touchpoint_date
  const engagementScore = contact.client_engagement_scores?.[0]?.engagement_score || 50
  const closeDate = contact.transactions?.[0]?.actual_close_date

  // Calculate days since last contact
  const daysSinceContact = lastTouchpointDate
    ? Math.floor((Date.now() - new Date(lastTouchpointDate).getTime()) / (1000 * 60 * 60 * 24))
    : 999

  // Check for anniversary proximity
  let isAnniversaryClose = false
  if (closeDate) {
    const anniversary = new Date(closeDate)
    const now = new Date()
    anniversary.setFullYear(now.getFullYear())
    const daysToAnniversary = Math.floor((anniversary.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
    isAnniversaryClose = daysToAnniversary >= 0 && daysToAnniversary <= 30
  }

  // Generate suggestion based on data
  let suggestion: {
    type: string
    message: string
    reason: string
    priority: "high" | "medium" | "low"
  }

  if (isAnniversaryClose) {
    suggestion = {
      type: "anniversary",
      message: `Send ${contact.first_name} a home anniversary congratulations message`,
      reason: "Their home purchase anniversary is coming up",
      priority: "high",
    }
  } else if (daysSinceContact > 90) {
    suggestion = {
      type: "market_update",
      message: `Send ${contact.first_name} a market update — you haven't connected in ${daysSinceContact} days`,
      reason: `It's been ${daysSinceContact} days since your last contact`,
      priority: engagementScore < 40 ? "high" : "medium",
    }
  } else if (engagementScore < 40) {
    suggestion = {
      type: "check_in",
      message: `Schedule a check-in call with ${contact.first_name} to boost engagement`,
      reason: "Their engagement score is low",
      priority: "medium",
    }
  } else {
    suggestion = {
      type: "newsletter",
      message: `Include ${contact.first_name} in your next newsletter`,
      reason: "Regular touchpoint to maintain relationship",
      priority: "low",
    }
  }

  return {
    success: true,
    suggestion,
    contactName: `${contact.first_name} ${contact.last_name}`,
    daysSinceContact,
    engagementScore,
  }
}
