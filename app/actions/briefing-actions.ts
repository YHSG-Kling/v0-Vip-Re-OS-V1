"use server"

import { getAgentContext } from "@/lib/identity/get-agent-context"
import {
  generateDailyBriefing,
  markBriefingOpened,
  type DailyBriefing,
} from "@/lib/intelligence/daily-briefing-generator"
import { createClient } from "@/lib/supabase/server"

// ─── Get Today's Briefing ─────────────────────────────────────────────────────

export async function getTodaysBriefing(): Promise<{
  briefing: DailyBriefing | null
  error?: string
}> {
  try {
    const context = await getAgentContext()
    if (!context?.agentId) {
      return { briefing: null, error: "Agent context not available" }
    }
    
    const { agentId, brokerageId } = context
    const supabase = await createClient()
    const today = new Date().toISOString().split("T")[0]

    const { data: existing, error } = await supabase
      .from("ai_daily_briefings")
      .select("*")
      .eq("agent_id", agentId)
      .eq("briefing_date", today)
      .maybeSingle()

    if (error) {
      console.error("[BriefingActions] Error fetching briefing:", error)
      return { briefing: null, error: error.message }
    }

    return { briefing: existing as DailyBriefing | null }
  } catch (err) {
    console.error("[BriefingActions] getTodaysBriefing failed:", err)
    return { briefing: null, error: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ─── Generate or Regenerate Briefing ──────────────────────────────────────────

export async function generateBriefing(
  forceRegenerate: boolean = false
): Promise<{
  briefing: DailyBriefing | null
  error?: string
}> {
  try {
    const context = await getAgentContext()
    if (!context?.agentId) {
      return { briefing: null, error: "Agent context not available" }
    }
    
    const { agentId, brokerageId } = context

    const briefing = await generateDailyBriefing(agentId, brokerageId, forceRegenerate)

    return { briefing }
  } catch (err) {
    console.error("[BriefingActions] generateBriefing failed:", err)
    return { briefing: null, error: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ─── Mark Briefing as Viewed ──────────────────────────────────────────────────

export async function markBriefingViewed(): Promise<{ success: boolean; error?: string }> {
  try {
    const context = await getAgentContext()
    if (!context?.agentId) {
      return { success: false, error: "Agent context not available" }
    }
    
    const { agentId } = context

    await markBriefingOpened(agentId)

    return { success: true }
  } catch (err) {
    console.error("[BriefingActions] markBriefingViewed failed:", err)
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ─── Get Agent Name ───────────────────────────────────────────────────────────

export async function getAgentName(): Promise<{ name: string; error?: string }> {
  try {
    const context = await getAgentContext()
    if (!context?.userId) {
      return { name: "Agent" }
    }
    
    const { userId } = context
    const supabase = await createClient()

    const { data: user, error } = await supabase
      .from("users")
      .select("first_name, last_name")
      .eq("id", userId)
      .single()

    if (error || !user) {
      return { name: "Agent" }
    }

    const firstName = user.first_name || ""
    const lastName = user.last_name || ""
    const fullName = `${firstName} ${lastName}`.trim()

    return { name: fullName || "Agent" }
  } catch (err) {
    console.error("[BriefingActions] getAgentName failed:", err)
    return { name: "Agent", error: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ─── Get Showings for Next 2 Days ─────────────────────────────────────────────

export async function getUpcomingShowings(): Promise<{
  showings: any[]
  error?: string
}> {
  try {
    const context = await getAgentContext()
    if (!context?.agentId) {
      return { showings: [], error: "Agent context not available" }
    }
    
    const { agentId } = context
    const supabase = await createClient()

    const twoDaysOut = new Date()
    twoDaysOut.setDate(twoDaysOut.getDate() + 2)

    const { data, error } = await supabase
      .from("showings")
      .select(`
        id,
        scheduled_at,
        status,
        notes,
        listing_id,
        contact_id
      `)
      .eq("agent_id", agentId)
      .gte("scheduled_at", new Date().toISOString())
      .lte("scheduled_at", twoDaysOut.toISOString())
      .order("scheduled_at", { ascending: true })
      .limit(10)

    if (error) {
      console.error("[BriefingActions] Error fetching showings:", error)
      return { showings: [], error: error.message }
    }

    // Fetch related listings and contacts separately
    let enrichedShowings = data || []
    if (enrichedShowings.length > 0) {
      const listingIds = enrichedShowings.map(s => s.listing_id).filter(Boolean)
      const contactIds = enrichedShowings.map(s => s.contact_id).filter(Boolean)

      let listingsMap = new Map()
      let contactsMap = new Map()

      if (listingIds.length > 0) {
        const { data: listings } = await supabase
          .from("listings")
          .select("id, address, city, state")
          .in("id", listingIds)
        listingsMap = new Map(listings?.map(l => [l.id, l]) || [])
      }

      if (contactIds.length > 0) {
        const { data: contacts } = await supabase
          .from("contacts")
          .select("id, first_name, last_name, phone, email")
          .in("id", contactIds)
        contactsMap = new Map(contacts?.map(c => [c.id, c]) || [])
      }

      enrichedShowings = enrichedShowings.map(s => ({
        ...s,
        listing: listingsMap.get(s.listing_id),
        contact: contactsMap.get(s.contact_id)
      }))
    }

    return { showings: enrichedShowings }
  } catch (err) {
    console.error("[BriefingActions] getUpcomingShowings failed:", err)
    return { showings: [], error: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ─── Get Active Transactions ──────────────────────────────────────────────────

export async function getActiveTransactions(): Promise<{
  transactions: any[]
  error?: string
}> {
  try {
    const context = await getAgentContext()
    if (!context?.agentId) {
      return { transactions: [], error: "Agent context not available" }
    }
    
    const { agentId } = context
    const supabase = await createClient()

    const { data, error } = await supabase
      .from("transactions")
      .select(`
        id,
        deal_name,
        property_address,
        stage,
        purchase_price,
        close_date,
        health_score,
        contact_id
      `)
      .eq("agent_id", agentId)
      .not("stage", "in", '("closed","cancelled")')
      .order("close_date", { ascending: true })
      .limit(10)

    if (error) {
      console.error("[BriefingActions] Error fetching transactions:", error)
      return { transactions: [], error: error.message }
    }

    // Fetch related contacts and deal health scores separately
    let enrichedTransactions = data || []
    if (enrichedTransactions.length > 0) {
      const contactIds = enrichedTransactions.map(t => t.contact_id).filter(Boolean)
      const transactionIds = enrichedTransactions.map(t => t.id)

      let contactsMap = new Map()
      let healthMap = new Map()

      if (contactIds.length > 0) {
        const { data: contacts } = await supabase
          .from("contacts")
          .select("id, first_name, last_name")
          .in("id", contactIds)
        contactsMap = new Map(contacts?.map(c => [c.id, c]) || [])
      }

      if (transactionIds.length > 0) {
        const { data: healthScores } = await supabase
          .from("deal_health_scores")
          .select("transaction_id, overall_score, risk_level")
          .in("transaction_id", transactionIds)
        healthMap = new Map(
          (healthScores || []).map((h) => [h.transaction_id, h])
        )
      }

      enrichedTransactions = enrichedTransactions.map(t => ({
        ...t,
        contact: contactsMap.get(t.contact_id),
        deal_health: healthMap.get(t.id) || null,
      }))
    }

    return { transactions: enrichedTransactions }
  } catch (err) {
    console.error("[BriefingActions] getActiveTransactions failed:", err)
    return { transactions: [], error: err instanceof Error ? err.message : "Unknown error" }
  }
}
