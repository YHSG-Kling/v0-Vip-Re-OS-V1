/**
 * Daily AI Briefing Generator — Layer 12 AI Intelligence Mesh
 * 
 * Generates personalized daily briefings for agents aggregating:
 * - Tasks (overdue and due today/tomorrow)
 * - Transactions (active deals)
 * - Leads (hot, new)
 * - Showings (next 2 days)
 * - Deal health scores
 * - Calendar events (today)
 * - Contacts (hot status)
 * 
 * Uses Claude to generate an action-oriented summary with priorities.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { KernelEvent } from "@/lib/kernel/events"

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PriorityAction {
  priority: "high" | "medium" | "low"
  action: string
  context: string
  /** Optional entity reference so the UI can build a deep link. */
  entity_type?: "contact" | "transaction" | "listing" | "task" | null
  entity_id?: string | null
  /** Optional action verb so the UI knows which sheet/modal to open. */
  action_type?:
    | "open_contact"
    | "draft_followup"
    | "schedule_appointment"
    | "view_transaction"
    | "view_listing"
    | "complete_task"
    | "view_lead"
    | null
}

export interface HotLead {
  name: string
  status: string
  suggested_action: string
}

export interface DealAtRisk {
  transaction_id: string
  address: string
  reason: string
}

export interface ListingAtRisk {
  listing_id: string
  address: string
  reason: string
  risk_level: "watch" | "at_risk" | "critical"
  score: number
}

export interface DailyBriefing {
  id: string
  agent_id: string
  brokerage_id: string
  briefing_date: string
  summary: string
  top_priority_actions: PriorityAction[]
  market_pulse: string
  hot_leads: HotLead[]
  todays_events: any[]
  tasks_overdue: number
  deals_at_risk: DealAtRisk[]
  listings_at_risk: ListingAtRisk[]
  ai_model_used: string
  generated_at: string
  opened_at: string | null
}

// ─── Constants ────────────────────────────────────────────────────────────────

const AI_MODEL = "claude-sonnet-4-20250514"
const MAX_TOKENS = 1000

// ─── Main Generator Function ──────────────────────────────────────────────────

