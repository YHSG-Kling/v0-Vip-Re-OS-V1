"use server"

import { createClient } from "@/lib/supabase/server"
import { getDefaultCommissionStructure } from "@/lib/brokerage"

// ============================================
// VALUE METRICS AGGREGATION
// ============================================

export async function aggregateValueDelivered(agentId: string, date: Date) {
  const supabase = await createClient()
  const dateStr = date.toISOString().split("T")[0]

  // Pull from multiple sources (would need actual tracking tables)
  const [toolUsage, educationalContent, helpfulResponses] = await Promise.all([
    // Tool usage (from public tools if exists)
    // tool_usage_sessions has no date/email_captured columns — filter the day via
    // created_at range (timestamptz).
    supabase
      .from("tool_usage_sessions")
      .select("*")
      .gte("created_at", dateStr)
      .lt("created_at", new Date(new Date(dateStr).getTime() + 86400000).toISOString().slice(0, 10)),

    // Educational content downloads
    // pass 14: educational_content_downloads was a PHANTOM table — the real
    // download ledger is document_downloads (downloaded_at timestamptz).
    supabase.from("document_downloads").select("*").gte("downloaded_at", dateStr).lt("downloaded_at", new Date(new Date(dateStr).getTime() + 86400000).toISOString().slice(0, 10)),

    // Helpful AI responses (from messages)
    supabase
      .from("messages")
      .select("*")
      .eq("sender_type", "ai")
      .gte("created_at", dateStr)
      .lt("created_at", new Date(date.getTime() + 86400000).toISOString()),
  ])

  // Calculate value in dollars
  const valueCalculation = {
    free_tools_used_count: toolUsage.data?.length || 0,
    guides_downloaded_count: educationalContent.data?.length || 0,
    questions_answered_count: helpfulResponses.data?.length || 0,
    personalized_reports_sent: 0, // Would track CMAs sent

    // Value calculations
    free_tools_value: (toolUsage.data?.length || 0) * 50, // $50 per tool use
    guides_value: (educationalContent.data?.length || 0) * 100, // $100 per guide
    help_value: (helpfulResponses.data?.length || 0) * 25, // $25 per answer
    reports_value: 0, // $500 per CMA
  }

  const total_value_delivered =
    valueCalculation.free_tools_value +
    valueCalculation.guides_value +
    valueCalculation.help_value +
    valueCalculation.reports_value

  // Get unique recipients
  const uniqueRecipients = new Set([
    ...(toolUsage.data?.map((t: any) => t.visitor_id || t.session_id) || []),
    ...(helpfulResponses.data?.map((m: any) => m.conversation_id) || []),
  ])

  // Store aggregated value
  const { data, error } = await supabase
    .from("value_delivered_daily")
    .upsert(
      {
        date: dateStr,
        agent_id: agentId,
        ...valueCalculation,
        total_value_delivered_dollars: total_value_delivered,
        recipients_count: uniqueRecipients.size,
        cost_to_deliver: 0, // Calculate actual costs
      },
      { onConflict: "date,agent_id" },
    )
    .select()
    .single()

  return {
    success: !error,
    data,
    totalValue: total_value_delivered,
  }
}

// ============================================
// TRUST CAPITAL CALCULATION
// ============================================

