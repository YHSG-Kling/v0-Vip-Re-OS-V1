// lib/gamification/strain.ts
// ─────────────────────────────────────────────────────────────────────────────
// FATIGUE-AWARE INCENTIVES (wave 103, lane 103C).
//
// Owner (wave 89): "brokerages need agent fatigue signals so they can give the
// support that they are lacking before they decide to leave." A points ladder
// that keeps nudging an agent who is already over capacity is the opposite of
// support. This module READS the agent-scope fatigue the OS already computes —
// the retention radar's stored agent_retention_scores row (lib/recruiting/
// retention-radar.ts → retention-score.ts agentFatigueSubScores, which itself
// folds lib/fatigue's per-agent fatigued-book signal, buyer_fatigue_scores.agent_id)
// — and never re-derives it (LAW 2: one calculator). What it decides is only
// WHETHER TO APPLY PRESSURE: the career-tier approach nudge and the "N pts to go"
// line on the Motivation rail stand down for a strained agent. Standings on the
// board stay exactly what they are — a leaderboard that hides a rank is a lie, a
// nudge that pushes a tired agent is a harm.

import {
  isAtRisk,
  weakFatigueSignals,
  SUPPORT_NUDGE_MIN_SIGNALS,
} from "@/lib/recruiting/retention-score"

/** The slice of an agent_retention_scores row this reads. */
export interface StrainRow {
  agent_id: string
  composite_score: number | null
  signal_breakdown: Record<string, number> | null
  score_date?: string | null
}

/**
 * PURE: the agent is under strain when the radar scored them at-risk (watch tier
 * and below, the same cut the broker save play uses) OR when at least
 * SUPPORT_NUDGE_MIN_SIGNALS fatigue signals are lit — the exact threshold at
 * which the radar already tells the broker to have a support conversation.
 * @proofSeam PURE — the proof asserts both cuts with positive controls.
 */
export function isUnderStrain(row: Pick<StrainRow, "composite_score" | "signal_breakdown">): boolean {
  const score = Number(row.composite_score)
  if (Number.isFinite(score) && isAtRisk(score)) return true
  return weakFatigueSignals(row.signal_breakdown).length >= SUPPORT_NUDGE_MIN_SIGNALS
}

/** PURE: latest row per agent wins (rows arrive newest-first).
 *  @proofSeam the proof asserts newest-wins directly */
export function strainedFromRows(rows: StrainRow[]): Set<string> {
  const seen = new Set<string>()
  const strained = new Set<string>()
  for (const r of rows) {
    if (!r.agent_id || seen.has(r.agent_id)) continue
    seen.add(r.agent_id)
    if (isUnderStrain(r)) strained.add(r.agent_id)
  }
  return strained
}

interface ReadCapableClient { from: (table: string) => any }

/**
 * The agents.id set of a brokerage currently under strain — read from the radar's
 * stored scores, newest row per agent. A refused read returns an EMPTY set and
 * says so: nobody is held back on a read that did not happen, but nobody is
 * nudged into harm either — the caller logs and proceeds.
 */
export async function strainedAgentIds(db: ReadCapableClient, brokerageId: string): Promise<Set<string>> {
  const { data, error } = await db
    .from("agent_retention_scores")
    .select("agent_id, composite_score, signal_breakdown, score_date")
    .eq("brokerage_id", brokerageId)
    .order("score_date", { ascending: false })
    .limit(5000)
  if (error) {
    console.error(`[strain] agent_retention_scores read refused for ${brokerageId}: ${error.message}`)
    return new Set()
  }
  return strainedFromRows((data ?? []) as StrainRow[])
}

/** One agent's current strain flag (the Motivation rail's read). Null = unknown (refused read). */
export async function isAgentUnderStrain(db: ReadCapableClient, agentId: string): Promise<boolean | null> {
  const { data, error } = await db
    .from("agent_retention_scores")
    .select("agent_id, composite_score, signal_breakdown, score_date")
    .eq("agent_id", agentId)
    .order("score_date", { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    console.error(`[strain] agent_retention_scores read refused for agent ${agentId}: ${error.message}`)
    return null
  }
  return data ? isUnderStrain(data as StrainRow) : false
}