export async function generateDailyBriefing(
  agentId: string,
  brokerageId: string,
  forceRegenerate: boolean = false
): Promise<DailyBriefing> {
  const supabase = createServiceClient()
  const today = new Date().toISOString().split("T")[0]

  // 1. Check for existing briefing today
  if (!forceRegenerate) {
    const { data: existing } = await supabase
      .from("ai_daily_briefings")
      .select("*")
      .eq("agent_id", agentId)
      .eq("briefing_date", today)
      .maybeSingle()

    if (existing) {
      return existing as DailyBriefing
    }
  }

  // 2. Fetch 7 data sources in PARALLEL
  const tomorrow = new Date()
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = tomorrow.toISOString().split("T")[0]

  const twoDaysOut = new Date()
  twoDaysOut.setDate(twoDaysOut.getDate() + 2)

  const [
    tasksResult,
    transactionsResult,
    leadsResult,
    showingsResult,
    calendarResult,
    contactsResult,
  ] = await Promise.all([
    // Tasks: overdue or due today/tomorrow
    supabase
      .from("tasks")
      .select("id, title, description, due_date, priority, status")
      .eq("assigned_to_agent_id", agentId)
      .neq("status", "completed")
      .lte("due_date", tomorrowStr)
      .order("due_date", { ascending: true })
      .limit(20),

    // Transactions: active deals
    supabase
      .from("transactions")
      .select("id, deal_name, property_address, stage, purchase_price, close_date, health_score")
      .eq("agent_id", agentId)
      .not("stage", "in", '("closed","cancelled")')
      .limit(10),

    // Leads: new leads by score
    supabase
      .from("leads")
      .select("id, first_name, last_name, lead_score, lead_stage, source, last_contacted_at")
      .eq("agent_id", agentId)
      .eq("lead_stage", "new")
      .order("lead_score", { ascending: false })
      .limit(5),

    // Showings: next 2 days
    supabase
      .from("showings")
      .select("id, listing_id, contact_id, scheduled_at, status, notes")
      .eq("agent_id", agentId)
      .gte("scheduled_at", new Date().toISOString())
      .lte("scheduled_at", twoDaysOut.toISOString())
      .order("scheduled_at", { ascending: true })
      .limit(10),

    // Calendar events: today
    supabase
      .from("calendar_events")
      .select("id, event_type, start_at, end_at, metadata")
      .eq("entity_id", agentId)
      .gte("start_at", today)
      .lt("start_at", tomorrowStr)
      .order("start_at", { ascending: true })
      .limit(10),

    // Contacts: hot status
    supabase
      .from("contacts")
      .select("id, first_name, last_name, status, intent_score, last_scored_at")
      .eq("agent_id", agentId)
      .eq("status", "hot")
      .limit(5),
  ])

  const tasks = tasksResult.data || []
  const transactions = transactionsResult.data || []
  const leads = leadsResult.data || []
  const showings = showingsResult.data || []
  const calendarEvents = calendarResult.data || []
  const hotContacts = contactsResult.data || []

  // Fetch deal health scores for active transactions
  const transactionIds = transactions.map((t) => t.id)
  let dealHealthScores: any[] = []
  if (transactionIds.length > 0) {
    const { data: healthData } = await supabase
      .from("deal_health_scores")
      .select("transaction_id, overall_score, risk_level, flags, ai_narrative")
      .in("transaction_id", transactionIds)

    dealHealthScores = healthData || []
  }

  // Calculate overdue tasks
  const tasksOverdue = tasks.filter((t) => {
    const dueDate = new Date(t.due_date)
    const todayDate = new Date(today)
    return dueDate < todayDate
  }).length

  // Identify deals at risk
  const dealsAtRisk: DealAtRisk[] = dealHealthScores
    .filter((h) => h.risk_level === "high" || h.risk_level === "critical")
    .map((h) => {
      const tx = transactions.find((t) => t.id === h.transaction_id)
      return {
        transaction_id: h.transaction_id,
        address: tx?.property_address || "Unknown",
        reason: h.ai_narrative || `Risk level: ${h.risk_level}`,
      }
    })

  // Fetch listing health for the agent's active listings — mirrors the
  // deal-health block above. Surfaces a "listings at risk" section so
  // the agent's morning briefing covers both sides of the lifecycle.
  let listingsAtRisk: ListingAtRisk[] = []
  try {
    const { data: agentListings } = await supabase
      .from("listings")
      .select("id, address, status")
      .eq("agent_id", agentId)
      .in("status", ["active", "coming_soon"])

    const listingIds = (agentListings ?? []).map((l) => l.id)
    if (listingIds.length > 0) {
      const { data: lhRows } = await supabase
        .from("listing_health_scores")
        .select("listing_id, overall_score, risk_level, ai_narrative, flags, scored_at")
        .in("listing_id", listingIds)
        .order("scored_at", { ascending: false })
        .limit(50)

      const seen = new Set<string>()
      for (const row of (lhRows ?? []) as Array<{
        listing_id: string
        overall_score: number
        risk_level: string
        ai_narrative: string | null
        flags: string[] | null
      }>) {
        if (seen.has(row.listing_id)) continue
        seen.add(row.listing_id)
        if (row.risk_level !== "at_risk" && row.risk_level !== "critical") continue
        const listing = agentListings?.find((l) => l.id === row.listing_id)
        const topFlag = row.flags?.[0] ?? null
        listingsAtRisk.push({
          listing_id: row.listing_id,
          address:    listing?.address ?? "Unknown",
          reason:     row.ai_narrative ?? topFlag ?? `Health score ${row.overall_score}/100`,
          risk_level: row.risk_level as "at_risk" | "critical",
          score:      row.overall_score,
        })
      }
      // Cap at 5 for the briefing
      listingsAtRisk = listingsAtRisk.slice(0, 5)
    }
  } catch (err) {
    console.error("[DailyBriefing] listing-health fetch failed:", err)
  }

  // 3. Call Claude to generate briefing
  const dataSnapshot = {
    tasks: tasks.slice(0, 10),
    transactions: transactions.slice(0, 5),
    leads: leads.slice(0, 5),
    showings: showings.slice(0, 5),
    calendarEvents: calendarEvents.slice(0, 5),
    hotContacts: hotContacts.slice(0, 3),
    dealHealthScores: dealHealthScores.slice(0, 5),
    tasksOverdue,
  }

  const systemPrompt = `You are an AI briefing generator for a real estate agent. Generate a concise daily briefing based on the data provided. Be action-oriented and prioritize the most urgent items.

Output ONLY valid JSON matching this exact schema (no markdown, no extra text):
{
  "summary": "2-3 sentence overview of the day",
  "top_priority_actions": [
    {
      "priority": "high" | "medium" | "low",
      "action": "specific action to take",
      "context": "why this matters",
      "entity_type": "contact" | "transaction" | "listing" | "task" | null,
      "entity_id": "<uuid from the data snapshot when known, otherwise null>",
      "action_type": "open_contact" | "draft_followup" | "schedule_appointment" | "view_transaction" | "view_listing" | "complete_task" | "view_lead" | null
    }
  ],
  "market_pulse": "1 sentence market observation based on the data",
  "hot_leads": [
    {"name": "lead name", "status": "current status", "suggested_action": "recommended next step"}
  ],
  "deals_at_risk": [
    {"transaction_id": "uuid", "address": "property address", "reason": "why it's at risk"}
  ]
}

Rules:
- top_priority_actions: max 5 items, ordered by urgency
- For EVERY priority action, populate entity_type + entity_id by looking up
  the corresponding row in the data snapshot. If the action is about a
  contact, use that contact's id; if about a deal, the transaction id; etc.
  Use null only when no specific entity applies.
- Pick action_type based on what the agent should DO: 'draft_followup' if
  they should reply to a contact; 'view_transaction' if they should review
  a deal; 'complete_task' if they should mark a task done; etc.
- hot_leads: max 3 items
- deals_at_risk: only include transactions with health issues
- Be specific and actionable
- Focus on what needs attention TODAY`

  const userPrompt = `Generate today's briefing from this data:
${JSON.stringify(dataSnapshot, null, 2)}`

  let aiResponse: {
    summary: string
    top_priority_actions: PriorityAction[]
    market_pulse: string
    hot_leads: HotLead[]
    deals_at_risk: DealAtRisk[]
  }

  try {
    const result = await generateText({
      model: resolveModel(`anthropic/${AI_MODEL}` as Parameters<typeof resolveModel>[0]),
      system: systemPrompt,
      prompt: userPrompt,
      maxOutputTokens: MAX_TOKENS,
      temperature: 0.3,
    })

    // Parse JSON response
    const cleanedText = result.text.replace(/```json\n?|\n?```/g, "").trim()
    aiResponse = JSON.parse(cleanedText)
  } catch (error) {
    console.error("[DailyBriefing] AI generation failed:", error)
    // Fallback to basic briefing
    aiResponse = {
      summary: `You have ${tasks.length} pending tasks and ${transactions.length} active deals. ${tasksOverdue > 0 ? `${tasksOverdue} tasks are overdue.` : ""}`,
      top_priority_actions: tasks.slice(0, 3).map((t) => ({
        priority: t.priority === "high" ? "high" : "medium",
        action: t.title,
        context: t.description || "Task requires attention",
      })) as PriorityAction[],
      market_pulse: "Review your active pipeline for opportunities.",
      hot_leads: leads.slice(0, 3).map((l) => ({
        name: `${l.first_name || ""} ${l.last_name || ""}`.trim() || "Unknown",
        status: l.lead_stage || "new",
        suggested_action: "Follow up within 24 hours",
      })),
      deals_at_risk: dealsAtRisk.slice(0, 3),
    }
  }

  // Merge AI-identified deals at risk with our calculation
  const finalDealsAtRisk = [
    ...aiResponse.deals_at_risk,
    ...dealsAtRisk.filter(
      (d) => !aiResponse.deals_at_risk.some((a) => a.transaction_id === d.transaction_id)
    ),
  ].slice(0, 5)

  // 4. UPSERT ai_daily_briefings
  const briefingData = {
    agent_id: agentId,
    brokerage_id: brokerageId,
    briefing_date: today,
    summary: aiResponse.summary,
    top_priority_actions: aiResponse.top_priority_actions,
    hot_leads: aiResponse.hot_leads,
    todays_events: calendarEvents,
    market_pulse: aiResponse.market_pulse,
    deals_at_risk: finalDealsAtRisk,
    listings_at_risk: listingsAtRisk,
    tasks_overdue: tasksOverdue,
    ai_model_used: AI_MODEL,
    generated_at: new Date().toISOString(),
    active_transactions_summary: transactions.slice(0, 5),
  }

  // Try to update the existing briefing for today first, then insert if none exists.
  // This avoids relying on a named unique constraint for upsert conflict resolution.
  const { data: existingForUpsert } = await supabase
    .from("ai_daily_briefings")
    .select("id")
    .eq("agent_id", agentId)
    .eq("briefing_date", today)
    .maybeSingle()

  let upsertedBriefing: any
  let upsertError: any

  if (existingForUpsert?.id) {
    const { data, error } = await supabase
      .from("ai_daily_briefings")
      .update(briefingData)
      .eq("id", existingForUpsert.id)
      .select()
      .single()
    upsertedBriefing = data
    upsertError = error
  } else {
    const { data, error } = await supabase
      .from("ai_daily_briefings")
      .insert(briefingData)
      .select()
      .single()
    upsertedBriefing = data
    upsertError = error
  }

  if (upsertError) {
    console.error("[DailyBriefing] Save failed:", upsertError)
    throw new Error(`Failed to save briefing: ${upsertError.message}`)
  }

  // 5. INSERT lifecycle_events
  await supabase
    .from("lifecycle_events")
    .insert({
      brokerage_id: brokerageId,
      entity_type: "ai_daily_briefing",
      entity_id: upsertedBriefing.id,
      event_type: KernelEvent.DAILY_BRIEFING_GENERATED,
      metadata: {
        agent_id: agentId,
        briefing_date: today,
        tasks_count: tasks.length,
        transactions_count: transactions.length,
        deals_at_risk_count: finalDealsAtRisk.length,
        listings_at_risk_count: listingsAtRisk.length,
      },
    })

  // 6. Return briefing data
  return upsertedBriefing as DailyBriefing
}

// ─── Mark Briefing as Opened ──────────────────────────────────────────────────

export async function markBriefingOpened(agentId: string): Promise<void> {
  const supabase = createServiceClient()
  const today = new Date().toISOString().split("T")[0]

  await supabase
    .from("ai_daily_briefings")
    .update({ opened_at: new Date().toISOString() })
    .eq("agent_id", agentId)
    .eq("briefing_date", today)
    .is("opened_at", null)
}
