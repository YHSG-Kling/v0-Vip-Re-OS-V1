"use server"

import { getAgentContext } from "@/lib/identity/get-agent-context"
import {
  generateDailyBriefing,
  markBriefingOpened,
  type DailyBriefing,
} from "@/lib/intelligence/daily-briefing-generator"
import {
  generateUserTypeBrief,
  type UserTypeBrief,
} from "@/lib/intelligence/user-type-briefs"
import { createClient } from "@/lib/supabase/server"

// Helper to validate UUID is not null/undefined/"null"/"undefined"
function isValidUUID(id: any): id is string {
  return typeof id === "string" && Boolean(id) && id !== "null" && id !== "undefined"
}

// ─── Get Today's Briefing ─────────────────────────────────────────────────────

export async function getTodaysBriefing(): Promise<{
  briefing: DailyBriefing | null
  error?: string
}> {
  try {
    const context = await getAgentContext()
    if (!context?.agentId || !isValidUUID(context.agentId)) {
      // Incomplete account (no agent record yet) — this is the READ path feeding the
      // briefing card, which renders null as a clean "No briefing for today" empty
      // state. Surfacing a raw "Agent context not available" error made the card read
      // "failed to load" instead. Degrade gracefully.
      return { briefing: null }
    }

    const supabase = await createClient()
    const today = new Date().toISOString().split("T")[0]

    // THE BRIEFING IS KEYED ON users.id, NOT agents.id.
    //
    // This read filtered `agent_id`, and the generator — the ONLY writer of a
    // briefing row — has never written that column. It says so at
    // lib/intelligence/daily-briefing-generator.ts:802-806: "user_id (FK→users.id)
    // is the briefing key. The legacy agent_id column has FK→agents.id — writing
    // users.id there violated the FK, the upsert THREW, and briefings never
    // cached". `markBriefingOpened` (same file, :922-936) and the quarterly
    // review loader (lib/intelligence/quarterly-review-loader.ts:155) both key on
    // user_id too. So this card asked for a row under a key nothing writes and
    // rendered its clean "No briefing for today" empty state seconds after a
    // briefing had been generated and cached.
    //
    // The two id spaces are DISJOINT (§3), so this is not a cosmetic rename:
    // agentId would never match a briefing and userId always will.
    const { data: existing, error } = await supabase
      .from("ai_daily_briefings")
      .select("*")
      .eq("user_id", context.userId)
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
    if (!context?.agentId || !isValidUUID(context.agentId)) {
      return { briefing: null, error: "Agent context not available" }
    }
    
    const { agentId, brokerageId } = context

    if (!brokerageId || !isValidUUID(brokerageId)) return { briefing: null, error: "Missing brokerage context" }

    const briefing = await generateDailyBriefing(agentId, brokerageId, forceRegenerate)

    return { briefing }
  } catch (err) {
    console.error("[BriefingActions] generateBriefing failed:", err)
    return { briefing: null, error: err instanceof Error ? err.message : "Unknown error" }
  }
}

// ─── Get UserTypeBrief (TodaysFocusCard data) ────────────────────────────────
// Returns the role-aware brief shape consumed by <TodaysFocusCard>. Used by
// the agent dashboard (client component) which can't call generateUserTypeBrief
// directly. Other staff dashboards (broker, TC, compliance, lender, vendor)
// are server components and call generateUserTypeBrief inline.

