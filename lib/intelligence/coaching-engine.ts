import { generateText } from "ai"
import { resolveModel } from "@/lib/ai/resolve-model"
import { createServiceClient } from "@/lib/supabase/service"
import { KernelEvent } from "@/lib/kernel/events"
import { emitKernelEvent } from "@/lib/kernel/emit"

export type BuyerPersona =
  | "first_time"
  | "investor"
  | "relocating"
  | "upgrading"
  | "downsizing"
  | "analytical"
  | null

export interface BuyerCoachingContent {
  id?: string
  buyer_stage: string
  persona: string | null
  brokerage_id?: string | null
  coaching_headline: string
  coaching_body: string
  suggested_talking_points: string[]
  avoid_pitfalls: string[]
  buyer_needs_now: string
  common_objections: { objection: string; response: string }[]
  next_action_prompt: string
  estimated_stage_duration: string | null
  success_signals: string[]
  risk_signals: string[]
  ai_generated: boolean
  updated_at?: string
  generated_by?: string
}

export interface WeeklyCoachingReport {
  overall_score: number
  headline: string
  wins: string[]
  gaps: string[]
  top_recommendation: string
  recommended_actions: string[]
  deal_focus: string
}

/**
 * generateWeeklyCoachingReport
 * Analyzes last 7 days of agent activity and generates AI coaching report
 */
export async function generateWeeklyCoachingReport(
  agentId: string,
  brokerageId: string
): Promise<WeeklyCoachingReport> {
  const supabase = createServiceClient()
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()
  const periodStart = sevenDaysAgo
  const periodEnd = new Date().toISOString()

  // Load last 7 days data in parallel
  const [activitiesResult, transactionsResult, interventionsResult] = await Promise.all([
    supabase
      .from("activities")
      .select("*")
      .eq("agent_id", agentId)
      .gte("created_at", sevenDaysAgo)
      .order("created_at", { ascending: false })
      .limit(100),
    supabase
      .from("transactions")
      .select("id, status, property_address, transaction_type, target_close_date")
      .eq("agent_id", agentId)
      .in("status", ["active", "pending", "under_contract"]),
    supabase
      .from("proactive_interventions")
      .select("*")
      .eq("brokerage_id", brokerageId)
      .eq("resolved", false)
      .order("created_at", { ascending: false })
      .limit(20),
  ])

  const activities = activitiesResult.data || []
  const transactions = transactionsResult.data || []
  const interventions = interventionsResult.data || []

  // Get deal health scores for active transactions
  let healthScores: Array<{ transaction_id: string; overall_score: number }> = []
  if (transactions.length > 0) {
    const txIds = transactions.map((t) => t.id)
    const { data: scores } = await supabase
      .from("deal_health_scores")
      .select("transaction_id, overall_score")
      .in("transaction_id", txIds)
      .order("calculated_at", { ascending: false })

    // Get latest score per transaction
    const scoreMap = new Map<string, number>()
    for (const s of scores || []) {
      if (!scoreMap.has(s.transaction_id)) {
        scoreMap.set(s.transaction_id, s.overall_score)
      }
    }
    healthScores = Array.from(scoreMap.entries()).map(([transaction_id, overall_score]) => ({
      transaction_id,
      overall_score,
    }))
  }

  // Summarize data for AI
  const activitySummary = {
    total_activities: activities.length,
    by_type: activities.reduce((acc: Record<string, number>, a) => {
      acc[a.activity_type] = (acc[a.activity_type] || 0) + 1
      return acc
    }, {}),
  }

  const transactionSummary = {
    total_active: transactions.length,
    by_status: transactions.reduce((acc: Record<string, number>, t) => {
      acc[t.status] = (acc[t.status] || 0) + 1
      return acc
    }, {}),
    avg_health_score:
      healthScores.length > 0
        ? Math.round(healthScores.reduce((sum, h) => sum + h.overall_score, 0) / healthScores.length)
        : null,
    at_risk_count: healthScores.filter((h) => h.overall_score < 60).length,
  }

  const interventionSummary = {
    unresolved_count: interventions.length,
    by_severity: interventions.reduce((acc: Record<string, number>, i) => {
      acc[i.severity] = (acc[i.severity] || 0) + 1
      return acc
    }, {}),
  }

  // Generate report with AI
  const { text } = await generateText({
    model: resolveModel("anthropic/claude-sonnet-4-20250514"),
    maxOutputTokens: 800,
    system:
      "You are a real estate sales coach. Generate a weekly coaching report as JSON only. " +
      "Keys: overall_score (0-100), headline (string), wins (array of 2-3 strings), " +
      "gaps (array of 2-3 strings), top_recommendation (string), " +
      "recommended_actions (array of 3 strings), deal_focus (string).",
    prompt: `Analyze this agent's 7-day performance and generate coaching:
    
Activities: ${JSON.stringify(activitySummary)}
Transactions: ${JSON.stringify(transactionSummary)}
Interventions: ${JSON.stringify(interventionSummary)}

Generate actionable coaching focused on improving conversion and client service.`,
  })

  let report: WeeklyCoachingReport

  try {
    const clean = text.trim().replace(/^```json?\s*/i, "").replace(/\s*```$/i, "")
    report = JSON.parse(clean) as WeeklyCoachingReport
  } catch {
    // Fallback if AI response is malformed
    report = {
      overall_score: 70,
      headline: "Solid Week — Room for Growth",
      wins: [
        `Logged ${activities.length} activities this week`,
        `Managing ${transactions.length} active transactions`,
      ],
      gaps: [
        "Consider increasing follow-up frequency",
        "Review at-risk deals for intervention opportunities",
      ],
      top_recommendation: "Focus on high-priority follow-ups to move deals forward.",
      recommended_actions: [
        "Schedule check-ins with all active clients",
        "Review and resolve open interventions",
        "Update transaction milestones",
      ],
      deal_focus:
        transactions.length > 0
          ? `Priority: ${transactions[0].property_address || "Active transaction"}`
          : "Focus on lead generation this week",
    }
  }

  // Store report in agent_performance_reports
  const { error: insertError } = await supabase.from("agent_performance_reports").insert({
    agent_id: agentId,
    brokerage_id: brokerageId,
    report_type: "weekly",
    period_start: periodStart,
    period_end: periodEnd,
    overall_score: report.overall_score,
    ai_narrative: report.headline,
    strengths: report.wins,
    improvement_areas: report.gaps,
    recommended_actions: report.recommended_actions,
    metadata: {
      top_recommendation: report.top_recommendation,
      deal_focus: report.deal_focus,
    },
    compliance_approved: false,
  })

  if (insertError) {
    console.error("[v0] Failed to insert performance report:", insertError.message)
  }

  // Emit through the canonical kernel emitter — INSERT + reactor fan-out (staff notifications +
  // sequences + portal) in one call. A bare lifecycle_events insert silently dropped agent
  // notifications for coaching reports.
  await emitKernelEvent({
    event:       KernelEvent.COACHING_REPORT_GENERATED,
    brokerageId,
    entityType:  "agent",
    entityId:    agentId,
    agentUserId: agentId,
    metadata: {
      report_type:   "weekly",
      overall_score: report.overall_score,
      period_start:  periodStart,
      period_end:    periodEnd,
    },
  })

  return report
}