export async function calculateTrustCapital(agentId: string, periodDays: number = 30) {
  const supabase = await createClient()
  const endDate = new Date()
  const startDate = new Date(endDate.getTime() - periodDays * 86400000)

  // Get value metrics
  const { data: valueMetrics } = await supabase
    .from("value_delivered_daily")
    .select("*")
    .eq("agent_id", agentId)
    .gte("date", startDate.toISOString().split("T")[0])
    .lte("date", endDate.toISOString().split("T")[0])

  const totalValueGiven =
    valueMetrics?.reduce((sum, m) => sum + (parseFloat(m.total_value_delivered_dollars as any) || 0), 0) || 0

  // Get relationship metrics
  const { data: transactions } = await supabase
    .from("transactions")
    .select("*, contacts(*)")
    .eq("agent_id", agentId)
    .eq("status", "closed")

  const { data: referrals } = await supabase
    .from("contacts")
    .select("*")
    .eq("agent_id", agentId)
    .eq("source", "client_referral")
    .gte("created_at", startDate.toISOString())

  // Calculate metrics
  const metrics = {
    value_given: totalValueGiven,
    closed_deals: transactions?.length || 0,
    referral_count: referrals?.length || 0,
    referral_rate: transactions?.length ? ((referrals?.length || 0) / transactions.length) * 100 : 0,
    recipients_helped: valueMetrics?.reduce((sum, m) => sum + (m.recipients_count || 0), 0) || 0,
  }

  // Trust capital algorithm
  let trustScore = 50 // Base score

  // Value given component (30 points max)
  if (totalValueGiven > 10000) trustScore += 30
  else if (totalValueGiven > 5000) trustScore += 20
  else if (totalValueGiven > 1000) trustScore += 10

  // Referral rate component (25 points max)
  if (metrics.referral_rate > 30) trustScore += 25
  else if (metrics.referral_rate > 20) trustScore += 15
  else if (metrics.referral_rate > 10) trustScore += 10

  // Recipients helped component (20 points max)
  if (metrics.recipients_helped > 100) trustScore += 20
  else if (metrics.recipients_helped > 50) trustScore += 15
  else if (metrics.recipients_helped > 20) trustScore += 10

  // Consistency component (25 points max)
  const daysWithActivity = new Set(valueMetrics?.map((m) => m.date)).size
  const consistencyRate = daysWithActivity / periodDays
  if (consistencyRate > 0.8) trustScore += 25
  else if (consistencyRate > 0.6) trustScore += 15
  else if (consistencyRate > 0.4) trustScore += 10

  return {
    trust_capital_score: Math.min(Math.max(trustScore, 0), 100),
    metrics,
    insights: {
      strength: trustScore > 75 ? "High trust capital" : trustScore > 50 ? "Building trust" : "Focus on giving value",
      value_given_assessment:
        totalValueGiven > 5000 ? "Excellent generosity" : "Increase free value to build trust faster",
      referral_assessment:
        metrics.referral_rate > 20
          ? "Strong referral engine"
          : "More value delivery will increase referrals",
    },
  }
}

// ============================================
// LEAD VALUE JOURNEY TRACKING
// ============================================

export async function trackLeadValueJourney(contactId: string) {
  const supabase = await createClient()

  const { data: contact } = await supabase.from("contacts").select("*, transactions(*)").eq("id", contactId).single()

  if (!contact) return null

  // Calculate value received (simplified - would need actual tracking)
  const toolsUsed: string[] = [] // Track from tool_usage_sessions
  const guidesDownloaded: string[] = [] // Track from downloads
  const valueReceived = toolsUsed.length * 50 + guidesDownloaded.length * 100

  // Check if converted
  const becameClient = contact.transactions?.some((t: any) => t.status === "closed")
  const conversionValue = contact.transactions?.reduce((sum: number, t: any) => sum + (t.purchase_price || 0), 0)

  const firstInteraction = new Date(contact.created_at)
  const conversionDate = contact.transactions?.[0]?.close_date
    ? new Date(contact.transactions[0].close_date)
    : null
  const timeToConversion = conversionDate
    ? Math.ceil((conversionDate.getTime() - firstInteraction.getTime()) / (1000 * 60 * 60 * 24))
    : null

  const roiMultiple = valueReceived > 0 && conversionValue ? conversionValue / valueReceived : 0

  // Upsert journey data
  const { data: journey } = await supabase
    .from("lead_value_journey")
    .upsert(
      {
        contact_id: contactId,
        first_interaction_date: firstInteraction.toISOString().split("T")[0],
        total_value_received: valueReceived,
        touchpoints_count: 0, // Track from interactions
        tools_used: toolsUsed,
        guides_downloaded: guidesDownloaded,
        time_to_conversion_days: timeToConversion,
        conversion_value: conversionValue,
        roi_multiple: roiMultiple,
        became_client: becameClient || false,
      },
      { onConflict: "contact_id" },
    )
    .select()
    .single()

  return journey
}

// ============================================
// PERFORMANCE DASHBOARD DATA
// ============================================

