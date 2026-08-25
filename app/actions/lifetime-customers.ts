"use server"

import { createClient } from "@/lib/supabase/server"
import { getAgentContext } from "@/lib/identity"
import { KernelEvent } from "@/lib/kernel/events"
import {
  aiScoreSphereEngagement,
  aiSegmentSphere,
  aiGetUpcomingMilestones,
  aiGenerateTouchpoint,
  aiOptimizeReferralAsk,
} from "@/app/actions/ai-sphere-management"
import { getRecentLifeChanges } from "@/app/actions/contact-enrichment"
import { identifyReferralOpportunities } from "@/app/actions/ai-referral-management"
import { bestEffort } from "@/lib/db/best-effort"

/**
 * Log a touchpoint for a lifetime customer
 */
export async function logTouchpoint({
  contactId,
  touchpointType,
  notes,
  channel = "in_app",
}: {
  contactId: string
  touchpointType: string
  notes?: string
  channel?: string
}) {
  const supabase = await createClient()
  const { agentId, brokerageId } = await getAgentContext()

  // Real columns: scheduled_date (NOT NULL, date), sent_date (date), engagement_data (jsonb,
  // not "notes"); status CHECK uses 'sent' not 'completed'; channel CHECK excludes 'manual'.
  const { data, error } = await supabase
    .from("lifetime_customer_touchpoints")
    .insert({
      contact_id: contactId,
      agent_id: agentId,
      brokerage_id: brokerageId,
      touchpoint_type: touchpointType,
      channel,
      engagement_data: notes ? { notes } : {},
      status: "sent",
      scheduled_date: new Date().toISOString().split("T")[0],
      sent_date: new Date().toISOString().split("T")[0],
    })
    .select()
    .single()

  if (error) {
    console.error("Error logging touchpoint:", error)
    return { success: false, error: error.message }
  }

  // Record activity with kernel event reference
  await bestEffort(
    supabase.from("activities").insert({
      brokerage_id: brokerageId,
      agent_id: agentId,
      contact_id: contactId,
      activity_type: "lifetime_customer_touchpoint_sent",
      title: `Lifetime customer touchpoint: ${touchpointType}`,
      description: notes ?? `${touchpointType} sent via ${channel}`,
      notes: JSON.stringify({ touchpoint_type: touchpointType, channel, kernel_event: KernelEvent.LIFETIME_CUSTOMER_TOUCHPOINT_SENT }),
      status: "completed",
      entity_type: "contact",
    }),
    "the lifetime_customer_touchpoints row above is the ledger of the send and its error is already checked and returned; this timeline echo must not fail a touchpoint that was recorded. The old rejection handler could not see a REFUSED row at all — bestEffort logs both.",
  )

  return { success: true, touchpoint: data }
}

/**
 * Send a market update to a lifetime customer (draft-first)
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
      body: messageBody, // real column (was phantom message_body)
      direction: "agent_to_client", // CHECK: agent_to_client|client_to_agent
      channel: "portal",
      read: false,
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
    .from("lifetime_customer_touchpoints")
    .insert({
      contact_id: contactId,
      agent_id: agentId,
      brokerage_id: brokerageId,
      touchpoint_type: "market_update",
      channel: "in_app", // CHECK excludes 'portal'
      status: "sent",
      scheduled_date: new Date().toISOString().split("T")[0],
      sent_date: new Date().toISOString().split("T")[0],
    })

  if (touchpointError) {
    console.error("Error logging touchpoint:", touchpointError)
  }

  // Record activity with kernel event reference
  await bestEffort(
    supabase.from("activities").insert({
      brokerage_id: brokerageId,
      agent_id: agentId,
      contact_id: contactId,
      activity_type: "market_update_sent",
      title: "Market update sent",
      description: messageBody.substring(0, 200),
      notes: JSON.stringify({ message_id: message.id, kernel_event: KernelEvent.MARKET_UPDATE_SENT }),
      status: "completed",
      entity_type: "contact",
    }),
    "the message row and the touchpoint ledger above are the record of the send and both are error-checked; this timeline echo must not fail a market update that already went out. The old rejection handler could not see a REFUSED row at all — bestEffort logs both.",
  )

  return { success: true, message }
}

/**
 * Get lifetime customers with engagement scores
 */
