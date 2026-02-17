"use server"

import { createClient } from "@/lib/supabase/server"
import { revalidatePath } from "next/cache"
import { isValidUUID } from "@/lib/validations"

// ==================== AGENT CRUD ====================

export async function getAgents(brokerageId?: string) {
  const supabase = await createClient()

  let query = supabase
    .from("agents")
    .select(`
      *,
      user:users(id, name, email, avatar_url)
    `)
    .eq("is_active", true)
    .order("created_at", { ascending: false })

  if (brokerageId) {
    query = query.eq("brokerage_id", brokerageId)
  }

  const { data, error } = await query

  if (error) {
    console.error("Error fetching agents:", error)
    return []
  }

  return data || []
}

export async function getAgentById(agentId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("agents")
    .select(`
      *,
      user:users(id, name, email, avatar_url, phone),
      commissions:agent_commissions(*),
      expenses:agent_expenses(*),
      achievements:agent_achievements(*, achievement:achievements(*)),
      goals:agent_goals(*)
    `)
    .eq("id", agentId)
    .single()

  if (error) {
    console.error("Error fetching agent:", error)
    return null
  }

  return data
}

export async function createAgent(agentData: {
  user_id: string
  brokerage_id?: string
  license_number: string
  license_state: string
  license_expiry: string
  commission_split: number
  cap_amount?: number
  team_id?: string
}) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("agents")
    .insert({
      ...agentData,
      gamification_points: 0,
      ytd_gci: 0,
      ytd_transactions: 0,
      cap_progress: 0,
      is_active: true,
    })
    .select()
    .single()

  if (error) {
    console.error("Error creating agent:", error)
    return { error: error.message }
  }

  revalidatePath("/admin/agent-roster")
  return { data }
}

export async function updateAgent(
  agentId: string,
  updates: Partial<{
    license_number: string
    license_state: string
    license_expiry: string
    commission_split: number
    cap_amount: number
    team_id: string
    specializations: string[]
    bio: string
    is_active: boolean
  }>,
) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("agents")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", agentId)
    .select()
    .single()

  if (error) {
    console.error("Error updating agent:", error)
    return { error: error.message }
  }

  revalidatePath("/admin/agent-roster")
  return { data }
}

// ==================== GAMIFICATION ====================

export async function awardPoints(agentId: string, points: number, reason: string, category: string) {
  const supabase = await createClient()

  // Get current points
  const { data: agent } = await supabase.from("agents").select("gamification_points").eq("id", agentId).single()

  const currentPoints = agent?.gamification_points || 0
  const newPoints = currentPoints + points

  // Update agent points
  const { error: updateError } = await supabase
    .from("agents")
    .update({
      gamification_points: newPoints,
      updated_at: new Date().toISOString(),
    })
    .eq("id", agentId)

  if (updateError) {
    console.error("Error awarding points:", updateError)
    return { error: updateError.message }
  }

  // Log the points transaction
  const { error: logError } = await supabase.from("agent_points_log").insert({
    agent_id: agentId,
    points,
    reason,
    category,
    balance_after: newPoints,
  })

  if (logError) {
    console.error("Error logging points:", logError)
  }

  // Check for new achievements
  await checkAndAwardAchievements(agentId, newPoints)

  revalidatePath("/admin/agent-roster")
  return { data: { newPoints } }
}

export async function getLeaderboard(
  brokerageId?: string,
  period: "weekly" | "monthly" | "yearly" | "all_time" = "monthly",
) {
  const supabase = await createClient()

  let query = supabase
    .from("agents")
    .select(`
      id,
      gamification_points,
      ytd_gci,
      ytd_transactions,
      badges,
      user:users(id, name, email, avatar_url)
    `)
    .eq("is_active", true)
    .order("gamification_points", { ascending: false })
    .limit(20)

  if (brokerageId) {
    query = query.eq("brokerage_id", brokerageId)
  }

  const { data, error } = await query

  if (error) {
    console.error("Error fetching leaderboard:", error)
    return []
  }

  return data || []
}

