"use server"

import { createClient } from "@/lib/supabase/server"
import { getDefaultCommissionStructure } from "@/lib/brokerage"
import { resolveWriteContext } from "@/lib/kernel/identity"
import { isValidUUID } from "@/lib/validations"

// ============================================
// TENANT GATE (w2s3)
// ============================================
//
// This module is `"use server"`, so every export is a public HTTP endpoint,
// and every one of them takes the subject id (`agentId` / `contactId`) FROM
// THE CALLER. Before this pass nothing in the file authenticated at all —
// the two writers below (`aggregateValueDelivered`, `trackLeadValueJourney`)
// would upsert a row keyed on whatever `agent_id` / `contact_id` the caller
// named.
//
// `agents.id` and `users.id` are DISJOINT id spaces in this schema, so the
// gate resolves the caller's agent row rather than substituting one id for
// the other.

/**
 * Authenticate, then prove the named agent is inside the caller's brokerage.
 * Returns the resolved brokerage so writers can stamp the tenant column.
 * Fails CLOSED — a refused read is rejected, not read as "no such agent".
 */
async function authorizeAgent(
  agentId: string,
): Promise<{ ok: true; brokerageId: string } | { ok: false; error: string }> {
  if (!isValidUUID(agentId)) return { ok: false, error: "Invalid agent ID" }

  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) return { ok: false, error: "Unauthorized" }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from("agents")
    .select("id, brokerage_id")
    .eq("id", agentId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()

  if (error) return { ok: false, error: "Could not verify agent scope" }
  if (!data) return { ok: false, error: "Agent not found in your brokerage" }
  return { ok: true, brokerageId: ctx.brokerageId }
}

// ============================================
// VALUE METRICS AGGREGATION
// ============================================