export async function getUserTypeBrief(input?: {
  userType?: "agent" | "broker" | "TC" | "compliance" | "lender" | "vendor" | "superadmin"
}): Promise<{ brief: UserTypeBrief | null; error?: string }> {
  try {
    const context = await getAgentContext()
    if (!context?.userId || !isValidUUID(context.userId)) {
      return { brief: null, error: "Not authenticated" }
    }
    const userType = input?.userType ?? "agent"
    const brief = await generateUserTypeBrief({
      userType,
      userId: context.userId,
      brokerageId: context.brokerageId ?? null,
    })
    return { brief }
  } catch (err) {
    console.error("[BriefingActions] getUserTypeBrief failed:", err)
    return { brief: null, error: err instanceof Error ? err.message : "Unknown error" }
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
    if (!context?.agentId || !isValidUUID(context.agentId)) {
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
    if (!context?.agentId || !isValidUUID(context.agentId)) {
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

// ─── Get Pipeline Summary ──────────────────────────────────────────────────────

export async function getPipelineSummary(): Promise<{
  activeCount: number
  approachingClose: { id: string; property_address: string; close_date: string } | null
  error?: string
}> {
  try {
    const context = await getAgentContext()
    if (!context?.agentId || !isValidUUID(context.agentId)) {
      return { activeCount: 0, approachingClose: null, error: "Agent context not available" }
    }

    const { agentId } = context
    const supabase = await createClient()

    // Use a count query for accurate total — never capped by .limit()
    const { count: totalActive, error: countError } = await supabase
      .from("transactions")
      .select("*", { count: "exact", head: true })
      .eq("agent_id", agentId)
      .not("stage", "in", '("closed","cancelled")')

    if (countError) {
      return { activeCount: 0, approachingClose: null, error: countError.message }
    }

    // Separately fetch the soonest-closing transaction within 14 days (limit 1)
    const twoWeeksOut = new Date()
    twoWeeksOut.setDate(twoWeeksOut.getDate() + 14)
    const today = new Date().toISOString().split("T")[0]

    const { data: nearestData, error: nearestError } = await supabase
      .from("transactions")
      .select("id, property_address, close_date, stage")
      .eq("agent_id", agentId)
      .not("stage", "in", '("closed","cancelled")')
      .not("close_date", "is", null)
      .gte("close_date", today)
      .lte("close_date", twoWeeksOut.toISOString().split("T")[0])
      .order("close_date", { ascending: true })
      .limit(1)

    if (nearestError) {
      return { activeCount: totalActive ?? 0, approachingClose: null, error: nearestError.message }
    }

    const approaching = nearestData?.[0] ?? null

    return {
      activeCount: totalActive ?? 0,
      approachingClose: approaching
        ? {
            id: approaching.id,
            property_address: approaching.property_address || "Unknown address",
            close_date: approaching.close_date,
          }
        : null,
    }
  } catch (err) {
    console.error("[BriefingActions] getPipelineSummary failed:", err)
    return {
      activeCount: 0,
      approachingClose: null,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}

// ─── Get Buyer Matches ─────────────────────────────────────────────────────────

export async function getBuyerMatchCount(): Promise<{
  matchCount: number
  error?: string
}> {
  try {
    const context = await getAgentContext()
    if (!context?.agentId || !isValidUUID(context.agentId)) {
      return { matchCount: 0, error: "Agent context not available" }
    }

    const { agentId } = context
    const supabase = await createClient()

    // Count buyer contacts who have an active search criteria and an active listing to match
    // We approximate this by counting contacts tagged as buyer with active/hot status
    // who have a budget range set (search criteria)
    //
    // `contacts` stores the buyer's search range as budget_min / budget_max — it has no
    // min_price / max_price column (those names live on property_preferences-style tables,
    // not here). PostgREST rejects the ENTIRE request when an .or() string names a column the
    // table lacks, so this count never returned a number: it always came back as an error and
    // the morning briefing reported "0 buyer matches" for every agent, every day.
    const { count, error } = await supabase
      .from("contacts")
      .select("id", { count: "exact", head: true })
      .eq("agent_id", agentId)
      .in("contact_type", ["buyer"])
      .in("status", ["active", "hot", "nurture"])
      .or("budget_min.not.is.null,budget_max.not.is.null")

    if (error) {
      return { matchCount: 0, error: error.message }
    }

    return { matchCount: count ?? 0 }
  } catch (err) {
    console.error("[BriefingActions] getBuyerMatchCount failed:", err)
    return {
      matchCount: 0,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}

// ─── Get Churn Risk Contacts ───────────────────────────────────────────────────

export async function getChurnRiskContacts(): Promise<{
  contacts: Array<{
    id: string
    first_name: string | null
    last_name: string | null
    last_contacted_at: string | null
    status: string | null
  }>
  totalCount: number
  error?: string
}> {
  try {
    const context = await getAgentContext()
    if (!context?.agentId || !isValidUUID(context.agentId)) {
      return { contacts: [], totalCount: 0, error: "Agent context not available" }
    }

    const { agentId } = context
    const supabase = await createClient()

    // Contacts not touched in 30+ days that are still in active pipeline stages
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
    const thirtyDaysAgoStr = thirtyDaysAgo.toISOString().split("T")[0]

    const { data, count, error } = await supabase
      .from("contacts")
      .select("id, first_name, last_name, last_contacted_at, status", {
        count: "exact",
      })
      .eq("agent_id", agentId)
      .in("status", ["new", "nurture", "active", "qualified"])
      .or(`last_contacted_at.is.null,last_contacted_at.lte.${thirtyDaysAgoStr}`)
      .order("last_contacted_at", { ascending: true, nullsFirst: true })
      .limit(5)

    if (error) {
      return { contacts: [], totalCount: 0, error: error.message }
    }

    return {
      contacts: data || [],
      totalCount: count ?? 0,
    }
  } catch (err) {
    console.error("[BriefingActions] getChurnRiskContacts failed:", err)
    return {
      contacts: [],
      totalCount: 0,
      error: err instanceof Error ? err.message : "Unknown error",
    }
  }
}