export async function getAchievements() {
  const supabase = await createClient()

  const { data, error } = await supabase.from("achievements").select("*").order("points_required", { ascending: true })

  if (error) {
    console.error("Error fetching achievements:", error)
    return []
  }

  return data || []
}

export async function getAgentAchievements(agentId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("agent_achievements")
    .select(`
      *,
      achievement:achievements(*)
    `)
    .eq("agent_id", agentId)
    .order("earned_at", { ascending: false })

  if (error) {
    console.error("Error fetching agent achievements:", error)
    return []
  }

  return data || []
}

async function checkAndAwardAchievements(agentId: string, currentPoints: number) {
  const supabase = await createClient()

  // Get all achievements agent doesn't have yet
  const { data: unearned } = await supabase
    .from("achievements")
    .select("*")
    .lte("points_required", currentPoints)
    .not("id", "in", `(SELECT achievement_id FROM agent_achievements WHERE agent_id = '${agentId}')`)

  if (!unearned || unearned.length === 0) return

  // Award new achievements
  for (const achievement of unearned) {
    await supabase.from("agent_achievements").insert({
      agent_id: agentId,
      achievement_id: achievement.id,
      earned_at: new Date().toISOString(),
    })

    // Update badges array on agent
    const { data: agent } = await supabase.from("agents").select("badges").eq("id", agentId).single()

    const currentBadges = agent?.badges || []
    if (!currentBadges.includes(achievement.badge_icon)) {
      await supabase
        .from("agents")
        .update({
          badges: [...currentBadges, achievement.badge_icon],
          updated_at: new Date().toISOString(),
        })
        .eq("id", agentId)
    }
  }
}

// ==================== COMMISSION TRACKING ====================

export async function getAgentCommissions(agentId: string, year?: number) {
  const supabase = await createClient()

  const currentYear = year || new Date().getFullYear()
  const startDate = `${currentYear}-01-01`
  const endDate = `${currentYear}-12-31`

  const { data, error } = await supabase
    .from("agent_commissions")
    .select(`
      *,
      transaction:transactions(id, property_address, purchase_price, status)
    `)
    .eq("agent_id", agentId)
    .gte("close_date", startDate)
    .lte("close_date", endDate)
    .order("close_date", { ascending: false })

  if (error) {
    console.error("Error fetching agent commissions:", error)
    return []
  }

  return data || []
}

export async function addAgentCommission(commissionData: {
  agent_id: string
  transaction_id: string
  gross_commission: number
  agent_split_percent: number
  close_date: string
  side: "listing" | "buying" | "both"
}) {
  const supabase = await createClient()

  const agentCommission = commissionData.gross_commission * (commissionData.agent_split_percent / 100)
  const brokerageCommission = commissionData.gross_commission - agentCommission

  const { data, error } = await supabase
    .from("agent_commissions")
    .insert({
      ...commissionData,
      agent_commission: agentCommission,
      brokerage_commission: brokerageCommission,
      status: "pending",
    })
    .select()
    .single()

  if (error) {
    console.error("Error adding commission:", error)
    return { error: error.message }
  }

  // Update agent YTD stats
  await updateAgentYTDStats(commissionData.agent_id)

  // Award points for closing
  await awardPoints(commissionData.agent_id, 100, "Closed transaction", "transaction")

  revalidatePath("/admin/agent-roster")
  return { data }
}

export async function updateCommissionStatus(
  commissionId: string,
  status: "pending" | "paid" | "cancelled",
  paidDate?: string,
) {
  const supabase = await createClient()

  const updates: Record<string, unknown> = { status }
  if (paidDate) {
    updates.paid_date = paidDate
  }

  const { data, error } = await supabase
    .from("agent_commissions")
    .update(updates)
    .eq("id", commissionId)
    .select()
    .single()

  if (error) {
    console.error("Error updating commission status:", error)
    return { error: error.message }
  }

  revalidatePath("/admin/agent-roster")
  return { data }
}

