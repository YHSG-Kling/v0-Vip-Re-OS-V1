"use server"

/**
 * Team Lead brief — agents who lead a team get the agent brief PLUS
 * team-level signals (their team members' pipeline, fatigue, performance).
 *
 * Identification: a user is a team lead if any row in `teams` has
 * team_lead_id = users.id. They keep user_type='agent' but see expanded data.
 */

import { createServiceClient } from "@/lib/supabase/service"
import { generateTextRouted } from "@/lib/ai/models"
import type { UserTypeBrief, BriefPriority, BriefMetric } from "./types"

export async function generateTeamLeadBrief(params: {
  userId: string
  brokerageId: string
  forceRegenerate?: boolean
}): Promise<UserTypeBrief> {
  const supabase = createServiceClient()
  const today = new Date().toISOString().slice(0, 10)

  // Cache check
  if (!params.forceRegenerate) {
    const { data: cached } = await supabase
      .from("ai_daily_briefings")
      .select("*")
      .eq("agent_id", params.userId)
      .eq("briefing_date", today)
      .maybeSingle()
    if (cached) {
      const c = cached as unknown as {
        agent_id: string; brokerage_id: string; briefing_date: string;
        summary: string; top_priority_actions: BriefPriority[]; market_pulse: string; generated_at: string
      }
      return {
        userId: c.agent_id,
        userType: "team_lead",
        brokerageId: c.brokerage_id,
        briefingDate: c.briefing_date,
        summary: c.summary,
        priorities: c.top_priority_actions ?? [],
        metrics: parseMarketPulse(c.market_pulse),
        generatedAt: c.generated_at,
        cached: true,
      }
    }
  }

  // Find which team(s) this user leads
  const { data: teams } = await supabase
    .from("teams")
    .select("id, name")
    .eq("team_lead_id", params.userId)
    .eq("brokerage_id", params.brokerageId)

  const teamIds = (teams ?? []).map((t: { id: string }) => t.id)

  // Pull team-scoped data + the user's own agent data in parallel
  const [teamMembersRes, teamDealsAtRiskRes, teamPipelineRes] = await Promise.all([
    teamIds.length > 0
      ? supabase
          .from("users")
          .select("id, first_name, last_name", { count: "exact" })
          .in("team_id", teamIds)
      : Promise.resolve({ data: [], count: 0 } as { data: unknown[]; count: number }),
    teamIds.length > 0
      ? supabase
          .from("deal_health_scores")
          .select("transaction_id, overall_score, risk_level, transactions!inner(property_address, agent_id, users!inner(team_id))")
          .in("transactions.users.team_id", teamIds)
          .in("risk_level", ["critical", "at_risk"])
          .order("overall_score", { ascending: true })
          .limit(5)
      : Promise.resolve({ data: [] }),
    teamIds.length > 0
      ? supabase
          .from("contacts")
          .select("id", { count: "exact", head: true })
          .in("agent_id", await getTeamAgentIds(teamIds))
          .eq("status", "hot")
      : Promise.resolve({ count: 0 }),
  ])

  const teamMemberCount = (teamMembersRes as { count: number | null }).count ?? 0
  const dealsAtRisk = ((teamDealsAtRiskRes as { data: Array<{
    transaction_id: string; overall_score: number; risk_level: string;
    transactions: { property_address: string | null }
  }> }).data) ?? []
  const teamHotContacts = (teamPipelineRes as { count: number | null }).count ?? 0

  const priorities: BriefPriority[] = []

  if (dealsAtRisk.length > 0) {
    priorities.push({
      id: `team-deals-risk`,
      title: `${dealsAtRisk.length} team deal${dealsAtRisk.length === 1 ? "" : "s"} at risk`,
      body: `Most critical: ${dealsAtRisk[0].transactions.property_address ?? "unknown"} (score ${Math.round(dealsAtRisk[0].overall_score)})`,
      severity: dealsAtRisk[0].risk_level === "critical" ? "critical" : "high",
      ctas: [{ label: "Open team pipeline", href: "/dashboard/team-lead" }],
    })
  }

  if (teamMemberCount > 0) {
    priorities.push({
      id: "team-coaching",
      title: `${teamMemberCount} team member${teamMemberCount === 1 ? "" : "s"}`,
      body: teamHotContacts > 0
        ? `${teamHotContacts} hot contacts across the team — schedule 1:1s with members carrying the most`
        : `Pipeline stable — good time for skill-building 1:1s`,
      severity: "medium",
      ctas: [{ label: "View team", href: "/dashboard/team-lead" }],
    })
  }

  const metrics: BriefMetric[] = [
    { label: "Team members", value: teamMemberCount },
    { label: "Team deals at risk", value: dealsAtRisk.length },
    { label: "Team hot contacts", value: teamHotContacts },
  ]

  let summary = "Team running normally — focus on coaching and pipeline review."
  if (priorities.length > 0) {
    try {
      const { text } = await generateTextRouted({
        feature: "daily_briefing",
        prompt:
          `One-sentence morning brief for a real estate team lead. ` +
          `Priorities: ${priorities.map((p) => p.title).join(" · ")}. ` +
          `Tone: direct. Under 25 words.`,
        temperature: 0.4,
        maxTokens: 80,
      })
      summary = text.trim().replace(/^["']|["']$/g, "")
    } catch {
      summary = priorities.map((p) => p.title).slice(0, 2).join("; ")
    }
  }

  await supabase
    .from("ai_daily_briefings")
    .upsert(
      {
        agent_id: params.userId,
        brokerage_id: params.brokerageId,
        briefing_date: today,
        summary,
        top_priority_actions: priorities,
        market_pulse: JSON.stringify(metrics),
        ai_model_used: "claude-sonnet-routed",
        generated_at: new Date().toISOString(),
      },
      { onConflict: "agent_id,briefing_date" }
    )

  return {
    userId: params.userId,
    userType: "team_lead",
    brokerageId: params.brokerageId,
    briefingDate: today,
    summary,
    priorities,
    metrics,
    generatedAt: new Date().toISOString(),
  }
}

async function getTeamAgentIds(teamIds: string[]): Promise<string[]> {
  if (teamIds.length === 0) return []
  const supabase = createServiceClient()
  const { data } = await supabase.from("users").select("id").in("team_id", teamIds)
  return ((data ?? []) as Array<{ id: string }>).map((u) => u.id)
}

function parseMarketPulse(market_pulse: string): BriefMetric[] {
  try {
    const parsed = JSON.parse(market_pulse)
    if (Array.isArray(parsed)) return parsed
  } catch {}
  return []
}

/** Detect whether a user is a team lead (leads any team in their brokerage) */
export async function isTeamLead(userId: string, brokerageId: string): Promise<boolean> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from("teams")
    .select("id")
    .eq("team_lead_id", userId)
    .eq("brokerage_id", brokerageId)
    .limit(1)
    .maybeSingle()
  return !!data
}