export async function aggregateValueDelivered(agentId: string, date: Date) {
  const gate = await authorizeAgent(agentId)
  if (!gate.ok) return { success: false, error: gate.error, data: null, totalValue: 0 }
  const { brokerageId } = gate

  const supabase = await createClient()

  // One window for all three reads. The previous version built a different
  // window per source: two used a date-only upper bound (a string, compared
  // against timestamptz) and the third used `date`'s actual time-of-day, so
  // a call made at 14:00 counted messages over a 24h window ending at 14:00
  // the next day while counting tool sessions over the calendar day.
  const dayStart = new Date(date)
  dayStart.setUTCHours(0, 0, 0, 0)
  const dayEnd = new Date(dayStart.getTime() + 86400000)
  const dateStr = dayStart.toISOString().split("T")[0]
  const startIso = dayStart.toISOString()
  const endIso = dayEnd.toISOString()

  const [toolUsage, educationalContent, helpfulResponses] = await Promise.all([
    // Tool usage (from public tools if exists)
    // tool_usage_sessions has no date/email_captured columns — filter the day via
    // created_at range (timestamptz).
    // tenant anchor: unfiltered, this counted EVERY brokerage's tool sessions
    // into this agent's value metric.
    supabase
      .from("tool_usage_sessions")
      // `session_id` does NOT exist on this table (verified live) — the old
      // `select("*")` + `t.visitor_id || t.session_id` fallback silently read
      // undefined. Selecting it explicitly would now be a hard column error.
      .select("visitor_id")
      .eq("brokerage_id", brokerageId)
      .gte("created_at", startIso)
      .lt("created_at", endIso),

    // Educational content downloads
    // pass 14: educational_content_downloads was a PHANTOM table — the real
    // download ledger is document_downloads (downloaded_at timestamptz).
    // tenant anchor: same cross-tenant leak as tool_usage_sessions above.
    supabase
      .from("document_downloads")
      .select("id")
      .eq("brokerage_id", brokerageId)
      .gte("downloaded_at", startIso)
      .lt("downloaded_at", endIso),

    // Helpful AI responses (from messages)
    supabase
      .from("messages")
      .select("conversation_id")
      // tenant anchor (scope burn-down): this is a per-agent value metric —
      // count only the AI responses sent on this agent's conversations.
      .eq("agent_id", agentId)
      .eq("sender_type", "ai")
      .gte("created_at", startIso)
      .lt("created_at", endIso),
  ])

  // supabase-js RESOLVES a refused query, so `.data` would be null and every
  // count would fall to 0 — and this function would then UPSERT those zeros
  // as the authoritative daily record for the agent. A partial read must not
  // be written as a complete day.
  const readError =
    toolUsage.error?.message ??
    educationalContent.error?.message ??
    helpfulResponses.error?.message
  if (readError) {
    return {
      success: false,
      error: `Could not read the day's value sources — ${readError}`,
      data: null,
      totalValue: 0,
    }
  }

  const toolRows = toolUsage.data ?? []
  const downloadRows = educationalContent.data ?? []
  const messageRows = helpfulResponses.data ?? []

  // Calculate value in dollars
  const valueCalculation = {
    free_tools_used_count: toolRows.length,
    guides_downloaded_count: downloadRows.length,
    questions_answered_count: messageRows.length,
    personalized_reports_sent: 0, // Would track CMAs sent

    // Value calculations
    free_tools_value: toolRows.length * 50, // $50 per tool use
    guides_value: downloadRows.length * 100, // $100 per guide
    help_value: messageRows.length * 25, // $25 per answer
    reports_value: 0, // $500 per CMA
  }

  const total_value_delivered =
    valueCalculation.free_tools_value +
    valueCalculation.guides_value +
    valueCalculation.help_value +
    valueCalculation.reports_value

  // Get unique recipients
  const uniqueRecipients = new Set(
    [
      ...toolRows.map((t: any) => t.visitor_id),
      ...messageRows.map((m: any) => m.conversation_id),
    ].filter(Boolean),
  )

  // Store aggregated value.
  //
  // SCHEMA (w6s3, verified live against project hrvaqgvukzxfskkcrwbt):
  // `value_delivered_daily` has exactly these columns — id, agent_id, brokerage_id,
  // date, total_value_delivered_dollars, recipients_count, cost_to_deliver,
  // value_breakdown (jsonb), created_at, updated_at.
  //
  // The eight keys in `valueCalculation` (free_tools_used_count,
  // guides_downloaded_count, questions_answered_count, personalized_reports_sent,
  // free_tools_value, guides_value, help_value, reports_value) DO NOT EXIST on the
  // table. Spreading them into the upsert made this write fail with a column error
  // on every single call — so `value_delivered_daily` could never have had a row,
  // and every reader of it (loadValueDrivenDashboard, calculateTrustCapital, the
  // /analytics and /dashboard/intelligence pages) was structurally guaranteed to
  // render zeros. The breakdown belongs in the `value_breakdown` jsonb, which is
  // what that column is for; the readers below unpack it from there.
  //
  // onConflict matches the live UNIQUE (agent_id, date) — constraint name
  // `value_delivered_daily_unique`.
  const { data, error } = await supabase
    .from("value_delivered_daily")
    .upsert(
      {
        date: dateStr,
        agent_id: agentId,
        brokerage_id: brokerageId, // tenant stamp — column existed but was never set
        value_breakdown: valueCalculation,
        total_value_delivered_dollars: total_value_delivered,
        recipients_count: uniqueRecipients.size,
        cost_to_deliver: 0, // Calculate actual costs
        updated_at: new Date().toISOString(),
      },
      { onConflict: "agent_id,date" },
    )
    .select()
    .single()

  if (error) {
    return { success: false, error: error.message, data: null, totalValue: total_value_delivered }
  }

  return {
    success: true,
    data,
    totalValue: total_value_delivered,
  }
}

// ============================================
// TRUST CAPITAL CALCULATION
// ============================================

/**
 * Read a counter out of a `value_delivered_daily.value_breakdown` jsonb blob.
 * The breakdown keys were previously read as top-level COLUMNS
 * (`m.free_tools_used_count`, `m.guides_downloaded_count`) which do not exist on
 * the table, so those sums were always 0 regardless of what had been aggregated.
 */
