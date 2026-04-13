"use server"

import { createClient } from "@/lib/supabase/server"
import { generateObject } from "@/lib/ai/generate"
import { z } from "zod"
import { isValidUUID } from "@/lib/validations"
import { handleError } from "@/lib/errors"
import { revalidatePath } from "next/cache"

/**
 * AI Agent Goals System
 * Goal setting, progress tracking, and AI-coached recommendations.
 * Uses the agent_goals table: id, agent_id, brokerage_id, year, goal_type,
 * target_value, current_value, notes, created_at, updated_at.
 */

// ============================================================================
// GET AGENT GOALS
// ============================================================================

export async function getAgentGoals(params: {
  agentId:    string
  brokerageId: string
  year?:      number
}) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.brokerageId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase  = await createClient()
  const year      = params.year ?? new Date().getFullYear()

  try {
    const { data, error } = await supabase
      .from("agent_goals")
      .select("*")
      .eq("agent_id",     params.agentId)
      .eq("brokerage_id", params.brokerageId)
      .eq("year",         year)
      .order("goal_type", { ascending: true })

    if (error) throw error

    return { success: true, data: data ?? [] }
  } catch (error) {
    return handleError(error, "getAgentGoals")
  }
}

// ============================================================================
// UPSERT GOAL
// ============================================================================

export async function upsertAgentGoal(params: {
  agentId:      string
  brokerageId:  string
  goalType:     string
  targetValue:  number
  year?:        number
  notes?:       string
}) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.brokerageId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()
  const year     = params.year ?? new Date().getFullYear()

  try {
    const { data, error } = await supabase
      .from("agent_goals")
      .upsert(
        {
          agent_id:     params.agentId,
          brokerage_id: params.brokerageId,
          year,
          goal_type:    params.goalType,
          target_value: params.targetValue,
          current_value: 0,
          notes:         params.notes ?? null,
          updated_at:    new Date().toISOString(),
        },
        { onConflict: "agent_id,brokerage_id,year,goal_type" }
      )
      .select()
      .single()

    if (error) throw error

    revalidatePath("/dashboard")
    return { success: true, data }
  } catch (error) {
    return handleError(error, "upsertAgentGoal")
  }
}

// ============================================================================
// UPDATE GOAL PROGRESS
// ============================================================================

export async function updateGoalProgress(params: {
  goalId:       string
  agentId:      string
  currentValue: number
}) {
  if (!isValidUUID(params.goalId) || !isValidUUID(params.agentId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()

  try {
    const { data, error } = await supabase
      .from("agent_goals")
      .update({
        current_value: params.currentValue,
        updated_at:    new Date().toISOString(),
      })
      .eq("id",       params.goalId)
      .eq("agent_id", params.agentId)
      .select()
      .single()

    if (error) throw error

    revalidatePath("/dashboard")
    return { success: true, data }
  } catch (error) {
    return handleError(error, "updateGoalProgress")
  }
}

// ============================================================================
// AI GOAL SETTING RECOMMENDATIONS
// ============================================================================

export async function aiRecommendGoals(params: {
  agentId:     string
  brokerageId: string
  year?:       number
}) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.brokerageId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()
  const year     = params.year ?? new Date().getFullYear()

  try {
    // Pull prior year performance
    const { data: priorGoals } = await supabase
      .from("agent_goals")
      .select("goal_type, target_value, current_value")
      .eq("agent_id",     params.agentId)
      .eq("brokerage_id", params.brokerageId)
      .eq("year",         year - 1)

    const { data: earningsRow } = await supabase
      .from("agent_earnings")
      .select("gross_commission, transaction_count, cap_status, period_label")
      .eq("agent_id",     params.agentId)
      .eq("brokerage_id", params.brokerageId)
      .order("computed_at", { ascending: false })
      .limit(1)
      .maybeSingle()

    const { data: agent } = await supabase
      .from("agents")
      .select("years_experience, ytd_transactions, ytd_gci, listings_active")
      .eq("id", params.agentId)
      .maybeSingle()

    const { object: recommendations } = await generateObject({
      model: "openai/gpt-4o",
      schema: z.object({
        goals: z.array(z.object({
          goal_type:    z.string(),
          target_value: z.number(),
          rationale:    z.string(),
          strategy:     z.string(),
          milestones:   z.array(z.object({
            month: z.number().int().min(1).max(12),
            value: z.number(),
          })),
        })),
        overallStrategy: z.string(),
        primaryFocus:    z.string(),
        quickWins:       z.array(z.string()),
        riskFactors:     z.array(z.string()),
      }),
      prompt: `Recommend annual goals for ${year} based on this agent's performance:

Years of experience: ${agent?.years_experience ?? "Unknown"}
YTD transactions: ${agent?.ytd_transactions ?? 0}
YTD GCI: $${agent?.ytd_gci?.toLocaleString() ?? 0}
Active listings: ${agent?.listings_active ?? 0}
Cap status: ${earningsRow?.cap_status ?? "Unknown"}
Prior year gross commission: $${earningsRow?.gross_commission?.toLocaleString() ?? 0}
Prior year transactions: ${earningsRow?.transaction_count ?? 0}

Prior year goal performance:
${priorGoals?.map((g) => `- ${g.goal_type}: ${g.current_value}/${g.target_value} (${Math.round((g.current_value / g.target_value) * 100)}%)`).join("\n") || "No prior goals set"}

Generate goals for:
- transactions (number of closed deals)
- gci (gross commission income in dollars)  
- listings_taken (listing appointments converted)
- buyer_clients (new buyer clients signed)
- referrals_generated (referrals received)
- reviews_requested (review requests sent)

For each goal:
1. Set a realistic yet ambitious target based on prior performance
2. Provide rationale for the target
3. Suggest a monthly milestone breakdown
4. Outline the strategy to hit it`,
    })

    return { success: true, data: recommendations }
  } catch (error) {
    return handleError(error, "aiRecommendGoals")
  }
}

// ============================================================================
// AI GOAL COACHING
// ============================================================================

export async function aiCoachGoalProgress(params: {
  agentId:     string
  brokerageId: string
  year?:       number
}) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.brokerageId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()
  const year     = params.year ?? new Date().getFullYear()
  const month    = new Date().getMonth() + 1

  try {
    const { data: goals } = await supabase
      .from("agent_goals")
      .select("*")
      .eq("agent_id",     params.agentId)
      .eq("brokerage_id", params.brokerageId)
      .eq("year",         year)

    if (!goals || goals.length === 0) {
      return { success: false, error: "No goals set for this year" }
    }

    const { object: coaching } = await generateObject({
      model: "openai/gpt-4o-mini",
      schema: z.object({
        overallStatus:   z.enum(["on_track", "slightly_behind", "behind", "at_risk", "ahead"]),
        overallScore:    z.number().min(0).max(100),
        byGoal: z.array(z.object({
          goal_type:   z.string(),
          status:      z.enum(["on_track", "slightly_behind", "behind", "at_risk", "ahead"]),
          paceNeeded:  z.number().describe("Units needed per remaining month to hit goal"),
          coaching:    z.string(),
        })),
        topPriority:        z.string(),
        weeklyActions:      z.array(z.string()),
        motivationalMessage: z.string(),
      }),
      prompt: `Coach this agent on their ${year} goal progress (currently month ${month}):

${goals.map((g) => {
  const pct   = g.target_value > 0 ? Math.round((g.current_value / g.target_value) * 100) : 0
  const expectedPct = Math.round((month / 12) * 100)
  return `- ${g.goal_type}: ${g.current_value}/${g.target_value} (${pct}% actual vs ${expectedPct}% expected pace)`
}).join("\n")}

Provide:
1. Overall performance status
2. Per-goal coaching with specific actions
3. The single highest-priority focus area
4. 3-5 concrete weekly actions to get back on track or accelerate
5. An encouraging but honest motivational message`,
    })

    return { success: true, data: coaching }
  } catch (error) {
    return handleError(error, "aiCoachGoalProgress")
  }
}