async function updateAgentYTDStats(agentId: string) {
  const supabase = await createClient()

  const currentYear = new Date().getFullYear()
  const startDate = `${currentYear}-01-01`
  const endDate = `${currentYear}-12-31`

  // Get YTD commissions
  const { data: commissions } = await supabase
    .from("agent_commissions")
    .select("agent_commission")
    .eq("agent_id", agentId)
    .eq("status", "paid")
    .gte("close_date", startDate)
    .lte("close_date", endDate)

  const ytdGci = commissions?.reduce((sum, c) => sum + (c.agent_commission || 0), 0) || 0
  const ytdTransactions = commissions?.length || 0

  // Get agent cap
  const { data: agent } = await supabase.from("agents").select("cap_amount").eq("id", agentId).single()

  const capProgress = agent?.cap_amount ? Math.min((ytdGci / agent.cap_amount) * 100, 100) : 0

  await supabase
    .from("agents")
    .update({
      ytd_gci: ytdGci,
      ytd_transactions: ytdTransactions,
      cap_progress: capProgress,
      updated_at: new Date().toISOString(),
    })
    .eq("id", agentId)
}

// ==================== EXPENSES ====================

export async function getAgentExpenses(agentId: string, year?: number) {
  const supabase = await createClient()

  const currentYear = year || new Date().getFullYear()
  const startDate = `${currentYear}-01-01`
  const endDate = `${currentYear}-12-31`

  const { data, error } = await supabase
    .from("agent_expenses")
    .select("*")
    .eq("agent_id", agentId)
    .gte("date", startDate)
    .lte("date", endDate)
    .order("date", { ascending: false })

  if (error) {
    console.error("Error fetching agent expenses:", error)
    return []
  }

  return data || []
}

export async function addAgentExpense(expenseData: {
  agent_id: string
  category: "marketing" | "education" | "technology" | "transportation" | "office" | "other"
  description: string
  amount: number
  date: string
  receipt_url?: string
  is_reimbursable: boolean
}) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("agent_expenses")
    .insert({
      ...expenseData,
      status: expenseData.is_reimbursable ? "pending" : "n/a",
    })
    .select()
    .single()

  if (error) {
    console.error("Error adding expense:", error)
    return { error: error.message }
  }

  revalidatePath("/admin/agent-roster")
  return { data }
}

export async function updateExpenseStatus(
  expenseId: string,
  status: "pending" | "approved" | "rejected" | "reimbursed",
) {
  const supabase = await createClient()

  const { data, error } = await supabase.from("agent_expenses").update({ status }).eq("id", expenseId).select().single()

  if (error) {
    console.error("Error updating expense status:", error)
    return { error: error.message }
  }

  revalidatePath("/admin/agent-roster")
  return { data }
}

export async function getExpenseSummary(agentId: string, year?: number) {
  const supabase = await createClient()

  const currentYear = year || new Date().getFullYear()
  const startDate = `${currentYear}-01-01`
  const endDate = `${currentYear}-12-31`

  const { data, error } = await supabase
    .from("agent_expenses")
    .select("category, amount")
    .eq("agent_id", agentId)
    .gte("date", startDate)
    .lte("date", endDate)

  if (error) {
    console.error("Error fetching expense summary:", error)
    return {}
  }

  // Group by category
  const summary: Record<string, number> = {}
  data?.forEach((expense) => {
    summary[expense.category] = (summary[expense.category] || 0) + expense.amount
  })

  return summary
}

// ==================== GOALS ====================

export async function getAgentGoals(agentId: string, year?: number) {
  const supabase = await createClient()

  const currentYear = year || new Date().getFullYear()

  const { data, error } = await supabase
    .from("agent_goals")
    .select("*")
    .eq("agent_id", agentId)
    .eq("year", currentYear)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("Error fetching agent goals:", error)
    return []
  }

  return data || []
}

