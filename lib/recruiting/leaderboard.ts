// lib/recruiting/leaderboard.ts
//
// LEADERBOARD POPULATOR (recruiting_manager) — the only writer of leaderboard_rankings.
//
// It used to write ONE cell of the board: scope 'brokerage', metric 'points'. The UI offered
// three scopes × four metrics × three periods and every one of those 36 combinations queried a
// row shape nothing had ever written, so the board rendered "No leaderboard data available for
// the selected filters" with a full ledger behind it. The vocabulary is now shared with every
// reader (lib/gamification/leaderboard-vocabulary.ts) and this file writes EVERY cell that
// vocabulary admits:
//
//   scope   brokerage (the whole tenant) and team (ruling #191 — a team sees its own board),
//           the two real comparison groups. `agent` is gone: every row is already per-agent,
//           so it was the grain restated as a filter and it matched nothing.
//   metric  points (the ledger), transactions (deals actually closed) and referrals (referrals
//           the agent sent). NOT revenue — nothing wrote it, and a peer-visible board does not
//           carry money (#185, #57).
//   period  ISO week / month / all_time, from the same periodWindows() the filter renders.
//
// Every metric is built from real rows: agent_points_log, transactions in a closed state, and
// referrals credited to their referring agent. Nothing here is synthesised.

import type { createServiceClient } from "@/lib/supabase/service"
import {
  LEADERBOARD_METRICS,
  periodWindows,
  isoWeekLabel,
  monthLabel,
  ALL_TIME_PERIOD,
  type LeaderboardMetric,
} from "@/lib/gamification/leaderboard-vocabulary"
import { TRANSACTION_STATUSES, type TransactionStatus } from "@/lib/transactions/transaction-status"

type Svc = ReturnType<typeof createServiceClient>

// Re-exported: the period vocabulary is shared, and callers of this module (the cron, the
// simulator) have always reached for the labels here.
export { isoWeekLabel, monthLabel, ALL_TIME_PERIOD }

/**
 * A deal in one of these states has closed — `closed` is recorded, `funded` is disbursed. Typed
 * against the ONE transactions.status vocabulary so a renamed state fails the build here rather
 * than silently emptying the board.
 */
const CLOSED_TRANSACTION_STATUSES: readonly TransactionStatus[] = ["closed", "funded"]

export interface LedgerRow { agent_id: string; points: number | null; created_at: string }
export interface Ranking { agent_id: string; metric_value: number; rank_position: number }

/**
 * PURE: sum points per agent over rows created on/after `since` (null = all time) and rank them
 * descending. Ties break by agent_id for determinism. Zero-value agents are excluded (nothing to
 * rank). Used for all three metrics — a closed deal and a referral each arrive as one row worth 1.
 */
export function rankPoints(rows: LedgerRow[], since: Date | null): Ranking[] {
  const totals = new Map<string, number>()
  for (const r of rows) {
    if (since && Date.parse(r.created_at) < since.getTime()) continue
    totals.set(r.agent_id, (totals.get(r.agent_id) ?? 0) + (Number(r.points) || 0))
  }
  return Array.from(totals.entries())
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([agent_id, metric_value], i) => ({ agent_id, metric_value, rank_position: i + 1 }))
}

/**
 * PURE: split rows by the team each agent belongs to. Agents with no team produce no team board —
 * a one-person "team" of the unassigned is not a comparison group, it is a rendering accident.
 */
export function partitionByTeam(
  rows: LedgerRow[],
  teamByAgent: Map<string, string | null>,
): Map<string, LedgerRow[]> {
  const out = new Map<string, LedgerRow[]>()
  for (const r of rows) {
    const teamId = teamByAgent.get(r.agent_id) ?? null
    if (!teamId) continue
    const bucket = out.get(teamId)
    if (bucket) bucket.push(r)
    else out.set(teamId, [r])
  }
  return out
}

export interface LeaderboardResult {
  /** Distinct (scope, metric, period) boards written. */
  periods: number
  rows: number
}

interface MetricRows { metric: LeaderboardMetric; rows: LedgerRow[] }

/** Gather every metric's raw events for one brokerage. A refused read yields no rows for that metric. */
async function gatherMetrics(svc: Svc, brokerageId: string): Promise<MetricRows[]> {
  const [pointsRes, txRes, refRes] = await Promise.all([
    svc.from("agent_points_log").select("agent_id, points, created_at").eq("brokerage_id", brokerageId).limit(50000),
    svc.from("transactions").select("agent_id, close_date, created_at").eq("brokerage_id", brokerageId)
      .in("status", [...CLOSED_TRANSACTION_STATUSES]).limit(50000),
    svc.from("referrals").select("referring_agent_id, created_at").eq("brokerage_id", brokerageId)
      .not("referring_agent_id", "is", null).limit(50000),
  ])

  if (pointsRes.error) console.error(`[leaderboard] agent_points_log read refused for ${brokerageId}: ${pointsRes.error.message}`)
  if (txRes.error) console.error(`[leaderboard] closed-transaction read refused for ${brokerageId}: ${txRes.error.message}`)
  if (refRes.error) console.error(`[leaderboard] referrals read refused for ${brokerageId}: ${refRes.error.message}`)

  const points = ((pointsRes.data ?? []) as LedgerRow[]).filter((r) => r.agent_id)

  // A closed deal counts on the day it CLOSED, not the day the record was created — the windows
  // are "deals you closed this month", and close_date is the fact that answers that.
  const transactions = ((txRes.data ?? []) as Array<{ agent_id: string | null; close_date: string | null; created_at: string | null }>)
    .filter((r) => r.agent_id && (r.close_date || r.created_at))
    .map((r) => ({ agent_id: r.agent_id as string, points: 1, created_at: (r.close_date ? `${r.close_date}T00:00:00Z` : r.created_at) as string }))

  const referrals = ((refRes.data ?? []) as Array<{ referring_agent_id: string | null; created_at: string | null }>)
    .filter((r) => r.referring_agent_id && r.created_at)
    .map((r) => ({ agent_id: r.referring_agent_id as string, points: 1, created_at: r.created_at as string }))

  return [
    { metric: "points", rows: points },
    { metric: "transactions", rows: transactions },
    { metric: "referrals", rows: referrals },
  ]
}

