// lib/platform/ai-ops.ts
//
// AI OPERATIONS — the cross-tenant view of the autonomous layer for platform staff. Every tenant's AI
// managers act on the SAME primitives (the manager_signals bus, the gated agent_client_messages rail, the
// cron health snapshot, automation_errors), but those were only ever surfaced PER-TENANT (manager-standup /
// weekly P&L). The platform had no way to answer "which tenants' AIs are stuck / failing / held right now?"
// This aggregates the real signals into one platform AI-ops surface:
//   • manager THROUGHPUT — signals consumed (the AI team acting) in a window, by manager
//   • DEAD-LETTER / STUCK — manager_signals still 'open' past a threshold (a handoff never picked up)
//   • HELD actions — agent_client_messages 'proposed' + aged (awaiting a human at the gate)
//   • FAILED sends — agent_client_messages with a send_error
//   • AUTOMATION errors — unresolved automation_errors, by severity
//   • CRON health — failing or stale autonomous jobs
// Pure classifiers here (testable); the loader aggregates; the console + replay actions consume it.

import { createServiceClient } from "@/lib/supabase/service"

/** A manager_signal is a DEAD-LETTER (stuck) when it's still open past this age — the addressed manager
 *  never consumed the handoff. */
export const STUCK_SIGNAL_HOURS = 24
/** A gated proposal held past this age is a stale approval the human hasn't cleared. */
export const STALE_HELD_HOURS = 72

/** PURE: is a manager signal stuck (open + older than the threshold)? */
export function isStuckSignal(sig: { status: string; created_at: string }, now: Date, thresholdHours = STUCK_SIGNAL_HOURS): boolean {
  if (sig.status !== "open") return false
  const age = now.getTime() - Date.parse(sig.created_at)
  return Number.isFinite(age) && age >= thresholdHours * 3_600_000
}

export type CronHealth = "healthy" | "failing" | "stale" | "unknown"

/** PURE: classify a cron's health from its snapshot (last status + staleness vs its expected interval). */
export function cronHealth(row: { last_status: string | null; last_run_at: string | null; expected_interval_hours: number | null }, now: Date): CronHealth {
  // TOMBSTONE: the `|| row.last_status === "error"` disjunct that stood here is
  // deleted. Survivor: "failure", written by lib/kernel/cron-logging.ts:415 —
  // the ONLY failure spelling any writer of cron_health_snapshot.last_status
  // has ever produced. "error" belongs to a DIFFERENT table's vocabulary
  // (system_health_checks.status, widened by m371), and testing one table's
  // word against another table's column is the defect
  // app/actions/pl-truth-engine.ts:326 already records this repo paying for.
  //
  // "running" is NOT tested here on purpose. It is a live status as of
  // lib/kernel/cron-logging.ts:createCronRunContext, but a cron that is running
  // right now is neither failing nor healthy on its own account — the staleness
  // arm below still judges it by when it last COMPLETED, which is the honest
  // reading and the one that catches a run that hangs and never returns.
  if (row.last_status === "failure") return "failing"
  if (!row.last_run_at) return "unknown"
  const age = now.getTime() - Date.parse(row.last_run_at)
  const interval = (row.expected_interval_hours ?? 24) * 3_600_000
  // Stale if it hasn't run in 2× its expected cadence.
  if (Number.isFinite(age) && age > interval * 2) return "stale"
  return "healthy"
}

export interface ManagerThroughput { manager: string; consumed: number; published: number }
export interface StuckSignalRow { id: string; brokerageId: string | null; fromManager: string; toManager: string; signalType: string; ageHours: number; createdAt: string }
/** `stale` is computed HERE against STALE_HELD_HOURS (§1.1, 2026-08-31, lane
 *  M4): the ai-ops console used to respell the threshold as a literal `>= 72`
 *  in its className — a second copy of the number the constant above already
 *  owned, free to drift. The console now reads this flag. */
export interface HeldActionRow { managerKind: string; brokerageId: string | null; count: number; oldestHours: number; stale: boolean }
export interface FailedSendRow { id: string; brokerageId: string | null; managerKind: string; error: string; createdAt: string }
export interface AutomationErrorRow { id: string; brokerageId: string | null; workflow: string; severity: string; error: string; createdAt: string }
export interface CronHealthRow { cronName: string; health: CronHealth; lastRunAt: string | null; failure7d: number; lastError: string | null }

export interface AiOps {
  windowHours: number
  throughput: ManagerThroughput[]
  stuckSignals: StuckSignalRow[]
  heldActions: HeldActionRow[]
  failedSends: FailedSendRow[]
  automationErrors: AutomationErrorRow[]
  cronHealth: CronHealthRow[]
  summary: { consumed: number; stuck: number; held: number; failed: number; errors: number; cronsFailing: number }
}

type Svc = ReturnType<typeof createServiceClient>