export async function getLifetimeCustomers({
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

  // IDENTITY GUARD — carried from app/actions/lifetime-customer-touchpoints.ts
  // :getLifetimeCustomerContacts, the unwired duplicate of this reader that was
  // removed in its favour (see the tombstone in that file). Without it a caller
  // with no agents row issued `.eq("agent_id", null)` — `agent_id=eq.null` on
  // the wire, which matches nothing — and the screen said "no lifetime
  // customers" for what is actually "we could not identify you".
  if (!agentId || !brokerageId) {
    return { success: false, error: "Agent context not available" }
  }

  // Get lifetime customers (contacts with closed transactions)
  // Fetch contacts first, then get their closed transactions separately
  const { data: contacts, error: contactError } = await supabase
    .from("contacts")
    .select("*")
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)

  if (contactError || !contacts) {
    console.error("Error fetching contacts:", contactError)
    return { success: false, error: contactError?.message }
  }

  // Filter by search if provided
  let filteredContacts = contacts
  if (search) {
    const searchLower = search.toLowerCase()
    filteredContacts = contacts.filter(c =>
      (c.first_name?.toLowerCase().includes(searchLower)) ||
      (c.last_name?.toLowerCase().includes(searchLower)) ||
      (c.email?.toLowerCase().includes(searchLower))
    )
  }

  if (filteredContacts.length === 0) {
    return { success: true, data: [] }
  }

  // Get closed transactions for these contacts
  const contactIds = filteredContacts.map(c => c.id)
  const { data: transactions, error: transError } = await supabase
    .from("transactions")
    .select("id, contact_id, actual_close_date:close_date, status, property_address, sale_price:purchase_price")
    .in("contact_id", contactIds)
    .eq("status", "closed")

  if (transError) {
    console.error("Error fetching transactions:", transError)
    return { success: false, error: transError.message }
  }

  // Get engagement scores for these contacts
  const { data: engagementScores } = await supabase
    .from("client_engagement_scores")
    .select("contact_id, engagement_score:score, last_touchpoint_date:last_interaction, computed_at:calculated_at, referrals_given, touchpoints_count")
    .in("contact_id", contactIds)

  // Merge data together
  const transactionMap = new Map()
  ;(transactions || []).forEach(t => {
    if (!transactionMap.has(t.contact_id)) {
      transactionMap.set(t.contact_id, [])
    }
    transactionMap.get(t.contact_id).push(t)
  })

  const engagementMap = new Map(
    (engagementScores || []).map(e => [e.contact_id, e])
  )

  let pastClients = filteredContacts
    .filter(c => transactionMap.has(c.id)) // Only include contacts with closed transactions
    .map(c => ({
      ...c,
      transactions: transactionMap.get(c.id) || [],
      client_engagement_scores: engagementMap.get(c.id) ? [engagementMap.get(c.id)] : []
    }))
    // MOST-RECENT-CLOSING FIRST — carried from the removed duplicate
    // (lifetime-customer-touchpoints.ts:getLifetimeCustomerContacts). This
    // returned rows in whatever order PostgREST handed back, so the client the
    // agent closed last week could sit below one from four years ago. The
    // transaction alias here is `actual_close_date`, which is the same
    // `close_date` column the duplicate sorted on.
    .sort((a, b) => {
      const latest = (c: any) => {
        const times = (c.transactions ?? [])
          .map((t: any) => new Date(t.actual_close_date).getTime())
          .filter((n: number) => Number.isFinite(n))
        return times.length ? Math.max(...times) : 0
      }
      return latest(b) - latest(a)
    })


  return { success: true, clients: pastClients }
}

/**
 * Get touchpoint timeline for a contact
 */