export async function setAgentGoal(goalData: {
  agent_id: string
  year: number
  goal_type: "gci" | "transactions" | "listings" | "buyers" | "sphere_growth"
  target_value: number
}) {
  const supabase = await createClient()

  // Check if goal already exists for this type and year
  const { data: existing } = await supabase
    .from("agent_goals")
    .select("id")
    .eq("agent_id", goalData.agent_id)
    .eq("year", goalData.year)
    .eq("goal_type", goalData.goal_type)
    .single()

  if (existing) {
    // Update existing goal
    const { data, error } = await supabase
      .from("agent_goals")
      .update({ target_value: goalData.target_value })
      .eq("id", existing.id)
      .select()
      .single()

    if (error) {
      return { error: error.message }
    }
    return { data }
  }

  // Create new goal
  const { data, error } = await supabase
    .from("agent_goals")
    .insert({
      ...goalData,
      current_value: 0,
    })
    .select()
    .single()

  if (error) {
    console.error("Error setting agent goal:", error)
    return { error: error.message }
  }

  revalidatePath("/admin/agent-roster")
  return { data }
}

export async function updateGoalProgress(goalId: string, currentValue: number) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("agent_goals")
    .update({ current_value: currentValue })
    .eq("id", goalId)
    .select()
    .single()

  if (error) {
    console.error("Error updating goal progress:", error)
    return { error: error.message }
  }

  revalidatePath("/admin/agent-roster")
  return { data }
}

// ==================== AGENT ASSIGNMENT ====================

export async function assignAgentToContact(contactId: string, agentId: string) {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from("contacts")
    .update({ agent_id: agentId })
    .eq("id", contactId)
    .select()
    .single()

  if (error) {
    console.error("Error assigning agent to contact:", error)
    return { error: error.message }
  }

  // Award points for new contact assignment
  await awardPoints(agentId, 10, "New contact assigned", "lead")

  revalidatePath("/contacts")
  return { data }
}

export async function getAgentContacts(agentId: string) {
  // Return empty array for invalid UUIDs - production apps should require valid auth
  if (!isValidUUID(agentId)) {
    console.warn("[agents.ts] getAgentContacts called with invalid UUID:", agentId)
    return []
  }

  const supabase = await createClient()

  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("agent_id", agentId)
    .order("created_at", { ascending: false })

  if (error) {
    console.error("Error fetching agent contacts:", error)
    return []
  }

  return data || []
}

export async function getAgentStats(userIdOrAgentId: string) {
  // Return empty stats for invalid UUIDs - production apps should require valid auth
  if (!isValidUUID(userIdOrAgentId)) {
    console.warn("[agents.ts] getAgentStats called with invalid UUID:", userIdOrAgentId)
    return {
      activeDeals: 0,
      pendingGCI: 0,
      ytdVolume: 0,
      ytdGCI: 0,
      leadsToday: 0,
      contactCount: 0,
      activeTransactions: 0,
      pendingTasks: 0,
    }
  }

  const supabase = await createClient()

  // First, check if this is a user_id and get the agent record
  let agentId = userIdOrAgentId
  try {
    const { data: agent } = await supabase.from("agents").select("id").eq("user_id", userIdOrAgentId).maybeSingle()

    if (agent?.id) {
      agentId = agent.id
    }
  } catch (e) {
    // If agents table doesn't exist or error, use the passed ID
  }

  // Get contact count - handle table not existing gracefully
  let contactCount = 0
  let activeTransactions = 0
  let pendingTasks = 0
  let leadsToday = 0

  try {
    const { count } = await supabase
      .from("contacts")
      .select("*", { count: "exact", head: true })
      .eq("agent_id", agentId)
    contactCount = count || 0
  } catch (e) {
    // Table may not exist
  }

  // Get active transaction count
  try {
    const { count } = await supabase
      .from("transactions")
      .select("*", { count: "exact", head: true })
      .eq("agent_id", agentId)
      .in("status", ["new", "negotiation", "under_contract", "inspection", "financing"])
    activeTransactions = count || 0
  } catch (e) {
    // Table may not exist
  }

  // Get pending tasks count
  try {
    const { count } = await supabase
      .from("tasks")
      .select("*", { count: "exact", head: true })
      .eq("assigned_to", agentId)
      .eq("status", "pending")
    pendingTasks = count || 0
  } catch (e) {
    // Table may not exist
  }

  // Get leads created today
  try {
    const today = new Date().toISOString().split("T")[0]
    const { count } = await supabase
      .from("contacts")
      .select("*", { count: "exact", head: true })
      .eq("agent_id", agentId)
      .gte("created_at", today)
    leadsToday = count || 0
  } catch (e) {
    // Table may not exist
  }

  return {
    activeDeals: activeTransactions,
    pendingGCI: 0, // Would need commissions table
    ytdVolume: 0, // Would need transactions with purchase_price
    ytdGCI: 0, // Would need commissions table
    leadsToday,
    contactCount,
    activeTransactions,
    pendingTasks,
  }
}