/**
 * getBuyerCoaching
 * Priority: brokerage-specific + persona-specific > brokerage-specific + generic >
 *           system-default + persona-specific > system-default + generic
 * If no cached row found, generates via AI and caches as system default.
 */
export async function getBuyerCoaching(
  buyerStage: string,
  persona: BuyerPersona,
  brokerageId: string
): Promise<BuyerCoachingContent> {
  const supabase = createServiceClient()

  // 1. Cache lookup — priority: brokerage-specific wins, persona-specific wins
  const { data: cached } = await supabase
    .from("buyer_stage_coaching")
    .select("*")
    .eq("buyer_stage", buyerStage)
    .or(persona ? `persona.eq.${persona},persona.is.null` : `persona.is.null`)
    .or(`brokerage_id.eq.${brokerageId},brokerage_id.is.null`)
    .order("brokerage_id", { ascending: false, nullsFirst: false })
    .order("persona", { ascending: false, nullsFirst: false })
    .limit(1)
    .single()

  if (cached) {
    // 7-day freshness check — stale rows are regenerated
    const updatedAt = cached.updated_at ? new Date(cached.updated_at).getTime() : 0
    const sevenDays = 7 * 24 * 60 * 60 * 1000
    const isFresh = Date.now() - updatedAt < sevenDays
    if (isFresh) return cached as BuyerCoachingContent
    // Fall through to regenerate stale content
  }

  // 2. No cache or stale — generate with AI
  return generateBuyerCoachingWithAI(buyerStage, persona, brokerageId)
}