export async function loadValueDrivenDashboard(agentId: string, period: string = "month") {
  const supabase = await createClient()

  // Get agent's brokerage for commission structure
  const { data: agent } = await supabase
    .from("agents")
    .select("*, profiles!inner(brokerage_id)")
    .eq("id", agentId)
    .single()

  const brokerageId = agent?.profiles?.brokerage_id
  if (!brokerageId) {
    throw new Error("Agent brokerage not found")
  }

  const commissionStructure = await getDefaultCommissionStructure(brokerageId)

  // Calculate date range
  const endDate = new Date()
  let startDate = new Date()
  switch (period) {
    case "today":
      startDate = new Date(endDate.getFullYear(), endDate.getMonth(), endDate.getDate())
      break
    case "week":
      startDate = new Date(endDate.getTime() - 7 * 86400000)
      break
    case "month":
      startDate = new Date(endDate.getFullYear(), endDate.getMonth(), 1)
      break
    case "quarter":
      startDate = new Date(endDate.getFullYear(), Math.floor(endDate.getMonth() / 3) * 3, 1)
      break
    case "ytd":
      startDate = new Date(endDate.getFullYear(), 0, 1)
      break
  }

  // Get value metrics
  const { data: valueMetrics } = await supabase
    .from("value_delivered_daily")
    .select("*")
    .eq("agent_id", agentId)
    .gte("date", startDate.toISOString().split("T")[0])
    .order("date", { ascending: true })

  // Get traditional metrics (transactions)
  const { data: transactions } = await supabase
    .from("transactions")
    .select("*, contacts(*)")
    .eq("agent_id", agentId)
    .gte("created_at", startDate.toISOString())

  // Calculate aggregated metrics
  const totalValueDelivered =
    valueMetrics?.reduce((sum, m) => sum + (parseFloat(m.total_value_delivered_dollars as any) || 0), 0) || 0
  const peopleHelped = valueMetrics?.reduce((sum, m) => sum + (m.recipients_count || 0), 0) || 0
  const toolsUsed = valueMetrics?.reduce((sum, m) => sum + (m.free_tools_used_count || 0), 0) || 0
  const guidesShared = valueMetrics?.reduce((sum, m) => sum + (m.guides_downloaded_count || 0), 0) || 0

  const closedDeals = transactions?.filter((t) => t.status === "closed") || []
  const monthlyGCI = closedDeals.reduce((sum, t) => sum + ((t.purchase_price || 0) * commissionStructure.agentBuyerSideRate), 0)
  const activeLeads = transactions?.filter((t) => t.status !== "closed" && t.status !== "cancelled").length || 0

  // Get trust capital
  const trustCapital = await calculateTrustCapital(agentId, period === "month" ? 30 : 90)

  return {
    period,
    startDate: startDate.toISOString().split("T")[0],
    endDate: endDate.toISOString().split("T")[0],

    // Value metrics
    valueMetrics: {
      total_value_delivered: totalValueDelivered,
      people_helped: peopleHelped,
      free_tools_used: toolsUsed,
      guides_shared: guidesShared,
      reciprocity_rate: closedDeals.length > 0 ? ((peopleHelped / closedDeals.length) * 100).toFixed(1) : "0",
    },

    // Traditional metrics
    traditionalMetrics: {
      monthly_gci: monthlyGCI,
      units_closed: closedDeals.length,
      active_leads: activeLeads,
      conversion_rate: transactions && transactions.length > 0 ? ((closedDeals.length / transactions.length) * 100).toFixed(1) : "0",
    },

    // Trust & performance
    trust_capital_score: trustCapital.trust_capital_score,
    generosity_score: Math.min(Math.round((totalValueDelivered / 10000) * 100), 100),

    // Charts data
    valueOverTime:
      valueMetrics?.map((m) => ({
        date: m.date,
        value: parseFloat(m.total_value_delivered_dollars as any) || 0,
      })) || [],

    // Lead journeys (top 10)
    leadJourneys: [], // Would query lead_value_journey table
  }
}

export async function getLeadValueJourneys(agentId: string, limit: number = 20) {
  const supabase = await createClient()

  // Query lead_value_journey first (table may not exist - handle gracefully)
  const { data: journeys, error } = await supabase
    .from("lead_value_journey")
    .select("*")
    .order("total_value_received", { ascending: false })
    .limit(limit * 2) // Fetch extra since we filter after

  if (error) {
    console.error("Error fetching lead journeys:", error)
    return []
  }

  if (!journeys || journeys.length === 0) return []

  // Fetch contacts separately to filter by agent
  const contactIds = journeys.map(j => j.contact_id).filter(Boolean)
  if (contactIds.length === 0) return []

  const { data: contacts } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, email, agent_id")
    .in("id", contactIds)
    .eq("agent_id", agentId)

  const contactMap = new Map((contacts || []).map(c => [c.id, c]))

  // Filter and enrich journeys
  return journeys
    .filter(j => contactMap.has(j.contact_id))
    .slice(0, limit)
    .map(j => ({
      ...j,
      contacts: contactMap.get(j.contact_id),
    }))
}