// ============================================
// BROKERAGE STATS (for Broker Dashboard)
// ============================================

export async function getBrokerageStats(brokerageId?: string) {
  const supabase = await createClient()

  let monthlyGCI = 0
  let lastMonthGCI = 0
  let activeDeals = 0
  let agentCount = 0
  let openFlags = 0

  const startOfMonth = new Date()
  startOfMonth.setDate(1)
  startOfMonth.setHours(0, 0, 0, 0)

  // Get total GCI this month - handle table not existing
  try {
    let gciQuery = supabase
      .from("agent_commissions")
      .select("gross_commission")
      .gte("date", startOfMonth.toISOString())

    if (brokerageId) {
      gciQuery = gciQuery.eq("brokerage_id", brokerageId)
    }

    const { data: gciData } = await gciQuery
    monthlyGCI = gciData?.reduce((sum, c) => sum + (c.gross_commission || 0), 0) || 0

    // Get last month GCI for comparison
    const lastMonthStart = new Date(startOfMonth)
    lastMonthStart.setMonth(lastMonthStart.getMonth() - 1)
    const lastMonthEnd = new Date(startOfMonth)

    let lastGciQuery = supabase
      .from("agent_commissions")
      .select("gross_commission")
      .gte("date", lastMonthStart.toISOString())
      .lt("date", lastMonthEnd.toISOString())

    if (brokerageId) {
      lastGciQuery = lastGciQuery.eq("brokerage_id", brokerageId)
    }

    const { data: lastGciData } = await lastGciQuery
    lastMonthGCI = lastGciData?.reduce((sum, c) => sum + (c.gross_commission || 0), 0) || 0
  } catch (e) {
    // Table may not exist
  }

  const gciChange = lastMonthGCI > 0 ? Math.round(((monthlyGCI - lastMonthGCI) / lastMonthGCI) * 100) : 0

  // Get active deals count
  try {
    let dealsQuery = supabase
      .from("transactions")
      .select("id", { count: "exact", head: true })
      .in("status", ["new", "negotiation", "under_contract", "inspection", "financing"])

    if (brokerageId) {
      dealsQuery = dealsQuery.eq("brokerage_id", brokerageId)
    }

    const { count } = await dealsQuery
    activeDeals = count || 0
  } catch (e) {
    // Table may not exist
  }

  // Get agent count from agents table
  try {
    let agentsQuery = supabase
      .from("agents")
      .select("id", { count: "exact", head: true })

    if (brokerageId) {
      agentsQuery = agentsQuery.eq("brokerage_id", brokerageId)
    }

    const { count } = await agentsQuery
    agentCount = count || 0
  } catch (e) {
    // Table may not exist or query failed
  }

  // Get risk score (compliance flags count)
  try {
    let riskQuery = supabase
      .from("compliance_flags")
      .select("id", { count: "exact", head: true })
      .eq("status", "open")

    if (brokerageId) {
      riskQuery = riskQuery.eq("brokerage_id", brokerageId)
    }

    const { count } = await riskQuery
    openFlags = count || 0
  } catch (e) {
    // Table may not exist
  }

  const riskLevel = openFlags > 5 ? "Critical" : openFlags > 2 ? "Elevated" : "Normal"

  return {
    monthlyGCI,
    gciChange,
    activeDeals,
    agentCount,
    riskLevel,
    openComplianceFlags: openFlags,
  }
}