// ============================================================================
// SYNC GOAL CURRENT VALUES FROM LIVE DATA
// ============================================================================

export async function syncGoalCurrentValues(params: {
  agentId:     string
  brokerageId: string
  year?:       number
}) {
  if (!isValidUUID(params.agentId) || !isValidUUID(params.brokerageId)) {
    return { success: false, error: "Invalid IDs" }
  }

  const supabase = await createClient()
  const year     = params.year ?? new Date().getFullYear()
  const yearStart = `${year}-01-01`
  const yearEnd   = `${year}-12-31`

  try {
    const [
      { count: transactionCount },
      { data: commissionData },
      { count: listingCount },
      { count: referralCount },
      { count: reviewCount },
    ] = await Promise.all([
      supabase
        .from("transactions")
        .select("id", { count: "exact", head: true })
        .eq("agent_id",     params.agentId)
        .eq("brokerage_id", params.brokerageId)
        .eq("status",       "closed")
        .gte("close_date",  yearStart)
        .lte("close_date",  yearEnd),
      supabase
        .from("agent_commissions")
        .select("agent_commission")
        .eq("agent_id",     params.agentId)
        .eq("brokerage_id", params.brokerageId)
        .gte("close_date",  yearStart)
        .lte("close_date",  yearEnd),
      supabase
        .from("listings")
        .select("id", { count: "exact", head: true })
        .eq("agent_id",     params.agentId)
        .eq("brokerage_id", params.brokerageId)
        .gte("created_at",  yearStart)
        .lte("created_at",  yearEnd),
      supabase
        .from("referrals")
        .select("id", { count: "exact", head: true })
        .eq("agent_id",     params.agentId)
        .eq("brokerage_id", params.brokerageId)
        .gte("created_at",  yearStart)
        .lte("created_at",  yearEnd),
      supabase
        .from("review_requests")
        .select("id", { count: "exact", head: true })
        .eq("agent_id",     params.agentId)
        .eq("brokerage_id", params.brokerageId)
        .gte("created_at",  yearStart)
        .lte("created_at",  yearEnd),
    ])

    const totalGCI = commissionData?.reduce((sum, r) => sum + (r.agent_commission ?? 0), 0) ?? 0

    const liveValues: Record<string, number> = {
      transactions:      transactionCount   ?? 0,
      gci:               totalGCI,
      listings_taken:    listingCount       ?? 0,
      referrals_generated: referralCount    ?? 0,
      reviews_requested: reviewCount        ?? 0,
    }

    // Batch update current_value for each goal type that has live data
    const updates = await Promise.all(
      Object.entries(liveValues).map(([goalType, currentValue]) =>
        supabase
          .from("agent_goals")
          .update({ current_value: currentValue, updated_at: new Date().toISOString() })
          .eq("agent_id",     params.agentId)
          .eq("brokerage_id", params.brokerageId)
          .eq("year",         year)
          .eq("goal_type",    goalType)
      )
    )

    const errors = updates.filter((r) => r.error)
    if (errors.length > 0) {
      console.error("[v0] syncGoalCurrentValues partial errors:", errors)
    }

    revalidatePath("/dashboard")
    return { success: true, data: liveValues }
  } catch (error) {
    return handleError(error, "syncGoalCurrentValues")
  }
}
