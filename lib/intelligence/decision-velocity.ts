// lib/intelligence/decision-velocity.ts
//
// DEAL-VELOCITY SCOREBOARD (deal_coordinator) — the differentiator METRIC no
// competitor can even measure: median time from a CLIENT'S DECISION (seller
// hit Accept, lender posted conditions, vendor filed a request — the
// decision-signal tasks) to the AGENT'S EXECUTION (task completed). The
// self-audit already escalates individual 48h breaches; this is the
// aggregate — the number a broker puts in a QBR and a recruiting pitch:
// "our clients' decisions move in N hours." Honest by construction: a median
// needs MIN_SAMPLES completed decisions or it reports null (never a
// fabricated stat); open decisions surface as open, not as zeros.

import type { SupabaseClient } from "@supabase/supabase-js"
import { CLIENT_DECISION_SOURCES } from "@/lib/kernel/command-center"

type Svc = SupabaseClient<any, any, any>

export const MIN_SAMPLES = 3
export const VELOCITY_WINDOW_DAYS = 30

export interface DecisionRow {
  assigned_to_agent_id: string | null
  status: string | null
  created_at: string | null
  completed_at: string | null
}

export interface AgentVelocity {
  agentId: string
  medianHours: number | null
  executed: number
  open: number
}

export interface DecisionVelocity {
  medianHours: number | null
  executed: number
  open: number
  openOver48h: number
  perAgent: AgentVelocity[]
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** PURE: fold decision tasks into the velocity scoreboard. */
export function computeDecisionVelocity(rows: DecisionRow[], now: Date): DecisionVelocity {
  const durations: number[] = []
  const byAgent = new Map<string, { durations: number[]; open: number }>()
  let open = 0
  let openOver48h = 0

  for (const r of rows) {
    if (!r.created_at) continue // undated is never a fabricated sample
    const agent = r.assigned_to_agent_id ?? "unassigned"
    const e = byAgent.get(agent) ?? { durations: [], open: 0 }
    if (r.completed_at) {
      const h = (new Date(r.completed_at).getTime() - new Date(r.created_at).getTime()) / 3_600_000
      if (!Number.isNaN(h) && h >= 0) { durations.push(h); e.durations.push(h) }
    } else if ((r.status ?? "") === "pending") {
      open += 1
      e.open += 1
      const age = (now.getTime() - new Date(r.created_at).getTime()) / 3_600_000
      if (age >= 48) openOver48h += 1
    }
    byAgent.set(agent, e)
  }

  const perAgent: AgentVelocity[] = [...byAgent.entries()].map(([agentId, e]) => ({
    agentId,
    medianHours: e.durations.length >= MIN_SAMPLES ? Math.round((median(e.durations) ?? 0) * 10) / 10 : null,
    executed: e.durations.length,
    open: e.open,
  })).sort((a, b) => (a.medianHours ?? Infinity) - (b.medianHours ?? Infinity))

  return {
    medianHours: durations.length >= MIN_SAMPLES ? Math.round((median(durations) ?? 0) * 10) / 10 : null,
    executed: durations.length,
    open,
    openOver48h,
    perAgent,
  }
}

/** Load the trailing-window decision tasks and compute the scoreboard. */
export async function loadDecisionVelocity(svc: Svc, brokerageId: string, now: Date = new Date()): Promise<DecisionVelocity> {
  const cutoff = new Date(now.getTime() - VELOCITY_WINDOW_DAYS * 86_400_000).toISOString()
  const { data } = await svc.from("tasks")
    .select("assigned_to_agent_id, status, created_at, completed_at")
    .in("source", [...CLIENT_DECISION_SOURCES])
    .gte("created_at", cutoff)
    .eq("brokerage_id", brokerageId)
    .limit(2000)
  return computeDecisionVelocity(((data ?? []) as DecisionRow[]), now)
}

/** PURE: the QBR / pitch line — only when the median is REAL. */
export function composeVelocityLine(v: DecisionVelocity): string | null {
  if (v.medianHours == null) return null
  const label = v.medianHours < 24 ? `${v.medianHours} hours` : `${Math.round((v.medianHours / 24) * 10) / 10} days`
  return `When you make a decision — accepting an offer, sending a document — your team executes it in a median ${label}. That number is tracked on every single decision, and it is the standard we hold ourselves to.`
}
