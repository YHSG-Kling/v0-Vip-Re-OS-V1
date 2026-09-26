// lib/platform/manager-ops.ts
// ─────────────────────────────────────────────────────────────────────────────
// PER-MANAGER COST + LATENCY + SLO — the operability surface an autonomous AI OS needs.
// ai_tool_usage carries cost_cents, execution_time_ms, success + (m270) the manager
// dimension; this rolls it up per AI manager (agent_kind) cross-tenant and classifies each
// against an SLO so runaway spend / latency / error-rate on any one manager surfaces before
// it becomes a bill or an outage. Pure classifiers (testable); loader aggregates; console consumes.

import { createServiceClient } from "@/lib/supabase/service"

/** SLO thresholds per manager over the window (defaults; a platform_settings override can follow). */
export const MANAGER_SLO = {
  costCentsWarn: 500, costCentsBreach: 2000,     // $5 / $20 in the window
  p95WarnMs: 15_000, p95BreachMs: 30_000,        // 15s / 30s p95
  errorRateWarn: 0.10, errorRateBreach: 0.25,    // 10% / 25% failed calls
} as const

export type SloStatus = "ok" | "warn" | "breach"

/** PURE: the p-th percentile of an unsorted numeric sample (nearest-rank). 0 for empty. */
export function percentile(values: number[], p: number): number {
  const xs = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (xs.length === 0) return 0
  const idx = Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1))
  return xs[idx]
}

/** PURE: worst-of the three SLO dimensions for a manager. */
export function classifyManagerSlo(
  m: { costCents: number; p95Ms: number; errorRate: number },
  slo = MANAGER_SLO,
): SloStatus {
  const dims: SloStatus[] = [
    m.costCents >= slo.costCentsBreach ? "breach" : m.costCents >= slo.costCentsWarn ? "warn" : "ok",
    m.p95Ms >= slo.p95BreachMs ? "breach" : m.p95Ms >= slo.p95WarnMs ? "warn" : "ok",
    m.errorRate >= slo.errorRateBreach ? "breach" : m.errorRate >= slo.errorRateWarn ? "warn" : "ok",
  ]
  if (dims.includes("breach")) return "breach"
  if (dims.includes("warn")) return "warn"
  return "ok"
}

export interface ManagerOpsRow {
  manager: string
  calls: number
  costCents: number
  tokens: number
  avgMs: number
  p95Ms: number
  errorRate: number
  slo: SloStatus
}

export interface ManagerOps {
  windowHours: number
  managers: ManagerOpsRow[]
  summary: { totalCostCents: number; totalCalls: number; breaching: number; warning: number }
}

type Svc = ReturnType<typeof createServiceClient>

/** Cross-tenant per-manager cost/latency/error rollup over a window. Unattributed rows roll up
 *  under 'unassigned' (honest — instrumentation grows). */
export async function loadManagerOps(client?: Svc, windowHours = 24): Promise<ManagerOps> {
  const svc = client ?? createServiceClient()
  const since = new Date(Date.now() - windowHours * 3_600_000).toISOString()

  const { data } = await svc
    .from("ai_tool_usage")
    .select("manager, cost_cents, tokens_used, execution_time_ms, success")
    .gte("created_at", since)
    .eq("tool_name", "ai_model")
    .limit(50_000)

  const byManager = new Map<string, { calls: number; cost: number; tokens: number; durations: number[]; errors: number }>()
  for (const r of (data ?? []) as any[]) {
    const key = (r.manager as string | null) ?? "unassigned"
    const agg = byManager.get(key) ?? { calls: 0, cost: 0, tokens: 0, durations: [], errors: 0 }
    agg.calls += 1
    agg.cost += Number(r.cost_cents ?? 0)
    agg.tokens += Number(r.tokens_used ?? 0)
    if (Number.isFinite(r.execution_time_ms)) agg.durations.push(Number(r.execution_time_ms))
    if (r.success === false) agg.errors += 1
    byManager.set(key, agg)
  }

  const managers: ManagerOpsRow[] = [...byManager.entries()].map(([manager, a]) => {
    const avgMs = a.durations.length ? Math.round(a.durations.reduce((s, v) => s + v, 0) / a.durations.length) : 0
    const p95Ms = percentile(a.durations, 95)
    const errorRate = a.calls ? a.errors / a.calls : 0
    return {
      manager, calls: a.calls, costCents: a.cost, tokens: a.tokens, avgMs, p95Ms, errorRate,
      slo: classifyManagerSlo({ costCents: a.cost, p95Ms, errorRate }),
    }
  }).sort((x, y) => y.costCents - x.costCents)

  return {
    windowHours, managers,
    summary: {
      totalCostCents: managers.reduce((s, m) => s + m.costCents, 0),
      totalCalls: managers.reduce((s, m) => s + m.calls, 0),
      breaching: managers.filter((m) => m.slo === "breach").length,
      warning: managers.filter((m) => m.slo === "warn").length,
    },
  }
}

