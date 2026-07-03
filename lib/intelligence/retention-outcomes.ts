// lib/intelligence/retention-outcomes.ts
//
// RETENTION OUTCOMES — did the save-play WORK? The retention radar proposes a gated save-play when an
// agent crosses into flight risk; outcome-learning already tracks whether the broker approved it, but the
// real question is downstream: after the intervention, did the agent RECOVER (retained) or LEAVE (lost)?
// This closes the retention loop by computing that result from existing data — no new table — so the
// broker sees the AI team's retention win-rate and the radar's interventions become measurably accountable.
// A retained agent's score climbs back out of at-risk while they stay active; a lost agent deactivates.

import { createServiceClient } from "@/lib/supabase/service"
import { AT_RISK_THRESHOLD } from "@/lib/recruiting/retention-score"

type Svc = ReturnType<typeof createServiceClient>

export type RetentionOutcome = "retained" | "lost" | "pending"

/** Days after a save-play before an unresolved (still at-risk, still active) case counts as pending→ aging. */
export const OUTCOME_SETTLE_DAYS = 30

export interface OutcomeInput {
  savePlayDate: string
  /** The agent's score rows AFTER the save-play (any order); each { score_date, composite_score }. */
  scoresAfter: Array<{ score_date: string; composite_score: number }>
  isActive: boolean
  now: Date
}

/**
 * PURE: classify one save-play's outcome. LOST if the agent has since deactivated. RETAINED if, after the
 * save-play, their score climbed back to/above the at-risk threshold while they stayed active. Otherwise
 * PENDING (still working — the intervention hasn't resolved yet). Honest: no fabricated wins.
 */
export function classifyRetentionOutcome(input: OutcomeInput): RetentionOutcome {
  if (!input.isActive) return "lost"
  const after = input.scoresAfter.filter((s) => s.score_date >= input.savePlayDate.slice(0, 10))
  const recovered = after.some((s) => s.composite_score >= AT_RISK_THRESHOLD)
  if (recovered) return "retained"
  return "pending"
}

export interface RetentionOutcomeBoard {
  total: number
  retained: number
  lost: number
  pending: number
  /** retained / (retained + lost) — the settled win rate; null until at least one case settles. */
  winRate: number | null
}

/** PURE: roll classified outcomes into the effectiveness board. */
export function summarizeRetentionOutcomes(outcomes: RetentionOutcome[]): RetentionOutcomeBoard {
  const retained = outcomes.filter((o) => o === "retained").length
  const lost = outcomes.filter((o) => o === "lost").length
  const pending = outcomes.filter((o) => o === "pending").length
  const settled = retained + lost
  return { total: outcomes.length, retained, lost, pending, winRate: settled === 0 ? null : Math.round((retained / settled) * 100) / 100 }
}

/** Build the retention-effectiveness board for a brokerage from real save-plays. Best-effort → null. */
export async function generateRetentionOutcomeBoard(brokerageId: string, client?: Svc): Promise<RetentionOutcomeBoard | null> {
  const supabase = client ?? createServiceClient()
  try {
    const now = new Date()
    // Every retention save-play the radar proposed (entity_type agent; rationale carries the dedupe tag).
    const { data: plays } = await supabase.from("agent_client_messages")
      .select("entity_id, created_at")
      .eq("brokerage_id", brokerageId).eq("agent_kind", "recruiting_manager").eq("entity_type", "agent")
      .ilike("rationale", "RETENTION SAVE-PLAY%").order("created_at", { ascending: true }).limit(2000)
    const rows = (plays ?? []) as Array<{ entity_id: string; created_at: string }>
    if (rows.length === 0) return { total: 0, retained: 0, lost: 0, pending: 0, winRate: null }

    // First save-play per agent (the intervention that started the clock).
    const firstPlay = new Map<string, string>()
    for (const r of rows) if (!firstPlay.has(r.entity_id)) firstPlay.set(r.entity_id, r.created_at)

    const agentIds = Array.from(firstPlay.keys())
    const [{ data: agents }, { data: scores }] = await Promise.all([
      supabase.from("agents").select("id, is_active").in("id", agentIds),
      supabase.from("agent_retention_scores").select("agent_id, score_date, composite_score").in("agent_id", agentIds).limit(20000),
    ])
    const activeById = new Map(((agents ?? []) as any[]).map((a) => [a.id, a.is_active !== false]))
    const scoresById = new Map<string, Array<{ score_date: string; composite_score: number }>>()
    for (const s of (scores ?? []) as any[]) {
      const arr = scoresById.get(s.agent_id) ?? []
      arr.push({ score_date: s.score_date, composite_score: s.composite_score }); scoresById.set(s.agent_id, arr)
    }

    const outcomes: RetentionOutcome[] = agentIds.map((id) => classifyRetentionOutcome({
      savePlayDate: firstPlay.get(id)!,
      scoresAfter: scoresById.get(id) ?? [],
      isActive: activeById.get(id) ?? true,
      now,
    }))
    return summarizeRetentionOutcomes(outcomes)
  } catch (err) {
    console.error("[retention-outcomes] failed:", err)
    return null
  }
}
