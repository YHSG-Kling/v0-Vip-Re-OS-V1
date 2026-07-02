// lib/intelligence/retention-board.ts
//
// THE RETENTION BOARD — the Recruiting Manager's flight-risk view made visible in the one Command
// Center. The retention radar writes a daily agent_retention_scores row per agent (engagement → a 0-100
// score + tier + trend + driving signals); the save-play surfaces as a gated proposal, but the BOARD —
// who's trending down, how many are at-risk, why — had no operator surface. This reads the latest score
// per agent and rolls it into a worst-first board so a broker sees churn risk at a glance, next to the
// standup and P&L. Read-only; best-effort; no model narration in the numbers.

import { createServiceClient } from "@/lib/supabase/service"

export interface RetentionBoardAgent {
  agentId: string
  name: string
  score: number
  tier: string
  /** improving | declining | stable (from the radar), or null when there's no prior score. */
  trend: string | null
  /** The real signals driving the score (recency, drought, empty pipeline, stalled ramp). */
  drivers: string[]
}

export interface RetentionBoard {
  scored: number
  atRisk: number
  watch: number
  healthy: number
  /** The date of the most recent scores in view (YYYY-MM-DD), or null when empty. */
  asOf: string | null
  /** Worst-first (critical/at_risk first, then by score asc), capped for the card. */
  agents: RetentionBoardAgent[]
}

interface RawScore {
  agent_id: string
  score_date: string
  composite_score: number
  tier: string
  score_trend: string | null
  driving_signals: string[] | null
}

const TIER_RANK: Record<string, number> = { critical: 0, at_risk: 1, watch: 2, healthy: 3, engaged: 4 }

/**
 * PURE: fold the latest-per-agent score rows + a name map into the board. Keeps only the most recent
 * score_date per agent (rows are pre-sorted score_date desc), summarizes tier counts, and returns the
 * riskiest agents first. `cap` bounds how many agents the card shows.
 */
export function summarizeRetentionBoard(
  rows: RawScore[], names: Map<string, string>, cap = 8,
): RetentionBoard {
  const latest = new Map<string, RawScore>()
  for (const r of rows) if (!latest.has(r.agent_id)) latest.set(r.agent_id, r) // first seen = latest (desc order)

  let atRisk = 0, watch = 0, healthy = 0
  let asOf: string | null = null
  const agents: RetentionBoardAgent[] = []
  for (const r of latest.values()) {
    if (!asOf || r.score_date > asOf) asOf = r.score_date
    if (r.tier === "at_risk" || r.tier === "critical") atRisk++
    else if (r.tier === "watch") watch++
    else healthy++
    agents.push({
      agentId: r.agent_id,
      name: names.get(r.agent_id) || "An agent",
      score: r.composite_score,
      tier: r.tier,
      trend: r.score_trend ?? null,
      drivers: Array.isArray(r.driving_signals) ? r.driving_signals : [],
    })
  }

  agents.sort((a, b) => (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) || a.score - b.score || a.name.localeCompare(b.name))

  return { scored: latest.size, atRisk, watch, healthy, asOf, agents: agents.slice(0, cap) }
}

/** Read the latest retention scores for a brokerage and build the board. Best-effort → null on failure. */
export async function generateRetentionBoard(
  brokerageId: string, client?: ReturnType<typeof createServiceClient>,
): Promise<RetentionBoard | null> {
  const supabase = client ?? createServiceClient()
  try {
    // Recent scores, newest first — the pure summarizer keeps the latest per agent. Bounded window so a
    // large brokerage doesn't scan the whole history (30 days covers the daily-scored active roster).
    const since = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10)
    const { data: scores } = await supabase
      .from("agent_retention_scores")
      .select("agent_id, score_date, composite_score, tier, score_trend, driving_signals")
      .eq("brokerage_id", brokerageId).gte("score_date", since)
      .order("score_date", { ascending: false }).limit(2000)
    const rows = (scores ?? []) as RawScore[]
    if (rows.length === 0) return { scored: 0, atRisk: 0, watch: 0, healthy: 0, asOf: null, agents: [] }

    // Names via agents → users embed (agents carries no name; it lives on users).
    const agentIds = Array.from(new Set(rows.map((r) => r.agent_id)))
    const names = new Map<string, string>()
    const { data: agentRows } = await supabase
      .from("agents").select("id, users(first_name, last_name)").in("id", agentIds)
    for (const a of (agentRows ?? []) as any[]) {
      const u = Array.isArray(a.users) ? a.users[0] : a.users
      const nm = [u?.first_name, u?.last_name].filter(Boolean).join(" ").trim()
      if (nm) names.set(a.id, nm)
    }

    return summarizeRetentionBoard(rows, names)
  } catch (err) {
    console.error("[retention-board] failed:", err)
    return null
  }
}
