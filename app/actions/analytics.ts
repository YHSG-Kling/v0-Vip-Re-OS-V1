"use server"

import { createClient } from "@/lib/supabase/server"
import { getDefaultCommissionStructure } from "@/lib/brokerage"
import { resolveWriteContextForTenant } from "@/lib/platform/acting-context"
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

  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok) return { ok: false, error: "Unauthorized" }

  const supabase = ctx.db
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
      // tool_name and time_spent_seconds are written on every session
      // (app/actions/calculators.ts trackToolUsage) and had no reader — the
      // value ledger counted "a tool was used" while WHICH tool and for HOW
      // LONG were write-only. Both now land in value_breakdown below.
      // session_data_json is the LAST write-only column on this table: trackToolUsage
      // stores `{ inputs, location }` on every public-tool session (app/actions/
      // calculators.ts:841, both bounded) and nothing read it. So the value ledger could
      // count that a calculator was used and for how long, while WHERE the visitor said
      // they were and WHETHER they actually filled the tool in — the difference between
      // a bounce and a lead-quality signal — were recorded and unreachable.
      .select("visitor_id, tool_name, time_spent_seconds, session_data_json")
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

  // Which tools, and how long visitors actually engaged — from the session
  // rows' own columns rather than a flat count.
  const toolsByName: Record<string, number> = {}
  let toolEngagementSeconds = 0
  // From session_data_json: how many sessions were actually FILLED IN, and which
  // markets they came from. A session with no `inputs` is someone who opened the tool
  // and left; counting it as engagement inflates the value figure below.
  let toolSessionsWithInputs = 0
  const toolSessionsByLocation: Record<string, number> = {}
  for (const t of toolRows as Array<{ tool_name?: string | null; time_spent_seconds?: number | null; session_data_json?: unknown }>) {
    const name = t.tool_name || "unknown"
    toolsByName[name] = (toolsByName[name] ?? 0) + 1
    toolEngagementSeconds += Number(t.time_spent_seconds) || 0

    const payload = t.session_data_json
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const p = payload as Record<string, unknown>
      const inputs = p.inputs
      if (inputs && typeof inputs === "object" && !Array.isArray(inputs) && Object.keys(inputs as object).length > 0) {
        toolSessionsWithInputs += 1
      }
      // `location` is already bounded public text at the write (boundPublicText), and
      // it is a market string the visitor typed — never an identifier. An absent one is
      // left out rather than bucketed as "unknown", which would read as a place.
      const loc = typeof p.location === "string" ? p.location.trim() : ""
      if (loc) toolSessionsByLocation[loc] = (toolSessionsByLocation[loc] ?? 0) + 1
    }
  }

  // Calculate value in dollars
  const valueCalculation = {
    free_tools_used_count: toolRows.length,
    guides_downloaded_count: downloadRows.length,
    questions_answered_count: messageRows.length,
    personalized_reports_sent: 0, // Would track CMAs sent
    tools_by_name: toolsByName,
    tool_engagement_seconds: toolEngagementSeconds,
    // From session_data_json — see the loop above.
    tool_sessions_with_inputs: toolSessionsWithInputs,
    tool_sessions_by_location: toolSessionsByLocation,

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

  // Get value metrics. `error` is destructured for the same reason as the
  // relationship read below: three of the four trust-score components
  // (value_given, recipients_helped, consistency) come out of this one query, so a
  // refusal that arrives as `null` would be scored as "this agent delivered nothing".
  const { data: valueMetrics, error: valueMetricsError } = await supabase
    .from("value_delivered_daily")
    .select("*")
    .eq("agent_id", agentId)
    .gte("date", startDate.toISOString().split("T")[0])
    .lte("date", endDate.toISOString().split("T")[0])

  if (valueMetricsError) {
    throw new Error(
      `calculateTrustCapital: the value-delivered read was refused (${valueMetricsError.message}). This is a refusal, not an agent who gave nothing — no trust score is computed.`,
    )
  }

  const totalValueGiven =
    valueMetrics?.reduce((sum, m) => sum + (parseFloat(m.total_value_delivered_dollars as any) || 0), 0) || 0

  // Get relationship metrics.
  //
  // The `contacts(*)` embed this replaces made the read fail on every call.
  // `transactions` carries THREE foreign keys to `contacts`
  // (transactions_contact_id_fkey, transactions_buyer_contact_id_fkey,
  // transactions_seller_contact_id_fkey), so PostgREST could not resolve a bare
  // `contacts(...)` and refused the WHOLE request with PGRST201. With no `error`
  // destructure that refusal arrived as `transactions = null`, which this function
  // reads as "this agent has closed nothing" — `closed_deals: 0`, `referral_rate: 0`,
  // and a trust score assembled from those zeros and returned as fact.
  //
  // The embed is REMOVED rather than disambiguated: only `transactions.length` is
  // used below, nothing reads the contact, so there is no party it could mean.
  const { data: transactions, error: closedDealsError } = await supabase
    .from("transactions")
    .select("id")
    .eq("agent_id", agentId)
    .eq("status", "closed")

  const { data: referrals, error: referralsError } = await supabase
    .from("contacts")
    .select("id")
    .eq("agent_id", agentId)
    .eq("source", "client_referral")
    .gte("created_at", startDate.toISOString())

  // FAIL CLOSED. A trust score is a number an agent is shown and believes. Building
  // one out of a refused read would publish "you have no closings and no referrals"
  // as a finding. Throwing (rather than returning a shape) keeps the existing
  // contract: every call site already wraps this in `.catch(...)`, and
  // loadValueDrivenDashboard below already signals unresolvable inputs by throwing.
  if (closedDealsError || referralsError) {
    throw new Error(
      `calculateTrustCapital: the relationship read was refused (${
        closedDealsError?.message ?? referralsError?.message
      }). This is a refusal, not an agent with no closings — no trust score is computed.`,
    )
  }

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

  const ctx = await resolveWriteContextForTenant()
  if (!ctx.ok) return null

  const supabase = ctx.db

  // Tenant anchor: the read is what authorises the write below, so it is
  // scoped to the caller's brokerage. Without `.eq("brokerage_id", …)` this
  // endpoint upserted a `lead_value_journey` row for any contact id in any
  // brokerage that the caller could guess.
  // `.maybeSingle()` rather than `.single()`: `.single()` returns an error
  // (PGRST116) for the zero-row case, which the un-destructured `{ data }`
  // then flattened into the same `null` as a genuine read failure.
  //
  // AMBIGUOUS EMBED — keep the `!transactions_contact_id_fkey` hint.
  // `transactions` carries THREE foreign keys to `contacts`
  // (transactions_contact_id_fkey, transactions_buyer_contact_id_fkey,
  // transactions_seller_contact_id_fkey), so the bare `transactions(*)` this
  // replaces was unresolvable and PostgREST refused the ENTIRE request with
  // PGRST201. The fail-closed guard below then returned null for every contact, so
  // no lead_value_journey row has ever been written from this path.
  //
  // `contact_id` is the party WE represent on the deal (documented on the canonical
  // writer, lib/transactions/offer-bridge.ts:302). This function answers "did this
  // lead become OUR client, and what was that worth" — which is exactly the
  // contact_id relationship. buyer_contact_id / seller_contact_id are side mirrors
  // that are null on the opposite side, so either would score a real conversion as
  // "never converted" for half the book.
  const { data: contact, error: contactError } = await supabase
    .from("contacts")
    .select(`
      id, created_at,
      transactions!transactions_contact_id_fkey(status, purchase_price, close_date)
    `)
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
  // Embedded rows come back UNORDERED, so `[0]` was an arbitrary deal. The
  // conversion moment is the EARLIEST close this contact has with us.
  const firstCloseDate = (contact.transactions ?? [])
    .map((t: any) => t.close_date)
    .filter(Boolean)
    .sort()[0] as string | undefined
  const conversionDate = firstCloseDate ? new Date(firstCloseDate) : null
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

  // Get traditional metrics (transactions).
  //
  // The `contacts(*)` embed this replaces refused the entire read. `transactions`
  // carries THREE foreign keys to `contacts` (transactions_contact_id_fkey,
  // transactions_buyer_contact_id_fkey, transactions_seller_contact_id_fkey), so a
  // bare `contacts(...)` is PGRST201 for the WHOLE request. With no `error`
  // destructure that landed as `transactions = null`, and this dashboard then
  // reported monthly_gci $0, units_closed 0, active_leads 0 and conversion_rate "0"
  // to an agent whose deals were all sitting in the table.
  //
  // Removed rather than disambiguated: nothing here reads the contact — only
  // `status` and `purchase_price` are used — so there is no party it could mean.
  const { data: transactions, error: transactionsError } = await supabase
    .from("transactions")
    .select("status, purchase_price")
    .eq("agent_id", agentId)
    .gte("created_at", startDate.toISOString())

  // FAIL CLOSED. Every headline number below is derived from this read; publishing
  // zeros for a refusal is the exact failure this dashboard shipped with.
  if (transactionsError) {
    throw new Error(
      `loadValueDrivenDashboard: the transaction read was refused (${transactionsError.message}). This is a refusal, not an empty pipeline.`,
    )
  }

  // Calculate aggregated metrics
  const totalValueDelivered =
    valueMetrics?.reduce((sum, m) => sum + (parseFloat(m.total_value_delivered_dollars as any) || 0), 0) || 0
  const peopleHelped = valueMetrics?.reduce((sum, m) => sum + (m.recipients_count || 0), 0) || 0
  const toolsUsed = valueMetrics?.reduce((sum, m) => sum + breakdownCount(m, "free_tools_used_count"), 0) || 0
  const guidesShared = valueMetrics?.reduce((sum, m) => sum + breakdownCount(m, "guides_downloaded_count"), 0) || 0
  // Per-tool + engagement rollup out of value_breakdown.tools_by_name /
  // .tool_engagement_seconds (written by aggregateValueDelivered above).
  const toolTotals: Record<string, number> = {}
  let engagementSeconds = 0
  for (const m of valueMetrics ?? []) {
    const b = (m as any)?.value_breakdown
    if (b && typeof b === "object") {
      const byName = (b as Record<string, unknown>).tools_by_name
      if (byName && typeof byName === "object") {
        for (const [name, n] of Object.entries(byName as Record<string, unknown>)) {
          toolTotals[name] = (toolTotals[name] ?? 0) + (Number(n) || 0)
        }
      }
      engagementSeconds += Number((b as Record<string, unknown>).tool_engagement_seconds) || 0
    }
  }
  const topTool = Object.entries(toolTotals).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null

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
      top_tool: topTool,
      tool_engagement_minutes: Math.round(engagementSeconds / 60),
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