/**
 * Snapshot a brokerage's boards into leaderboard_rankings: every scope × metric × period the
 * shared vocabulary admits. Replaces each board (delete-then-insert) so standings are current.
 */
export async function runLeaderboardSnapshot(
  svc: Svc,
  params: { brokerageId: string; now?: Date },
): Promise<LeaderboardResult> {
  const out: LeaderboardResult = { periods: 0, rows: 0 }
  const now = params.now ?? new Date()

  // The team map is what makes a team board possible at all — leaderboard_rankings.team_id has
  // existed since the table did and was written NULL on every row ever inserted.
  const { data: agentRows, error: agentErr } = await svc
    .from("agents").select("id, team_id").eq("brokerage_id", params.brokerageId).limit(5000)
  if (agentErr) {
    console.error(`[leaderboard] agent roster read refused for ${params.brokerageId}: ${agentErr.message}`)
    return out
  }
  const teamByAgent = new Map<string, string | null>(
    ((agentRows ?? []) as Array<{ id: string; team_id: string | null }>).map((a) => [a.id, a.team_id ?? null]),
  )

  const metrics = await gatherMetrics(svc, params.brokerageId)
  const windows = periodWindows(now)
  const computedAt = now.toISOString()

  for (const { metric, rows } of metrics) {
    if (rows.length === 0) continue
    const byTeam = partitionByTeam(rows, teamByAgent)

    for (const w of windows) {
      // ── BROKERAGE BOARD ────────────────────────────────────────────────────
      const brokerageRanked = rankPoints(rows, w.since).slice(0, 100)
      const { error: delBrokerageErr } = await svc.from("leaderboard_rankings").delete()
        .eq("brokerage_id", params.brokerageId).eq("scope", "brokerage")
        .eq("metric_type", metric).eq("period_label", w.value)
      if (delBrokerageErr) {
        console.error(`[leaderboard] could not clear the brokerage ${metric}/${w.value} board: ${delBrokerageErr.message}`)
      } else if (brokerageRanked.length > 0) {
        const { error: insErr } = await svc.from("leaderboard_rankings").insert(brokerageRanked.map((r) => ({
          brokerage_id: params.brokerageId, team_id: null, agent_id: r.agent_id,
          scope: "brokerage", period_label: w.value, metric_type: metric,
          rank_position: r.rank_position, metric_value: r.metric_value, computed_at: computedAt,
        })))
        if (insErr) {
          console.error(`[leaderboard] could not write the brokerage ${metric}/${w.value} board: ${insErr.message}`)
        } else {
          out.periods += 1
          out.rows += brokerageRanked.length
        }
      }

      // ── TEAM BOARDS ────────────────────────────────────────────────────────
      // One delete for the whole scope/metric/period, then every team's rows at once: a team
      // whose members all dropped to zero this window must lose its rows, not keep stale ones.
      const { error: delTeamErr } = await svc.from("leaderboard_rankings").delete()
        .eq("brokerage_id", params.brokerageId).eq("scope", "team")
        .eq("metric_type", metric).eq("period_label", w.value)
      if (delTeamErr) {
        console.error(`[leaderboard] could not clear the team ${metric}/${w.value} boards: ${delTeamErr.message}`)
        continue
      }
      const teamPayload: Array<Record<string, unknown>> = []
      for (const [teamId, teamRows] of byTeam) {
        for (const r of rankPoints(teamRows, w.since).slice(0, 100)) {
          teamPayload.push({
            brokerage_id: params.brokerageId, team_id: teamId, agent_id: r.agent_id,
            scope: "team", period_label: w.value, metric_type: metric,
            rank_position: r.rank_position, metric_value: r.metric_value, computed_at: computedAt,
          })
        }
      }
      if (teamPayload.length > 0) {
        const { error: insTeamErr } = await svc.from("leaderboard_rankings").insert(teamPayload)
        if (insTeamErr) {
          console.error(`[leaderboard] could not write the team ${metric}/${w.value} boards: ${insTeamErr.message}`)
        } else {
          out.periods += 1
          out.rows += teamPayload.length
        }
      }
    }
  }
  return out
}

/** Autonomous: snapshot every brokerage's boards (rides the weekly recruit-outreach cron). */
export async function runLeaderboardSnapshotAll(svc: Svc, now?: Date): Promise<{ brokerages: number; rows: number }> {
  const out = { brokerages: 0, rows: 0 }
  const { data: rows, error } = await svc.from("brokerages").select("id").limit(1000)
  if (error) {
    console.error(`[leaderboard] brokerage list read refused: ${error.message}`)
    return out
  }
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try { const r = await runLeaderboardSnapshot(svc, { brokerageId: b.id, now }); out.rows += r.rows } catch { /* keep going */ }
  }
  return out
}

/** Every metric this populator writes — so a reader never offers a filter nothing fills. */
export const POPULATED_METRICS: readonly LeaderboardMetric[] = LEADERBOARD_METRICS

/** Guard for the closed-state list above: every value must still be in the live status vocabulary. */
export const CLOSED_STATES_ARE_REAL = CLOSED_TRANSACTION_STATUSES.every((s) =>
  (TRANSACTION_STATUSES as readonly string[]).includes(s),
)
