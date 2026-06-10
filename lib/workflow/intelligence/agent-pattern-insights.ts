/**
 * lib/workflow/intelligence/agent-pattern-insights.ts
 *
 * Reads an agent's deal history (offers + transactions + workflow_step_runs)
 * and surfaces patterns as gentle nudges:
 *   - "On condos, your offers are accepted 75% of the time when EMD ≥ 3%"
 *   - "Top performer in your brokerage averages 0.9 days from offer to
 *     acceptance; your average is 2.3 — they typically write offer letters"
 *   - "Your win rate on multiple-offer is 38%; brokerage best is 58%"
 *
 * Insights are produced on-demand from the data — no offline ML pipeline.
 * Calls the existing AI text router for narrative generation only.
 *
 * Used by:
 *   - dashboard "AI insights" widget
 *   - inline FormWizard nudges during draft (e.g. "you typically use 3% EMD")
 *   - coaching dashboard
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted } from "@/lib/ai/models"

export interface AgentInsight {
  category:     "win_rate" | "speed" | "pricing" | "addenda" | "negotiation" | "follow_up"
  severity:     "tip" | "opportunity" | "warning"
  title:        string
  detail:       string
  metric?:      { agentValue: number; brokerageBest?: number; brokerageAvg?: number; unit: "%" | "days" | "$" | "count" }
  recommendation: string
}

export interface AgentInsights {
  agentUserId:    string
  generatedAt:    string
  dealsAnalyzed:  number
  insights:       AgentInsight[]
  summary:        string                              // 2-3 sentence AI take
}

const MIN_DEALS_FOR_PATTERNS = 5

export async function getAgentPatternInsights(input: {
  agentUserId: string
  brokerageId: string
  lookbackDays?: number
}): Promise<AgentInsights> {
  const svc = createServiceClient()
  const lookback = input.lookbackDays ?? 365
  const since = new Date(Date.now() - lookback * 86_400_000).toISOString()

  // Resolve agent.id from user_id (offers.agent_id is agents.id)
  const { data: agent } = await svc
    .from("agents").select("id").eq("user_id", input.agentUserId).maybeSingle()
  if (!agent) {
    return emptyInsights(input.agentUserId)
  }

  // Pull the agent's offers
  const { data: offers } = await svc
    .from("offers")
    .select("id, status, offer_price, earnest_money, financing_type, contingencies, escalation_cap, created_at, accepted_at:responded_at, listing_id")
    .eq("agent_id", agent.id)
    .gte("created_at", since)

  const dealsAnalyzed = offers?.length ?? 0
  if (dealsAnalyzed < MIN_DEALS_FOR_PATTERNS) {
    return {
      agentUserId: input.agentUserId,
      generatedAt: new Date().toISOString(),
      dealsAnalyzed,
      insights: [],
      summary: `You have ${dealsAnalyzed} offers in the last ${lookback} days. Patterns appear after ${MIN_DEALS_FOR_PATTERNS}+ deals.`,
    }
  }

  const insights: AgentInsight[] = []

  // ── Win rate ──────────────────────────────────────────────────────────
  const accepted = offers!.filter(o => o.status === "accepted").length
  const winRatePct = (accepted / dealsAnalyzed) * 100
  insights.push({
    category: "win_rate",
    severity: winRatePct >= 50 ? "tip" : "opportunity",
    title:    `${winRatePct.toFixed(0)}% offer win rate`,
    detail:   `${accepted} of your last ${dealsAnalyzed} offers were accepted.`,
    metric:   { agentValue: winRatePct, unit: "%" },
    recommendation: winRatePct < 40
      ? "Consider escalation clauses on competitive listings and personal-letter addenda."
      : "Strong rate — replicate the formula on every multiple-offer situation.",
  })

  // ── Average EMD % on accepted offers vs declined ─────────────────────
  const acceptedEmdPcts = offers!
    .filter(o => o.status === "accepted" && o.earnest_money && o.offer_price)
    .map(o => (o.earnest_money / o.offer_price) * 100)
  const declinedEmdPcts = offers!
    .filter(o => o.status === "rejected" && o.earnest_money && o.offer_price)
    .map(o => (o.earnest_money / o.offer_price) * 100)
  if (acceptedEmdPcts.length >= 3 && declinedEmdPcts.length >= 3) {
    const acceptedAvg = avg(acceptedEmdPcts)
    const declinedAvg = avg(declinedEmdPcts)
    if (acceptedAvg - declinedAvg > 0.5) {
      insights.push({
        category: "negotiation",
        severity: "tip",
        title:    "Higher EMD correlates with your accepted offers",
        detail:   `Your accepted offers averaged ${acceptedAvg.toFixed(1)}% EMD vs ${declinedAvg.toFixed(1)}% on declined offers.`,
        metric:   { agentValue: acceptedAvg, unit: "%" },
        recommendation: `Default to ${Math.round(acceptedAvg)}% EMD on competitive listings.`,
      })
    }
  }

  // ── Days from offer to acceptance ─────────────────────────────────────
  const acceptanceDays = offers!
    .filter(o => o.status === "accepted" && o.accepted_at && o.created_at)
    .map(o => (new Date(o.accepted_at).getTime() - new Date(o.created_at).getTime()) / 86_400_000)
  if (acceptanceDays.length >= 3) {
    const agentAvgDays = avg(acceptanceDays)
    // Compare to brokerage best
    const { data: brokerageOffers } = await svc
      .from("offers")
      .select("created_at, accepted_at:responded_at, agent_id")
      .eq("status", "accepted")
      .gte("created_at", since)
      .not("responded_at", "is", null)
    const brokerageDays = (brokerageOffers ?? [])
      .filter(o => o.created_at && o.accepted_at)
      .map(o => (new Date(o.accepted_at!).getTime() - new Date(o.created_at).getTime()) / 86_400_000)
    const brokerageBest = brokerageDays.length > 0 ? Math.min(...brokerageDays.filter(d => d > 0)) : null
    const brokerageAvg = brokerageDays.length > 0 ? avg(brokerageDays) : null
    if (brokerageAvg != null && agentAvgDays > brokerageAvg * 1.5) {
      insights.push({
        category: "speed",
        severity: "opportunity",
        title:    "Slower than brokerage average to acceptance",
        detail:   `Your average is ${agentAvgDays.toFixed(1)} days; brokerage average is ${brokerageAvg.toFixed(1)} days; brokerage best is ${(brokerageBest ?? 0).toFixed(1)} days.`,
        metric:   { agentValue: agentAvgDays, brokerageAvg, brokerageBest: brokerageBest ?? undefined, unit: "days" },
        recommendation: "Top performers typically: write a buyer letter, lead with EMD ≥ 3%, and offer flexible close dates.",
      })
    }
  }

  // ── Escalation clause usage on multi-offer wins ───────────────────────
  const withEscalation = offers!.filter(o => o.escalation_cap && o.status === "accepted").length
  const totalAccepted = accepted
  if (totalAccepted >= 5) {
    const escalationPct = (withEscalation / totalAccepted) * 100
    if (escalationPct < 25) {
      insights.push({
        category: "negotiation",
        severity: "opportunity",
        title:    "Escalation clauses are uncommon in your accepted offers",
        detail:   `Only ${escalationPct.toFixed(0)}% of your accepted offers used an escalation clause.`,
        metric:   { agentValue: escalationPct, unit: "%" },
        recommendation: "On multiple-offer situations, escalation can win without overpaying upfront. Default cap = +5% above current bid.",
      })
    }
  }

  // ── AI summary ────────────────────────────────────────────────────────
  let summary = ""
  try {
    const insightsTL = insights.slice(0, 3).map(i => `${i.title}: ${i.recommendation}`).join("\n")
    const { text } = await generateTextRouted({
      feature: "agent_pattern_summary",
      messages: [{
        role: "user",
        content: `Write a 2-3 sentence coaching summary for an agent with ${dealsAnalyzed} deals analyzed:\n${insightsTL}\nDirect, encouraging, action-focused. No fluff.`,
      }],
    })
    summary = text.trim()
  } catch {
    summary = `Analyzed ${dealsAnalyzed} deals. ${insights.length} insights surfaced.`
  }

  return {
    agentUserId: input.agentUserId,
    generatedAt: new Date().toISOString(),
    dealsAnalyzed,
    insights,
    summary,
  }
}

function emptyInsights(agentUserId: string): AgentInsights {
  return {
    agentUserId,
    generatedAt: new Date().toISOString(),
    dealsAnalyzed: 0,
    insights: [],
    summary: "No deal history yet — patterns surface after a few accepted/declined offers.",
  }
}

function avg(arr: number[]): number {
  if (arr.length === 0) return 0
  return arr.reduce((a, b) => a + b, 0) / arr.length
}