async function generateBuyerCoachingWithAI(
  buyerStage: string,
  persona: BuyerPersona,
  brokerageId: string
): Promise<BuyerCoachingContent> {
  const supabase = createServiceClient()
  const personaLabel = persona ?? "standard"
  const stageLabel = buyerStage.replace(/_/g, " ").toLowerCase()

  const { text } = await generateText({
    model: resolveModel("anthropic/claude-sonnet-4-20250514"),
    system:
      "You are a real estate coaching AI. Generate coaching for a buyer's agent at a specific " +
      "stage of the buyer journey. Return JSON only with keys: " +
      "talking_points (array of 3 strings), avoid_pitfalls (array of 2 strings), " +
      "buyer_needs_now (string, 1 sentence empathy prompt).",
    prompt: `Stage: ${stageLabel}. Buyer persona: ${personaLabel}. Generate coaching for this agent.`,
  })

  type AIPayload = {
    talking_points: string[]
    avoid_pitfalls: string[]
    buyer_needs_now: string
  }

  let ai: AIPayload

  try {
    const clean = text.trim().replace(/^```json?\s*/i, "").replace(/\s*```$/i, "")
    ai = JSON.parse(clean) as AIPayload
  } catch {
    ai = {
      talking_points: [
        "Confirm buyer's must-haves and deal-breakers",
        "Review recent market activity in their target areas",
        "Set expectations for the next step in their journey",
      ],
      avoid_pitfalls: [
        "Overwhelming buyers with too many options too soon",
        "Skipping the financing conversation early in the process",
      ],
      buyer_needs_now: "Your buyer needs reassurance that you understand their priorities and timeline.",
    }
  }

  // Build full content object
  const content: Omit<BuyerCoachingContent, "id" | "updated_at"> = {
    buyer_stage: buyerStage,
    persona: persona ?? null,
    brokerage_id: null, // system default
    coaching_headline: `AI Coaching — ${stageLabel.replace(/\b\w/g, (c) => c.toUpperCase())}`,
    coaching_body: `Focus on the ${personaLabel} buyer's priorities at this stage.`,
    suggested_talking_points: ai.talking_points,
    avoid_pitfalls: ai.avoid_pitfalls,
    buyer_needs_now: ai.buyer_needs_now,
    common_objections: [],
    next_action_prompt: "Schedule a follow-up with your buyer within 24 hours.",
    estimated_stage_duration: null,
    success_signals: [],
    risk_signals: [],
    ai_generated: true,
    generated_by: "anthropic/claude-sonnet-4-20250514",
  }

  // UPSERT
  const { data: upserted } = await supabase
    .from("buyer_stage_coaching")
    .upsert(
      {
        brokerage_id: null,
        buyer_stage: buyerStage,
        persona: persona ?? null,
        coaching_headline: content.coaching_headline,
        coaching_body: content.coaching_body,
        suggested_talking_points: content.suggested_talking_points,
        avoid_pitfalls: content.avoid_pitfalls,
        buyer_needs_now: content.buyer_needs_now,
        common_objections: content.common_objections,
        next_action_prompt: content.next_action_prompt,
        estimated_stage_duration: content.estimated_stage_duration,
        success_signals: content.success_signals,
        risk_signals: content.risk_signals,
        ai_generated: true,
        generated_by: content.generated_by,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "buyer_stage,persona,brokerage_id" }
    )
    .select("*")
    .single()

  return (upserted ?? content) as BuyerCoachingContent
}

/**
 * getLatestWeeklyReport
 * Fetches the most recent weekly coaching report for an agent
 */
export async function getLatestWeeklyReport(agentId: string) {
  const supabase = createServiceClient()

  const { data } = await supabase
    .from("agent_performance_reports")
    .select("*")
    .eq("agent_id", agentId)
    .eq("report_type", "weekly")
    .order("created_at", { ascending: false })
    .limit(1)
    .single()

  if (!data) return null

  return {
    id: data.id,
    overall_score: data.overall_score,
    headline: data.ai_narrative,
    wins: data.strengths || [],
    gaps: data.improvement_areas || [],
    top_recommendation: data.metadata?.top_recommendation || "",
    recommended_actions: data.recommended_actions || [],
    deal_focus: data.metadata?.deal_focus || "",
    created_at: data.created_at,
  }
}
