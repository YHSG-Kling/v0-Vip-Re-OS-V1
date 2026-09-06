// lib/gamification/leaderboard-vocabulary.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE LEADERBOARD VOCABULARY — imported by the POPULATOR and by EVERY READER.
//
// The board could never show a row, and not because it was gated: the writer and
// the readers were speaking different languages over the same three columns.
// Measured before this module existed:
//
//   WRITER  lib/recruiting/leaderboard.ts wrote scope 'brokerage', metric 'points',
//           period_label ∈ { ISO week '2026-W33', month '2026-08', 'all_time' }.
//   READERS app/actions/gamification.getLeaderboardWidget, app/actions/agents.getLeaderboard
//           and /dashboard/intelligence all asked for scope 'agent'; the Motivation
//           page asked for period_label 'This Month' / 'This Quarter' / 'This Year'.
//
// Not one of the 36 filter combinations the UI offered could match a written row,
// with or without a full ledger. Three decisions settle it, and they live here so
// there is exactly one place to disagree with:
//
//   SCOPE is the COMPARISON GROUP, not the row grain. Every leaderboard_rankings
//   row is already per-agent (agent_id is NOT NULL), so 'agent' was never a board —
//   it was the grain restated as a filter, and it matched nothing. A viewer compares
//   themselves against their TEAM or against the whole BROKERAGE.
//
//   PERIOD is stored canonically and DISPLAYED in words. 'This Month' is a label a
//   person reads; '2026-08' is the value a row carries. The UI may show the first
//   only if it sends the second.
//
//   METRIC excludes revenue. Nothing has ever written a revenue row, and this is a
//   PEER-VISIBLE board — standing rulings #185 / #57 took commission off agent-facing
//   display. What an agent may see about a colleague is what they DID (points, closed
//   deals, referrals), never what they were paid.
//
// Pure and dependency-free: a client component may import it.

export const LEADERBOARD_SCOPES = ["brokerage", "team"] as const
export type LeaderboardScope = (typeof LEADERBOARD_SCOPES)[number]

export const LEADERBOARD_METRICS = ["points", "transactions", "referrals"] as const
export type LeaderboardMetric = (typeof LEADERBOARD_METRICS)[number]

/** The one period_label that carries no date. */
export const ALL_TIME_PERIOD = "all_time"

export const SCOPE_LABEL: Record<LeaderboardScope, string> = {
  brokerage: "Brokerage",
  team: "My team",
}

export const METRIC_LABEL: Record<LeaderboardMetric, string> = {
  points: "Points",
  transactions: "Closed deals",
  referrals: "Referrals",
}

export function isLeaderboardScope(v: unknown): v is LeaderboardScope {
  return typeof v === "string" && (LEADERBOARD_SCOPES as readonly string[]).includes(v)
}

export function isLeaderboardMetric(v: unknown): v is LeaderboardMetric {
  return typeof v === "string" && (LEADERBOARD_METRICS as readonly string[]).includes(v)
}

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

export interface PeriodWindow {
  /** The value stored in and queried from leaderboard_rankings.period_label. */
  value: string
  /** What a person reads on the filter. */
  label: string
  /** Rows on/after this instant count; null = every row ever. */
  since: Date | null
}

/**
 * PURE: the three windows the populator writes and the UI may offer, in the order
 * they are shown. THE POPULATOR AND THE FILTER READ THE SAME FUNCTION — a period
 * the UI can select but the populator does not write cannot exist, which is the
 * whole class of defect this replaces ("This Quarter" / "This Year" were offered
 * and never written).
 */
export function periodWindows(now: Date = new Date()): PeriodWindow[] {
  return [
    { value: isoWeekLabel(now), label: "This week", since: new Date(now.getTime() - 7 * 86_400_000) },
    { value: monthLabel(now), label: "This month", since: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)) },
    { value: ALL_TIME_PERIOD, label: "All time", since: null },
  ]
}

/** True only for a label the populator actually writes for `now`. */
export function isCanonicalPeriodLabel(v: unknown, now: Date = new Date()): boolean {
  return typeof v === "string" && periodWindows(now).some((w) => w.value === v)
}

/** The period a surface opens on when the caller named none. */
export function defaultPeriodLabel(now: Date = new Date()): string {
  return monthLabel(now)
}

/**
 * ONE ROW SHAPE for every board reader. The Motivation table read `entry.agent_name`
 * and `entry.score`; the Intelligence page dug through `r.agents.users.first_name`;
 * the action returned neither. Flattening happens once, server-side, so a surface
 * cannot render a blank column by reaching for a key the row never had.
 */
export interface LeaderboardRow {
  agentId: string
  agentName: string
  avatarUrl: string | null
  rank: number
  /** The value for the SELECTED metric — points, closed deals, or referrals. */
  score: number
  /** The agent's lifetime points total, independent of the selected metric. */
  lifetimePoints: number
  isCurrentAgent: boolean
}
