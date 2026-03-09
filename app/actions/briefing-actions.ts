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
    const { agentId, brokerageId } = await getAgentContext()
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
    const { agentId, brokerageId } = await getAgentContext()

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
    const { agentId } = await getAgentContext()

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
    const { userId } = await getAgentContext()
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
    const { agentId } = await getAgentContext()
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
        listing:listings(id, address, city, state),
        contact:contacts(id, first_name, last_name, phone, email)
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

    return { showings: data || [] }
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
    const { agentId } = await getAgentContext()
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
        contact:contacts(id, first_name, last_name)
      `)
      .eq("agent_id", agentId)
      .not("stage", "in", '("closed","cancelled")')
      .order("close_date", { ascending: true })
      .limit(10)

    if (error) {
      console.error("[BriefingActions] Error fetching transactions:", error)
      return { transactions: [], error: error.message }
    }

    // Get deal health scores
    const transactionIds = (data || []).map((t) => t.id)
    if (transactionIds.length > 0) {
      const { data: healthScores } = await supabase
        .from("deal_health_scores")
        .select("transaction_id, overall_score, risk_level")
        .in("transaction_id", transactionIds)

      // Merge health scores into transactions
      const healthMap = new Map(
        (healthScores || []).map((h) => [h.transaction_id, h])
      )

      return {
        transactions: (data || []).map((t) => ({
          ...t,
          deal_health: healthMap.get(t.id) || null,
        })),
      }
    }

    return { transactions: data || [] }
  } catch (err) {
    console.error("[BriefingActions] getActiveTransactions failed:", err)
    return { transactions: [], error: err instanceof Error ? err.message : "Unknown error" }
  }
}
