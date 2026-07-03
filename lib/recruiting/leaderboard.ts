// lib/recruiting/leaderboard.ts
//
// LEADERBOARD POPULATOR (recruiting_manager) — the leaderboard UI existed but NOTHING populated it (a real
// drift: read with no writer). This snapshots weekly / monthly / all-time point rankings into
// leaderboard_rankings from the single canonical ledger (agent_points_log — now written by BOTH award
// paths), so the leaderboard renders real, current standings. Pure ranking + period labels are testable.

import type { createServiceClient } from "@/lib/supabase/service"
type Svc = ReturnType<typeof createServiceClient>

/** PURE: ISO-week label like "2026-W27". */
export function isoWeekLabel(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
  const day = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - day)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7)
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`
}

/** PURE: month label like "2026-07". */
export function monthLabel(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
}

export interface LedgerRow { agent_id: string; points: number | null; created_at: string }
export interface Ranking { agent_id: string; metric_value: number; rank_position: number }

/**
 * PURE: sum points per agent over rows created on/after `since` (null = all time) and rank them descending.
 * Ties break by agent_id for determinism. Zero-point agents are excluded (nothing to rank).
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

export interface LeaderboardResult { periods: number; rows: number }

/**
 * Snapshot a brokerage's point leaderboards (weekly / monthly / all-time) into leaderboard_rankings from the
 * ledger. Replaces the current period's rows (delete-then-insert) so the board is always current. Best-effort.
 */
export async function runLeaderboardSnapshot(svc: Svc, params: { brokerageId: string; now?: Date }): Promise<LeaderboardResult> {
  const out: LeaderboardResult = { periods: 0, rows: 0 }
  const now = params.now ?? new Date()
  const { data } = await svc.from("agent_points_log").select("agent_id, points, created_at").eq("brokerage_id", params.brokerageId).limit(50000)
  const rows = (data ?? []) as LedgerRow[]
  if (rows.length === 0) return out

  const weekStart = new Date(now.getTime() - 7 * 86_400_000)
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
  const windows: Array<{ label: string; since: Date | null }> = [
    { label: isoWeekLabel(now), since: weekStart },
    { label: monthLabel(now), since: monthStart },
    { label: "all_time", since: null },
  ]

  for (const w of windows) {
    const ranked = rankPoints(rows, w.since).slice(0, 100)
    if (ranked.length === 0) continue
    // Replace this period's brokerage-scope points rows.
    await svc.from("leaderboard_rankings").delete()
      .eq("brokerage_id", params.brokerageId).eq("scope", "brokerage").eq("metric_type", "points").eq("period_label", w.label)
    await svc.from("leaderboard_rankings").insert(ranked.map((r) => ({
      brokerage_id: params.brokerageId, team_id: null, agent_id: r.agent_id,
      scope: "brokerage", period_label: w.label, metric_type: "points",
      rank_position: r.rank_position, metric_value: r.metric_value, computed_at: now.toISOString(),
    })))
    out.periods += 1; out.rows += ranked.length
  }
  return out
}

/** Autonomous: snapshot every brokerage's leaderboards (rides the weekly recruit-outreach cron). */
export async function runLeaderboardSnapshotAll(svc: Svc, now?: Date): Promise<{ brokerages: number; rows: number }> {
  const out = { brokerages: 0, rows: 0 }
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try { const r = await runLeaderboardSnapshot(svc, { brokerageId: b.id, now }); out.rows += r.rows } catch { /* keep going */ }
  }
  return out
}