export async function getTouchpointTimeline(contactId: string) {
  const supabase = await createClient()
  const { agentId, brokerageId } = await getAgentContext()

  const { data, error } = await supabase
    .from("lifetime_customer_touchpoints")
    .select("*")
    .eq("contact_id", contactId)
    .eq("agent_id", agentId)
    .eq("brokerage_id", brokerageId)
    .order("sent_date", { ascending: false })
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
  const context = await getAgentContext()
  if (!context?.agentId) {
    return { success: false, error: "Agent context not available", anniversaries: [] }
  }

  const { agentId } = context
  const supabase = await createClient()

  const today = new Date()
  const thirtyDaysFromNow = new Date(today)
  thirtyDaysFromNow.setDate(thirtyDaysFromNow.getDate() + 30)

  // Query transactions owned by agent with close dates
  // Use close_date column (actual_close_date doesn't exist in schema)
  const { data: transactions, error } = await supabase
    .from("transactions")
    .select(`
      id,
      close_date,
      property_address,
      purchase_price,
      agent_id,
      contact_id
    `)
    .eq("agent_id", agentId)
    .eq("status", "closed")
    .not("close_date", "is", null)

  if (error) {
    console.error("Error fetching anniversaries:", error)
    return { success: false, error: error.message, anniversaries: [] }
  }

  // Fetch contacts separately to avoid relationship ambiguity
  let transactionsWithContacts = transactions || []
  if (transactionsWithContacts.length > 0) {
    const contactIds = transactionsWithContacts
      .map(t => t.contact_id)
      .filter(Boolean)
    
    if (contactIds.length > 0) {
      const { data: contacts } = await supabase
        .from("contacts")
        .select("id, first_name, last_name, email, phone")
        .in("id", contactIds)

      const contactMap = new Map(contacts?.map(c => [c.id, c]) || [])
      transactionsWithContacts = transactionsWithContacts.map(t => ({
        ...t,
        contacts: contactMap.get(t.contact_id),
        // Map purchase_price to sale_price for component compatibility
        sale_price: t.purchase_price,
        actual_close_date: t.close_date
      }))
    }
  }

  // Filter for anniversary dates
  const upcomingAnniversaries = transactionsWithContacts.filter((t) => {
    if (!t.close_date) return false
    const closeDate = new Date(t.close_date)
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
      scheduled_date: scheduledFor.split("T")[0], // real column is scheduled_date (date)
      message_template: notes ?? null, // no notes column; store in message_template
      status: "scheduled", // CHECK: scheduled|sent|completed|skipped|failed
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

  // Get contact info and last touchpoint.
  //
  // AMBIGUOUS EMBED — the `!transactions_contact_id_fkey` hint is load-bearing.
  // `transactions` carries THREE foreign keys to `contacts`
  // (transactions_contact_id_fkey, transactions_buyer_contact_id_fkey,
  // transactions_seller_contact_id_fkey), so the bare `transactions(...)` this
  // replaces could not be resolved and PostgREST refused the ENTIRE request with
  // PGRST201 — taking the engagement scores down with it. The guard below then
  // answered "Contact not found" for every lifetime customer, so this surface has
  // only ever emitted the final `newsletter` fallback suggestion.
  //
  // `contact_id` is the party WE represent on the deal (documented on the canonical
  // writer, lib/transactions/offer-bridge.ts:302) and is the same FK the sibling
  // sphere actions this file imports from already name
  // (app/actions/ai-sphere-management.ts:46). A lifetime customer is a past client of
  // ours whether they bought or sold, so buyer_contact_id would drop every seller-side
  // client and seller_contact_id every buyer-side one — and the anniversary touchpoint
  // is owed to both.
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select(`
      first_name, last_name,
      client_engagement_scores(engagement_score:score, last_touchpoint_date:last_interaction),
      transactions!transactions_contact_id_fkey(actual_close_date:close_date, property_address)
    `)
    .eq("id", contactId)
    .single()

  // Fail CLOSED and distinguish the two cases — supabase-js resolves a refused read,
  // and a refusal is not a missing contact.
  if (contactError) {
    return { success: false, error: `Could not read that contact: ${contactError.message}` }
  }
  if (!contact) {
    return { success: false, error: "Contact not found" }
  }

  const lastTouchpointDate = contact.client_engagement_scores?.[0]?.last_touchpoint_date
  const engagementScore = contact.client_engagement_scores?.[0]?.engagement_score || 50
  // Embedded rows come back UNORDERED, so `[0]` was an arbitrary deal. The
  // anniversary worth congratulating is the MOST RECENT close — the home they are
  // living in now, not one they moved out of years ago.
  const closeDate = (contact.transactions ?? [])
    .map((t: any) => t.actual_close_date)
    .filter(Boolean)
    .sort()
    .reverse()[0] as string | undefined

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

// ============================================
// SPHERE INTELLIGENCE WRAPPERS
// ============================================

export async function scoreSphereEngagement() {
  const { agentId } = await getAgentContext()
  return aiScoreSphereEngagement({ agentId: agentId ?? "" })
}

export async function segmentSphere() {
  const { agentId } = await getAgentContext()
  return aiSegmentSphere({ agentId: agentId ?? "" })
}

export async function getUpcomingMilestones(daysAhead = 30) {
  const { agentId } = await getAgentContext()
  return aiGetUpcomingMilestones({ agentId: agentId ?? "", daysAhead })
}

export async function generateTouchpoint(params: {
  contactId: string
  touchpointType: 'anniversary' | 'birthday' | 'check_in' | 'market_update' | 'holiday' | 'referral_ask'
}) {
  const { agentId } = await getAgentContext()
  return aiGenerateTouchpoint({ agentId: agentId ?? "", ...params })
}

export async function optimizeReferralAsk(contactId: string) {
  const { agentId } = await getAgentContext()
  return aiOptimizeReferralAsk({ agentId: agentId ?? "", contactId })
}

export async function getLifeChangeSignals(daysBack = 7) {
  try {
    const { agentId } = await getAgentContext()
    return await getRecentLifeChanges(agentId ?? "", daysBack)
  } catch {
    return []
  }
}

export async function findReferralOpportunities() {
  const { agentId } = await getAgentContext()
  return identifyReferralOpportunities(agentId ?? "")
}
