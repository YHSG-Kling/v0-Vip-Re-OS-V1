// lib/intelligence/agent-scorecard.ts
//
// AGENT SCORECARD — the agent-management capstone, owned jointly by the Deal Coordinator
// (production + deal health) and the Recruiting Manager (recruiting-source ROI). One row
// per agent that ties together the signals a broker actually manages on:
//   · production   — YTD closed GCI + closings (transactions, m214)
//   · deal health  — active deals + avg health_score (the Deal Coordinator's signal)
//   · education    — assigned vs completed lessons (learning_assignments by agent_user_id)
//   · recruiting   — if the agent was recruited, their ROI (recruiting_roi)
// Pure aggregation over real columns — no model narration; feeds off the Owner's Report.

import { createServiceClient } from "@/lib/supabase/service"

export interface AgentScorecard {
  agentId: string
  name: string
  /** Production. */
  ytdGci: number
  closings: number
  /** Deal health. */
  activeDeals: number
  avgHealthScore: number | null
  /** Education. */
  lessonsAssigned: number
  lessonsCompleted: number
  educationCompletionPct: number | null
  /** Recruiting source (null when the agent wasn't recruited through the pipeline). */
  recruitingRoiPct: number | null
  recruitingLifetimeNet: number | null
}

/** Pure: completion % (null when nothing assigned). */
export function completionPct(assigned: number, completed: number): number | null {
  if (assigned <= 0) return null
  return Math.round((completed / assigned) * 100)
}

/** Pure: average of a numeric list (null when empty). */
export function avgOrNull(values: number[]): number | null {
  if (values.length === 0) return null
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length)
}

export interface AgentScorecardParams {
  brokerageId: string
  /** Production window on close_date. Defaults to year-to-date. */
  sinceIso?: string
}

export async function generateAgentScorecards(
  params: AgentScorecardParams,
  client?: ReturnType<typeof createServiceClient>,
): Promise<AgentScorecard[]> {
  const supabase = client ?? createServiceClient()
  const since = (params.sinceIso ?? new Date(new Date().getFullYear(), 0, 1).toISOString()).slice(0, 10)

  // Roster.
  const { data: agentRows } = await supabase
    .from("agents").select("id, user_id").eq("brokerage_id", params.brokerageId).limit(2000)
  const agents = (agentRows ?? []) as Array<{ id: string; user_id: string | null }>
  if (agents.length === 0) return []
  const agentIds = agents.map((a) => a.id)
  const userIds = agents.map((a) => a.user_id).filter(Boolean) as string[]

  // Names.
  const nameByUser = new Map<string, string>()
  if (userIds.length > 0) {
    const { data: users } = await supabase.from("users").select("id, first_name, last_name").in("id", userIds)
    for (const u of (users ?? []) as Array<{ id: string; first_name: string | null; last_name: string | null }>) {
      nameByUser.set(u.id, [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || "Agent")
    }
  }

  // Production (closed) + deal health (active) — one transactions pull.
  const { data: txns } = await supabase
    .from("transactions")
    .select("agent_id, status, commission_amount, close_date, health_score")
    .eq("brokerage_id", params.brokerageId)
    .in("agent_id", agentIds)
    .limit(10000)
  const prod = new Map<string, { gci: number; closings: number }>()
  const health = new Map<string, number[]>()
  for (const t of (txns ?? []) as Array<{ agent_id: string | null; status: string | null; commission_amount: number | null; close_date: string | null; health_score: number | null }>) {
    if (!t.agent_id) continue
    if (t.status === "closed" && t.close_date && t.close_date >= since) {
      const p = prod.get(t.agent_id) ?? { gci: 0, closings: 0 }
      p.gci += Number(t.commission_amount ?? 0); p.closings += 1
      prod.set(t.agent_id, p)
    }
    if (t.status && ["active", "under_contract", "closing"].includes(t.status) && t.health_score != null) {
      const h = health.get(t.agent_id) ?? []
      h.push(Number(t.health_score)); health.set(t.agent_id, h)
    }
  }

  // Education (by agent_user_id).
  const eduByUser = new Map<string, { assigned: number; completed: number }>()
  if (userIds.length > 0) {
    const { data: la } = await supabase
      .from("learning_assignments")
      .select("agent_user_id, status")
      .eq("brokerage_id", params.brokerageId)
      .in("agent_user_id", userIds)
      .limit(20000)
    for (const a of (la ?? []) as Array<{ agent_user_id: string | null; status: string | null }>) {
      if (!a.agent_user_id) continue
      const e = eduByUser.get(a.agent_user_id) ?? { assigned: 0, completed: 0 }
      e.assigned += 1
      if (a.status === "completed") e.completed += 1
      eduByUser.set(a.agent_user_id, e)
    }
  }

  // Recruiting ROI (recruited_agent_id = agents.id).
  const roiByAgent = new Map<string, { roiPct: number | null; net: number | null }>()
  const { data: roi } = await supabase
    .from("recruiting_roi")
    .select("recruited_agent_id, roi_pct, lifetime_brokerage_net")
    .eq("brokerage_id", params.brokerageId)
    .in("recruited_agent_id", agentIds)
  for (const r of (roi ?? []) as Array<{ recruited_agent_id: string; roi_pct: number | null; lifetime_brokerage_net: number | null }>) {
    roiByAgent.set(r.recruited_agent_id, { roiPct: r.roi_pct != null ? Number(r.roi_pct) : null, net: r.lifetime_brokerage_net != null ? Number(r.lifetime_brokerage_net) : null })
  }

  const cards: AgentScorecard[] = agents.map((a) => {
    const p = prod.get(a.id) ?? { gci: 0, closings: 0 }
    const edu = (a.user_id && eduByUser.get(a.user_id)) || { assigned: 0, completed: 0 }
    const rr = roiByAgent.get(a.id) ?? { roiPct: null, net: null }
    return {
      agentId: a.id,
      name: (a.user_id && nameByUser.get(a.user_id)) || "Agent",
      ytdGci: p.gci,
      closings: p.closings,
      activeDeals: (health.get(a.id) ?? []).length,
      avgHealthScore: avgOrNull(health.get(a.id) ?? []),
      lessonsAssigned: edu.assigned,
      lessonsCompleted: edu.completed,
      educationCompletionPct: completionPct(edu.assigned, edu.completed),
      recruitingRoiPct: rr.roiPct,
      recruitingLifetimeNet: rr.net,
    }
  })

  // Most productive first; agents with no signal at all sink to the bottom.
  return cards.sort((a, b) => b.ytdGci - a.ytdGci || b.closings - a.closings)
}