// ─── VOICE TOOL-ROUND DEADLINE STATS (blind-spot burn-down, lane 74C, 2026-09-18) ──
//
// lib/voice/twilio-voice.ts's VOICE_TOOL_ROUND_DEADLINE_MS was DERIVED, not
// measured (its own header says so), with "retune against real production
// call audio" left UNRESOLVED because no telemetry existed to retune it
// FROM. planTurnWithPrompt now tags every tool-round attempt (success AND
// the fallback-triggering failure/timeout) with `context_json.toolRound:
// true` on the SAME EXISTING ledger loadManagerOps reads (ai_tool_usage) —
// this is the narrower reader that answers the specific question the
// deadline needs answered: not "how is ai_isa doing overall" (which mixes in
// every OTHER ai_isa-attributed call) but "how often does the bounded
// native-tool-calling round actually hit its ceiling, and what would a
// looser or tighter one look like against the SAME calls".
export interface VoiceToolRoundDeadlineStats {
  windowHours: number
  attempts: number
  deadlineHits: number
  deadlineHitRate: number
  avgMs: number
  p95Ms: number
  /** How many of the sample would ALSO have hit a tighter or looser ceiling —
   *  lets an operator ask "what if the deadline were 3000ms instead of
   *  4000ms" directly from the same sample, not a fresh query. PRECOMPUTED
   *  over VOICE_DEADLINE_CANDIDATE_LADDER_MS (lane 76C): the wave-74 shape was
   *  a FUNCTION-valued field, and this struct crosses a "use server" action
   *  boundary (app/actions/superadmin/ai-ops.ts) into a client component —
   *  React's server-action serializer refuses a function, so the action
   *  rejected and the panel's `.then` never set state. Plain data only. */
  hitRateAtMs: Array<{ candidateMs: number; hitRate: number }>
  /** Telemetry-derived tuning proposal (recommendVoiceToolRoundDeadlineMs) —
   *  null until the sample is large enough to trust (see that function). */
  recommendedDeadlineMs: number | null
  /** The floor `recommendedDeadlineMs` waits for, published beside the number
   *  so a null reads as "not enough calls yet", never as "no recommendation". */
  recommendationMinAttempts: number
}

/** Candidate ceilings the ladder is evaluated at, bracketing the 4000ms policy
 *  default both ways so an operator can see the trade-off on one line. */
export const VOICE_DEADLINE_CANDIDATE_LADDER_MS = [2000, 3000, 4000, 5000, 6000, 8000] as const

/** Fewer attempts than this and the p95 is one or two calls' noise — the
 *  recommendation withholds itself rather than tuning a live-call deadline
 *  from a handful of rows. */
export const VOICE_DEADLINE_RECOMMENDATION_MIN_ATTEMPTS = 50

/**
 * PURE: the deadline the measured sample argues for. p95 of the tool-round
 * durations, plus 10% headroom so the 95th-percentile call itself does not
 * sit exactly on the ceiling, rounded UP to the next 250ms, clamped to
 * [2000, 8000] — below 2s the round cannot fit one model call, above 8s dead
 * air on a live call reads as a dropped call (twilio-voice.ts's own header).
 * Null when the sample is too small to trust (never a number from noise).
 */
export function recommendVoiceToolRoundDeadlineMs(
  durationsMs: number[],
  minAttempts = VOICE_DEADLINE_RECOMMENDATION_MIN_ATTEMPTS,
): number | null {
  const xs = durationsMs.filter((v) => Number.isFinite(v) && v >= 0)
  if (xs.length < minAttempts) return null
  const p95 = percentile(xs, 95)
  const withHeadroom = Math.ceil((p95 * 1.1) / 250) * 250
  return Math.min(8000, Math.max(2000, withHeadroom))
}

/**
 * PURE: `ai_tool_usage.context_json` is a TEXT column on the live schema
 * (confirmed against information_schema 2026-09-18, lane 76C), and
 * lib/ai/cost-tracking.ts inserts an OBJECT into it — PostgREST serialises
 * that to a JSON string on the way in, and supabase-js hands the string back
 * on the way out. The wave-74 reader compared `context_json?.toolRound ===
 * true` against that STRING, so the filter matched nothing and the stat read
 * "0 attempts" forever, whatever the calls did. Parse a string, pass an
 * object through, and refuse anything else as null.
 */
export function parseContextJson(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null
  if (typeof raw === "object") return raw as Record<string, unknown>
  if (typeof raw !== "string") return null
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Cross-tenant — the deadline is one platform-wide constant
 *  (VOICE_TOOL_ROUND_DEADLINE_MS), not a per-brokerage setting, so the stat
 *  that tunes it reads across every tenant's calls, same posture as
 *  loadManagerOps. */
export async function loadVoiceToolRoundDeadlineStats(client?: Svc, windowHours = 24 * 7): Promise<VoiceToolRoundDeadlineStats> {
  const svc = client ?? createServiceClient()
  const since = new Date(Date.now() - windowHours * 3_600_000).toISOString()

  const { data, error } = await svc
    .from("ai_tool_usage")
    .select("execution_time_ms, success, context_json")
    .eq("tool_name", "ai_model")
    .eq("feature", "voice_reception_turn")
    .eq("manager", "ai_isa")
    .gte("created_at", since)
    .limit(50_000)
  if (error) console.warn("[manager-ops] voice tool-round telemetry read refused:", error.message)

  const rows = ((data ?? []) as any[])
    .map((r) => ({ ...r, ctx: parseContextJson(r.context_json) }))
    .filter((r) => r.ctx?.toolRound === true)
  const durations = rows.map((r) => Number(r.execution_time_ms)).filter((v) => Number.isFinite(v))
  const hits = rows.filter((r) => r.ctx?.deadlineHit === true)

  return {
    windowHours,
    attempts: rows.length,
    deadlineHits: hits.length,
    deadlineHitRate: rows.length ? hits.length / rows.length : 0,
    avgMs: durations.length ? Math.round(durations.reduce((s, v) => s + v, 0) / durations.length) : 0,
    p95Ms: percentile(durations, 95),
    hitRateAtMs: VOICE_DEADLINE_CANDIDATE_LADDER_MS.map((candidateMs) => ({
      candidateMs,
      hitRate: durations.length ? durations.filter((v) => v >= candidateMs).length / durations.length : 0,
    })),
    recommendedDeadlineMs: recommendVoiceToolRoundDeadlineMs(durations),
    recommendationMinAttempts: VOICE_DEADLINE_RECOMMENDATION_MIN_ATTEMPTS,
  }
}