function breakdownCount(row: any, key: string): number {
  const b = row?.value_breakdown
  if (!b || typeof b !== "object") return 0
  return Number((b as Record<string, unknown>)[key]) || 0
}

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
  if (!isValidUUID(contactId)) return null

  const ctx = await resolveWriteContext()
  if (!ctx.isAuthenticated) return null

  const supabase = await createClient()

  // Tenant anchor: the read is what authorises the write below, so it is
  // scoped to the caller's brokerage. Without `.eq("brokerage_id", …)` this
  // endpoint upserted a `lead_value_journey` row for any contact id in any
  // brokerage that the caller could guess.
  // `.maybeSingle()` rather than `.single()`: `.single()` returns an error
  // (PGRST116) for the zero-row case, which the un-destructured `{ data }`
  // then flattened into the same `null` as a genuine read failure.
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select("id, created_at, transactions(*)")
    .eq("id", contactId)
    .eq("brokerage_id", ctx.brokerageId)
    .maybeSingle()

  // Fail closed — a refused read is not "no such contact".
  if (contactError || !contact) return null

  // Value received.
  //
  // HONESTY NOTE (w6s3, schema verified live): `tool_usage_sessions` keys on
  // `visitor_id` (text) and `document_downloads` on `user_id`/`partner_id` — NEITHER
  // table carries a `contact_id`, so per-contact tool/guide attribution genuinely
  // cannot be derived from what the database records today. These stay empty rather
  // than being filled with a guess, and the arrays are written as [] so the shape is
  // stable. Closing this properly needs a contact linkage on those two ledgers; see
  // docs/wave6-slice3.md.
  const toolsUsed: string[] = []
  const guidesDownloaded: string[] = []
  const valueReceived = toolsUsed.length * 50 + guidesDownloaded.length * 100

  // Touchpoints: this WAS hardcoded 0, which is a fabricated figure on a table the
  // /analytics lead-journey panel renders. `activities` does carry contact_id, so the
  // real count is available. `count: "exact", head: true` fetches no rows.
  const { count: touchpointCount, error: touchpointError } = await supabase
    .from("activities")
    .select("id", { count: "exact", head: true })
    .eq("contact_id", contactId)
    .eq("brokerage_id", ctx.brokerageId)
  if (touchpointError) return null // fail closed rather than writing a zero as fact

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

  // Upsert journey data. onConflict matches the live UNIQUE (contact_id).
  const { data: journey, error: journeyError } = await supabase
    .from("lead_value_journey")
    .upsert(
      {
        contact_id: contactId,
        brokerage_id: ctx.brokerageId, // tenant stamp — column existed but was never set
        first_interaction_date: firstInteraction.toISOString().split("T")[0],
        total_value_received: valueReceived,
        touchpoints_count: touchpointCount ?? 0,
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

  // The write's own error was previously discarded, so a rejected upsert returned
  // the same `null` as "contact not visible" and the caller could not tell that the
  // journey had not been recorded.
  if (journeyError) {
    console.error("[analytics] lead_value_journey upsert failed:", journeyError.message)
    return null
  }

  return journey
}

// ============================================
// PERFORMANCE DASHBOARD DATA
// ============================================

export async function loadValueDrivenDashboard(agentId: string, period: string = "month") {
  const supabase = await createClient()

  // Get agent's brokerage for commission structure
  // `profiles!inner(brokerage_id)` embedded a table that DOES NOT EXIST. With
  // `!inner` PostgREST rejects the entire query, so `agent` was always null and
  // this dashboard has always thrown "Agent brokerage not found". `agents`
  // carries its own `brokerage_id` — there was never anything to join to.
  const { data: agent, error: agentError } = await supabase
    .from("agents")
    .select("id, brokerage_id")
    .eq("id", agentId)
    .maybeSingle()

  if (agentError) throw new Error(`Could not resolve the agent's brokerage: ${agentError.message}`)

  const brokerageId = agent?.brokerage_id
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
  const toolsUsed = valueMetrics?.reduce((sum, m) => sum + breakdownCount(m, "free_tools_used_count"), 0) || 0
  const guidesShared = valueMetrics?.reduce((sum, m) => sum + breakdownCount(m, "guides_downloaded_count"), 0) || 0

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
