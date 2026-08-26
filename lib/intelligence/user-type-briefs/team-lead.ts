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
      .eq("user_id", params.userId)
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

  // Find which team(s) this user leads (live teams only)
  const { data: teams } = await supabase
    .from("teams")
    .select("id, name")
    .eq("team_lead_id", params.userId)
    .eq("brokerage_id", params.brokerageId)
    .is("deleted_at", null)

  const teamIds = (teams ?? []).map((t: { id: string }) => t.id)

  // Team membership lives on agents.team_id — the SAME source assignment routing
  // uses (the old users.team_id query returned users.id, which never matched
  // contacts.agent_id (agents.id) → team hot contacts always read 0, and the
  // deal-risk embed joined transactions→users through the wrong FK).
  const teamAgentIds = await getTeamAgentIds(teamIds)
  const teamMemberCount = teamAgentIds.length

  // Deals at risk for the team: transactions.agent_id is agents.id — two clean
  // steps instead of a fragile nested embed.
  let dealsAtRisk: Array<{ transaction_id: string; overall_score: number; risk_level: string; property_address: string | null }> = []
  let teamHotContacts = 0
  let isaHandoffs: Array<{ agent_id: string; claimed: boolean }> = []
  if (teamAgentIds.length > 0) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const [txRes, hotRes, handoffRes] = await Promise.all([
      supabase
        .from("transactions")
        .select("id, property_address")
        .in("agent_id", teamAgentIds)
        .not("stage", "in", '("closed","cancelled")')
        .limit(100),
      supabase
        .from("contacts")
        .select("id", { count: "exact", head: true })
        .in("agent_id", teamAgentIds)
        .eq("status", "hot"),
      // AI ISA manager: overnight qualified handoffs INTO this team (tier-scoped).
      supabase
        .from("assignment_log")
        .select("agent_id, claimed")
        .in("agent_id", teamAgentIds)
        .gte("created_at", since),
    ])
    teamHotContacts = (hotRes as { count: number | null }).count ?? 0
    isaHandoffs = ((handoffRes.data ?? []) as Array<{ agent_id: string; claimed: boolean }>)
    const txRows = (txRes.data ?? []) as Array<{ id: string; property_address: string | null }>
    if (txRows.length > 0) {
      const { data: healthRows } = await supabase
        .from("deal_health_scores")
        .select("transaction_id, overall_score, risk_level")
        .in("transaction_id", txRows.map((t) => t.id))
        .in("risk_level", ["critical", "at_risk"])
        .order("overall_score", { ascending: true })
        .limit(5)
      dealsAtRisk = ((healthRows ?? []) as Array<{ transaction_id: string; overall_score: number; risk_level: string }>)
        .map((h) => ({
          ...h,
          property_address: txRows.find((t) => t.id === h.transaction_id)?.property_address ?? null,
        }))
    }
  }

  const priorities: BriefPriority[] = []

  // AI ISA manager — unclaimed qualified handoffs into the team lead the brief
  // (canonical process: qualification converted them to team members' contacts).
  const unclaimedHandoffs = isaHandoffs.filter((h) => !h.claimed).length
  if (isaHandoffs.length > 0) {
    priorities.push({
      id: "team-isa-handoffs",
      title: `AI ISA handed your team ${isaHandoffs.length} qualified lead${isaHandoffs.length === 1 ? "" : "s"} overnight`,
      body: unclaimedHandoffs > 0
        ? `${unclaimedHandoffs} awaiting first touch — chase speed-to-first-touch this morning`
        : "All claimed — follow up on first-touch quality",
      severity: unclaimedHandoffs > 0 ? "high" : "medium",
      manager: "ai_isa",
      ctas: [{ label: "Open team pipeline", href: "/dashboard/team-lead" }],
    })
  }

  if (dealsAtRisk.length > 0) {
    priorities.push({
      id: `team-deals-risk`,
      title: `${dealsAtRisk.length} team deal${dealsAtRisk.length === 1 ? "" : "s"} at risk`,
      body: `Most critical: ${dealsAtRisk[0].property_address ?? "unknown"} (score ${Math.round(dealsAtRisk[0].overall_score)})`,
      severity: dealsAtRisk[0].risk_level === "critical" ? "critical" : "high",
      manager: "deal_coordinator",
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
    ...(isaHandoffs.length > 0 ? [{ label: "ISA handoffs (24h)", value: isaHandoffs.length }] : []),
  ]

  let summary = "Team running normally — focus on coaching and pipeline review."
  if (priorities.length > 0) {
    try {
      const { text } = await generateTextRouted({
        brokerageId: params.brokerageId,
        userId: params.userId,
        feature: "coaching_insight",
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

  // ai_daily_briefings has no unique constraint on (agent_id, briefing_date) — the
  // previous onConflict upsert errored (42P10) and the team-lead brief NEVER cached
  // (full regeneration + AI spend every view). Select-then-write, keyed on user_id.
  const briefRow = {
    user_id: params.userId,
    brokerage_id: params.brokerageId,
    briefing_date: today,
    summary,
    top_priority_actions: priorities,
    market_pulse: JSON.stringify(metrics),
    ai_model_used: "claude-sonnet-routed",
    generated_at: new Date().toISOString(),
  }
  const { data: existingBrief } = await supabase
    .from("ai_daily_briefings")
    .select("id")
    .eq("user_id", params.userId)
    .eq("briefing_date", today)
    .maybeSingle()
  if (existingBrief?.id) {
    await supabase.from("ai_daily_briefings").update(briefRow).eq("id", existingBrief.id)
  } else {
    await supabase.from("ai_daily_briefings").insert(briefRow)
  }

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
  // agents.team_id is the authoritative membership (same source assignment uses);
  // returns agents.id — the ID space contacts.agent_id / transactions.agent_id key on.
  const { data } = await supabase
    .from("agents").select("id").in("team_id", teamIds).eq("is_active", true)
  return ((data ?? []) as Array<{ id: string }>).map((a) => a.id)
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
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle()
  return !!data
}