/** Cross-tenant AI-ops rollup. Best-effort; each section degrades independently. */
export async function loadAiOps(client?: Svc, now: Date = new Date(), windowHours = 24): Promise<AiOps> {
  const svc = client ?? createServiceClient()
  const since = new Date(now.getTime() - windowHours * 3_600_000).toISOString()

  const [signalsR, heldR, failedR, errorsR, cronR] = await Promise.all([
    svc.from("manager_signals").select("id, brokerage_id, from_manager, to_manager, signal_type, status, consumed_at, created_at").order("created_at", { ascending: false }).limit(5000),
    svc.from("agent_client_messages").select("brokerage_id, agent_kind, status, created_at").eq("status", "proposed").limit(5000),
    svc.from("agent_client_messages").select("id, brokerage_id, agent_kind, send_error, status, created_at").or("send_error.not.is.null,status.eq.failed").order("created_at", { ascending: false }).limit(500),
    svc.from("automation_errors").select("id, brokerage_id, workflow_name, severity, error_message, status, created_at").not("status", "in", "(resolved,dismissed)").order("created_at", { ascending: false }).limit(500),
    svc.from("cron_health_snapshot").select("cron_name, last_status, last_run_at, expected_interval_hours, failure_count_7d, last_error_message").limit(500),
  ])

  // Throughput + dead-letter from the bus.
  const consumedByMgr = new Map<string, number>()
  const publishedByMgr = new Map<string, number>()
  const stuckSignals: StuckSignalRow[] = []
  const sinceMs = Date.parse(since)
  for (const s of (signalsR.data ?? []) as any[]) {
    if (Date.parse(s.created_at) >= sinceMs) publishedByMgr.set(s.from_manager, (publishedByMgr.get(s.from_manager) ?? 0) + 1)
    // Consumed (the addressed manager ACTED) within the window — counted by when it was consumed.
    if (s.status === "consumed" && Date.parse(s.consumed_at ?? s.created_at) >= sinceMs) {
      consumedByMgr.set(s.to_manager, (consumedByMgr.get(s.to_manager) ?? 0) + 1)
    }
    if (isStuckSignal(s, now)) {
      stuckSignals.push({ id: s.id, brokerageId: s.brokerage_id, fromManager: s.from_manager, toManager: s.to_manager, signalType: s.signal_type, ageHours: Math.floor((now.getTime() - Date.parse(s.created_at)) / 3_600_000), createdAt: s.created_at })
    }
  }
  const managers = new Set([...consumedByMgr.keys(), ...publishedByMgr.keys()])
  const throughput: ManagerThroughput[] = [...managers].map((m) => ({ manager: m, consumed: consumedByMgr.get(m) ?? 0, published: publishedByMgr.get(m) ?? 0 }))
    .sort((a, b) => b.consumed + b.published - (a.consumed + a.published))

  // Held actions (proposed, aged), grouped by manager + tenant.
  const heldMap = new Map<string, { count: number; oldest: number }>()
  for (const h of (heldR.data ?? []) as any[]) {
    const key = `${h.agent_kind}::${h.brokerage_id}`
    const ageH = Math.floor((now.getTime() - Date.parse(h.created_at)) / 3_600_000)
    const cur = heldMap.get(key) ?? { count: 0, oldest: 0 }
    heldMap.set(key, { count: cur.count + 1, oldest: Math.max(cur.oldest, ageH) })
  }
  const heldActions: HeldActionRow[] = [...heldMap.entries()].map(([key, v]) => {
    const [managerKind, brokerageId] = key.split("::")
    return { managerKind, brokerageId: brokerageId === "null" ? null : brokerageId, count: v.count, oldestHours: v.oldest, stale: v.oldest >= STALE_HELD_HOURS }
  }).sort((a, b) => b.oldestHours - a.oldestHours)

  const failedSends: FailedSendRow[] = ((failedR.data ?? []) as any[]).map((f) => ({ id: f.id, brokerageId: f.brokerage_id, managerKind: f.agent_kind, error: String(f.send_error ?? f.status ?? "failed").slice(0, 300), createdAt: f.created_at }))
  const automationErrors: AutomationErrorRow[] = ((errorsR.data ?? []) as any[]).map((e) => ({ id: e.id, brokerageId: e.brokerage_id, workflow: e.workflow_name, severity: e.severity ?? "medium", error: String(e.error_message ?? "").slice(0, 300), createdAt: e.created_at }))

  const cronHealthRows: CronHealthRow[] = ((cronR.data ?? []) as any[])
    .map((c) => ({ cronName: c.cron_name, health: cronHealth(c, now), lastRunAt: c.last_run_at, failure7d: c.failure_count_7d ?? 0, lastError: c.last_error_message ?? null }))
    .filter((c) => c.health === "failing" || c.health === "stale")
    .sort((a, b) => (a.health === "failing" ? 0 : 1) - (b.health === "failing" ? 0 : 1))

  return {
    windowHours, throughput, stuckSignals, heldActions, failedSends, automationErrors, cronHealth: cronHealthRows,
    summary: {
      consumed: [...consumedByMgr.values()].reduce((a, b) => a + b, 0),
      stuck: stuckSignals.length,
      held: (heldR.data ?? []).length,
      failed: failedSends.length,
      errors: automationErrors.length,
      cronsFailing: cronHealthRows.filter((c) => c.health === "failing").length,
    },
  }
}
