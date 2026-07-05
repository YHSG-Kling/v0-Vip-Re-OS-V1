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
