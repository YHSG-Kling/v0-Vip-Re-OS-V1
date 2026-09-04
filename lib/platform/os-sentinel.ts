// lib/platform/os-sentinel.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE OS SENTINEL — ONE "state of the whole agentic OS" for platform staff.
//
// The autonomous layer was already watched, but in PIECES across two god-console
// pages (/superadmin/ai-ops for the bus/SLO/crons, /superadmin/platform for
// margin/cron/tenant-safety) plus signals that reached NO surface (the reaper_runs
// self-heal ledger; the weekly red-team eval, which lived only in a notification).
// The Sentinel is a CONSOLIDATION, not a parallel system: a pure roll-up that
// composes the EXISTING loaders (loadAiOps, loadManagerOps, loadRotationRisks) plus
// two small reads into ONE OsHealth object — a status per subsystem + an overall
// worst-of status + the top open incidents. It writes nothing and adds no autonomy;
// it points at the self-healing that already runs (signal reaper, credential refresh,
// connector healer) and makes the OS observable at a glance.
//
// Named os-sentinel (platform namespace) to avoid collision with the per-tenant
// lib/kernel/ai-sentinel.ts and lib/wire-fraud/wire-fraud-sentinel.ts.

export type SubsystemStatus = "ok" | "warn" | "breach"

export interface SubsystemHealth {
  key: string
  label: string
  status: SubsystemStatus
  count: number
  detail: string
  /** Deep-link to the existing console that owns this subsystem. */
  link: string
}

export interface OsIncident {
  subsystem: string
  severity: SubsystemStatus
  summary: string
  brokerageId?: string | null
}

export interface OsHealth {
  generatedAt: string
  overall: SubsystemStatus
  subsystems: SubsystemHealth[]
  topIncidents: OsIncident[]
  /** Self-heal accountability (reaper_runs) — was invisible before. */
  selfHeal: { runs: number; replayed: number; escalated: number }
  /** Weekly red-team eval posture — was ephemeral (a notification) before. */
  redTeam: { status: SubsystemStatus; lastRegressionAt: string | null }
}

// ── Pure classifiers ─────────────────────────────────────────────────────────

const ORDER: Record<SubsystemStatus, number> = { ok: 0, warn: 1, breach: 2 }

/** Worst-of across statuses — mirrors classifyManagerSlo's worst-of-three shape. */
export function worstStatus(statuses: SubsystemStatus[]): SubsystemStatus {
  return statuses.reduce<SubsystemStatus>((acc, s) => (ORDER[s] > ORDER[acc] ? s : acc), "ok")
}

/** Generic count → status by two thresholds (warnAt inclusive, breachAt inclusive). */
export function classifyCount(count: number, warnAt: number, breachAt: number): SubsystemStatus {
  if (count >= breachAt) return "breach"
  if (count >= warnAt) return "warn"
  return "ok"
}

/** Thresholds live in one place so the board and any future alert agree. */
export const SENTINEL_THRESHOLDS = {
  stuckSignals:     { warn: 1,  breach: 10 },
  cronsFailing:     { warn: 1,  breach: 3 },
  automationErrors: { warn: 1,  breach: 20 },
  failedSends:      { warn: 1,  breach: 15 },
  heldProposals:    { warn: 25, breach: 100 },
  expiredCreds:     { warn: 1,  breach: 5 },
  tenantIsolation:  { warn: 1,  breach: 1 },  // any RLS-isolation finding is a breach
  // Stalled = in_progress >24h. The status callback closes rows on hangup, so
  // a pile-up means the platform line's webhooks are broken (the front door
  // is down and nobody would otherwise notice).
  receptionStalled: { warn: 5,  breach: 25 },
  // Rows the unified queue drain CLOSED AS FAILED in the last 24h, across the
  // push queue and orchestrator tasks. One is a bad configuration; a pile is a
  // rail that is down.
  queueFailures:    { warn: 1,  breach: 25 },
} as const

export interface OsHealthInputs {
  generatedAt: string
  aiOps: { stuck: number; held: number; failed: number; errors: number; cronsFailing: number }
  managerSlo: { breaching: number; warning: number }
  expiredCredentials: number
  expiringCredentials: number
  tenantIsolationFindings: number
  selfHeal: { runs: number; replayed: number; escalated: number }
  redTeam: { lastRegressionAt: string | null }
  /** The platform's own AI reception line (7-day window). */
  platformReception: { calls7d: number; prospects7d: number; stalled: number }
  /**
   * ORPHAN DOCTRINE §1.2 — BUILD THE MISSING HALF (no duplicate existed).
   *
   * The unified queue drain (app/api/cron/queue-drain/route.ts) writes the
   * OUTCOME of every row it services and NOTHING read any of it:
   * push_notification_queue.delivered_at / failed_at / error_message (:314,
   * :352) and orchestrator_tasks.executed_at / last_error (:401). The drain
   * was scrupulous about recording WHY a push never left the building — "no
   * push provider configured", "no_active_subscriptions",
   * "web_push_delivery_failed" — and an operator had no way to see any of it.
   * That is a rail that can be down for a month in silence.
   *
   * The Sentinel already owns "state of the whole OS" for platform staff, so
   * this is a subsystem here rather than a new console (§1: merge onto the
   * survivor, do not grow a twin).
   */
  deliveryQueues: DeliveryQueueHealth
  topIncidents: OsIncident[]
}

export interface DeliveryQueueHealth {
  /** push_notification_queue rows the drain closed as FAILED in the window. */
  pushFailed: number
  /** push_notification_queue rows the drain marked DELIVERED in the window. */
  pushDelivered: number
  /** orchestrator_tasks rows the drain closed as FAILED in the window. */
  tasksFailed: number
  /** The most recent honest failure reason across both queues, if any. */
  lastReason: string | null
  /**
   * Queues whose health could NOT be read (a refused select). Non-empty means
   * "nobody checked" — §4 fail-closed: it must never render as "checked and
   * fine", so it forces the subsystem to at least WARN.
   */
  unreadable: string[]
}

/**
 * PURE — delivery-queue status. An UNREADABLE queue is never "ok": a select
 * this loader could not run is "nobody checked", and §4 forbids rendering that
 * as "checked and fine".
 */
export function deliveryQueueStatus(q: DeliveryQueueHealth): SubsystemStatus {
  const T = SENTINEL_THRESHOLDS.queueFailures
  const byCount = classifyCount(q.pushFailed + q.tasksFailed, T.warn, T.breach)
  if (q.unreadable.length > 0 && byCount === "ok") return "warn"
  return byCount
}

/** PURE — the one-line detail the board renders under the tile. */
export function describeDeliveryQueues(q: DeliveryQueueHealth): string {
  const parts = [
    `${q.pushFailed} push failed`,
    `${q.pushDelivered} delivered`,
    `${q.tasksFailed} task(s) failed`,
  ]
  if (q.unreadable.length > 0) parts.push(`UNREAD: ${q.unreadable.join(", ")}`)
  const head = parts.join(" · ")
  return q.lastReason ? `${head} — ${q.lastReason.slice(0, 90)}` : head
}

/** PURE reducer: subsystem statuses + overall worst-of, from already-loaded metrics. */
export function rollupOsHealth(i: OsHealthInputs): OsHealth {
  const T = SENTINEL_THRESHOLDS
  const managerSloStatus: SubsystemStatus = i.managerSlo.breaching > 0 ? "breach" : i.managerSlo.warning > 0 ? "warn" : "ok"
  // A red-team regression in the last 7 days is a hard breach; otherwise ok.
  const redTeamStatus: SubsystemStatus = i.redTeam.lastRegressionAt ? "breach" : "ok"

  const subsystems: SubsystemHealth[] = [
    { key: "autonomy_bus", label: "Autonomy bus (stuck handoffs)", status: classifyCount(i.aiOps.stuck, T.stuckSignals.warn, T.stuckSignals.breach), count: i.aiOps.stuck, detail: `${i.aiOps.stuck} signal(s) stuck >24h`, link: "/dashboard/superadmin/ai-ops" },
    { key: "manager_slo", label: "Manager SLO (cost / latency / errors)", status: managerSloStatus, count: i.managerSlo.breaching + i.managerSlo.warning, detail: `${i.managerSlo.breaching} breaching, ${i.managerSlo.warning} warning`, link: "/dashboard/superadmin/ai-ops" },
    { key: "crons", label: "Cron health", status: classifyCount(i.aiOps.cronsFailing, T.cronsFailing.warn, T.cronsFailing.breach), count: i.aiOps.cronsFailing, detail: `${i.aiOps.cronsFailing} cron(s) failing/stale`, link: "/dashboard/superadmin/platform" },
    { key: "automation_errors", label: "Automation errors (unresolved)", status: classifyCount(i.aiOps.errors, T.automationErrors.warn, T.automationErrors.breach), count: i.aiOps.errors, detail: `${i.aiOps.errors} unresolved`, link: "/dashboard/superadmin/ai-ops" },
    { key: "failed_sends", label: "Failed sends", status: classifyCount(i.aiOps.failed, T.failedSends.warn, T.failedSends.breach), count: i.aiOps.failed, detail: `${i.aiOps.failed} send failure(s)`, link: "/dashboard/superadmin/ai-ops" },
    { key: "held_proposals", label: "Gated proposals aging", status: classifyCount(i.aiOps.held, T.heldProposals.warn, T.heldProposals.breach), count: i.aiOps.held, detail: `${i.aiOps.held} proposal(s) awaiting a human`, link: "/dashboard/superadmin/ai-ops" },
    { key: "credentials", label: "Integration credentials", status: classifyCount(i.expiredCredentials, T.expiredCreds.warn, T.expiredCreds.breach) === "ok" && i.expiringCredentials > 0 ? "warn" : classifyCount(i.expiredCredentials, T.expiredCreds.warn, T.expiredCreds.breach), count: i.expiredCredentials + i.expiringCredentials, detail: `${i.expiredCredentials} expired, ${i.expiringCredentials} expiring`, link: "/dashboard/superadmin/ai-ops" },
    { key: "tenant_isolation", label: "Tenant isolation (RLS)", status: classifyCount(i.tenantIsolationFindings, T.tenantIsolation.warn, T.tenantIsolation.breach), count: i.tenantIsolationFindings, detail: `${i.tenantIsolationFindings} unresolved finding(s)`, link: "/dashboard/superadmin/platform" },
    { key: "red_team", label: "Red-team eval (weekly)", status: redTeamStatus, count: i.redTeam.lastRegressionAt ? 1 : 0, detail: i.redTeam.lastRegressionAt ? `Regression flagged ${i.redTeam.lastRegressionAt.slice(0, 10)}` : "No recent regression", link: "/dashboard/superadmin/ai-ops" },
    { key: "platform_reception", label: "Platform reception line (7d)", status: classifyCount(i.platformReception.stalled, T.receptionStalled.warn, T.receptionStalled.breach), count: i.platformReception.calls7d, detail: `${i.platformReception.calls7d} call(s), ${i.platformReception.prospects7d} prospect(s) captured, ${i.platformReception.stalled} stalled`, link: "/dashboard/superadmin/connectors" },
    { key: "delivery_queues", label: "Delivery queues (push / tasks, 24h)", status: deliveryQueueStatus(i.deliveryQueues), count: i.deliveryQueues.pushFailed + i.deliveryQueues.tasksFailed, detail: describeDeliveryQueues(i.deliveryQueues), link: "/dashboard/superadmin/ai-ops" },
  ]

  const overall = worstStatus(subsystems.map((s) => s.status))
  return {
    generatedAt: i.generatedAt,
    overall,
    subsystems,
    topIncidents: i.topIncidents.slice(0, 20),
    selfHeal: i.selfHeal,
    redTeam: { status: redTeamStatus, lastRegressionAt: i.redTeam.lastRegressionAt },
  }
}

// ── The one impure loader — composes existing roll-ups, degrades independently ─

export async function loadOsHealth(client?: any, now: Date = new Date()): Promise<OsHealth> {
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = client ?? createServiceClient()
  const generatedAt = now.toISOString()

  const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => {
    try { return await p } catch { return fallback }
  }

  const [aiOps, managerOps, rotationRisks, tenantFindings, reaperAgg, redTeam, reception, queues] = await Promise.all([
    safe((async () => (await import("@/lib/platform/ai-ops")).loadAiOps(svc, now))(), null as any),
    safe((async () => (await import("@/lib/platform/manager-ops")).loadManagerOps(svc))(), null as any),
    safe((async () => (await import("@/lib/security/credential-rotation")).loadRotationRisks(svc))(), [] as any[]),
    safe(countUnresolvedTenantFindings(svc), 0),
    safe(loadSelfHeal(svc, now), { runs: 0, replayed: 0, escalated: 0 }),
    safe(loadRedTeam(svc, now), { lastRegressionAt: null as string | null }),
    safe(loadPlatformReception(svc, now), { calls7d: 0, prospects7d: 0, stalled: 0 }),
    // The fallback is NOT an all-clear: a thrown loader lands here as "both
    // queues unreadable", which deliveryQueueStatus turns into a WARN.
    safe(loadDeliveryQueues(svc, now), {
      pushFailed: 0, pushDelivered: 0, tasksFailed: 0, lastReason: null,
      unreadable: ["push_notification_queue", "orchestrator_tasks"], reasons: [],
    }),
  ])

  const aiSummary = aiOps?.summary ?? { consumed: 0, stuck: 0, held: 0, failed: 0, errors: 0, cronsFailing: 0 }
  const mgrSummary = managerOps?.summary ?? { breaching: 0, warning: 0 }
  const risks = (rotationRisks ?? []) as Array<{ status?: string }>
  const expired = risks.filter((r) => r.status === "expired").length
  const expiring = risks.length - expired

  // Top incidents — the worst open items across subsystems, for the board's list.
  const topIncidents: OsIncident[] = []
  for (const s of (aiOps?.stuckSignals ?? []).slice(0, 8) as any[]) {
    topIncidents.push({ subsystem: "autonomy_bus", severity: "warn", summary: `Stuck ${s.signalType}: ${s.fromManager}→${s.toManager} (${s.ageHours}h)`, brokerageId: s.brokerageId })
  }
  for (const c of (aiOps?.cronHealth ?? []).slice(0, 6) as any[]) {
    topIncidents.push({ subsystem: "crons", severity: c.health === "failing" ? "breach" : "warn", summary: `Cron ${c.cronName}: ${c.health}${c.lastError ? ` — ${String(c.lastError).slice(0, 80)}` : ""}` })
  }
  for (const e of (aiOps?.automationErrors ?? []).filter((x: any) => x.severity === "critical" || x.severity === "high").slice(0, 6) as any[]) {
    topIncidents.push({ subsystem: "automation_errors", severity: e.severity === "critical" ? "breach" : "warn", summary: `${e.workflow}: ${e.error}`, brokerageId: e.brokerageId })
  }
  for (const r of queues.reasons.slice(0, 6)) {
    topIncidents.push({ subsystem: "delivery_queues", severity: "warn", summary: r })
  }
  for (const u of queues.unreadable) {
    topIncidents.push({ subsystem: "delivery_queues", severity: "warn", summary: `${u}: health could not be read — nobody checked` })
  }

  return rollupOsHealth({
    generatedAt,
    aiOps: { stuck: aiSummary.stuck, held: aiSummary.held, failed: aiSummary.failed, errors: aiSummary.errors, cronsFailing: aiSummary.cronsFailing },
    managerSlo: { breaching: mgrSummary.breaching ?? 0, warning: mgrSummary.warning ?? 0 },
    expiredCredentials: expired,
    expiringCredentials: expiring,
    tenantIsolationFindings: tenantFindings,
    selfHeal: reaperAgg,
    redTeam,
    platformReception: reception,
    deliveryQueues: {
      pushFailed: queues.pushFailed,
      pushDelivered: queues.pushDelivered,
      tasksFailed: queues.tasksFailed,
      lastReason: queues.lastReason,
      unreadable: queues.unreadable,
    },
    topIncidents,
  })
}

/**
 * ORPHAN DOCTRINE §1.2 — THE READER THAT DID NOT EXIST.
 *
 * Reads the queue drain's own outcome columns over a 24h window:
 *   push_notification_queue — status/failed_at/error_message (why a push never
 *     left) and delivered_at (that any did).
 *   orchestrator_tasks      — status/executed_at/last_error (which task types
 *     have no executor, which posts the canonical publisher rejected).
 *
 * §3: every select destructures `{ data, error }` and READS the error — a
 * refused select is reported as UNREADABLE, never counted as zero failures.
 */
async function loadDeliveryQueues(
  svc: any,
  now: Date,
): Promise<DeliveryQueueHealth & { reasons: string[] }> {
  const dayAgo = new Date(now.getTime() - 24 * 3_600_000).toISOString()
  const unreadable: string[] = []
  const reasons: string[] = []

  const [pushFailedRes, pushDeliveredRes, tasksFailedRes] = await Promise.all([
    svc.from("push_notification_queue")
      .select("id, error_message, failed_at")
      .eq("status", "failed").gte("failed_at", dayAgo)
      .order("failed_at", { ascending: false }).limit(500),
    svc.from("push_notification_queue")
      .select("id, delivered_at")
      .eq("status", "delivered").gte("delivered_at", dayAgo).limit(1000),
    svc.from("orchestrator_tasks")
      .select("id, task_type, last_error, executed_at")
      .eq("status", "failed").gte("executed_at", dayAgo)
      .order("executed_at", { ascending: false }).limit(500),
  ])

  if (pushFailedRes?.error) unreadable.push("push_notification_queue (failed)")
  if (pushDeliveredRes?.error) unreadable.push("push_notification_queue (delivered)")
  if (tasksFailedRes?.error) unreadable.push("orchestrator_tasks")

  const pushFailedRows = (pushFailedRes?.data ?? []) as Array<{ error_message?: string | null; failed_at?: string | null }>
  const taskFailedRows = (tasksFailedRes?.data ?? []) as Array<{ task_type?: string | null; last_error?: string | null; executed_at?: string | null }>

  // Group by reason so a hundred rows of the same broken config read as ONE
  // incident line with its count, not a hundred identical incidents.
  const tally = new Map<string, number>()
  for (const r of pushFailedRows) {
    const key = `push: ${(r.error_message ?? "no reason recorded").slice(0, 120)}`
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  for (const r of taskFailedRows) {
    const key = `task ${r.task_type ?? "?"}: ${(r.last_error ?? "no reason recorded").slice(0, 120)}`
    tally.set(key, (tally.get(key) ?? 0) + 1)
  }
  for (const [reason, n] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    reasons.push(n > 1 ? `${reason} (×${n})` : reason)
  }

  // The most RECENT reason (both selects are ordered newest-first), which is
  // what an operator wants on the tile itself.
  const lastReason =
    pushFailedRows[0]?.error_message ??
    taskFailedRows[0]?.last_error ??
    null

  return {
    pushFailed: pushFailedRows.length,
    pushDelivered: ((pushDeliveredRes?.data ?? []) as unknown[]).length,
    tasksFailed: taskFailedRows.length,
    lastReason,
    unreadable,
    reasons,
  }
}

/** The platform's own AI reception line — calls, prospect conversions, and
 *  stalled sessions (in_progress >24h = the webhooks stopped closing rows). */
async function loadPlatformReception(svc: any, now: Date): Promise<{ calls7d: number; prospects7d: number; stalled: number }> {
  const weekAgo = new Date(now.getTime() - 7 * 86400_000).toISOString()
  const dayAgo = new Date(now.getTime() - 86400_000).toISOString()
  const [{ count: calls7d }, { count: prospects7d }, { count: stalled }] = await Promise.all([
    svc.from("platform_reception_calls").select("id", { count: "exact", head: true }).gte("started_at", weekAgo),
    svc.from("platform_reception_calls").select("id", { count: "exact", head: true }).gte("started_at", weekAgo).not("prospect_id", "is", null),
    svc.from("platform_reception_calls").select("id", { count: "exact", head: true }).eq("status", "in_progress").lt("started_at", dayAgo),
  ])
  return { calls7d: calls7d ?? 0, prospects7d: prospects7d ?? 0, stalled: stalled ?? 0 }
}

export interface OsSentinelSweepResult {
  overall: SubsystemStatus
  breachingSubsystems: string[]
  escalated: boolean
  rotationEscalated: boolean
}

/**
 * The Sentinel's REFLEX — turns observe into observe→escalate. On an overall
 * breach it escalates a deduped brief (once per ISO day) to platform staff naming
 * the breaching subsystems + top incidents, and folds in the previously-orphaned
 * credential-rotation escalation so one platform heartbeat covers both. Best-effort;
 * never throws (a monitoring sweep must not take down its host cron).
 */
export async function runOsSentinelSweep(client?: any, now: Date = new Date()): Promise<OsSentinelSweepResult> {
  const { createServiceClient } = await import("@/lib/supabase/service")
  const svc = client ?? createServiceClient()

  let rotationEscalated = false
  try {
    const { escalateRotationRisks } = await import("@/lib/security/credential-rotation")
    rotationEscalated = (await escalateRotationRisks(svc, now)).escalated
  } catch { /* best-effort */ }

  let health: OsHealth
  try { health = await loadOsHealth(svc, now) }
  catch { return { overall: "ok", breachingSubsystems: [], escalated: false, rotationEscalated } }

  const breaching = health.subsystems.filter((s) => s.status === "breach")
  if (health.overall !== "breach" || breaching.length === 0) {
    return { overall: health.overall, breachingSubsystems: [], escalated: false, rotationEscalated }
  }

  let escalated = false
  try {
    // Deduped to once per ISO day — a breach alert should nudge, not spam.
    const dayStart = new Date(now.toISOString().slice(0, 10) + "T00:00:00.000Z").toISOString()
    const { count } = await svc.from("notifications").select("id", { count: "exact", head: true })
      .eq("type", "os_health_breach").gte("created_at", dayStart)
    if ((count ?? 0) === 0) {
      const incidentLines = health.topIncidents.slice(0, 5).map((i) => `• [${i.subsystem}] ${i.summary}`).join("\n")
      const { notifyPlatformStaff } = await import("@/lib/notifications/platform-staff")
      await notifyPlatformStaff(svc, {
        type: "os_health_breach",
        title: `🔴 OS health BREACH — ${breaching.map((b) => b.label).join(", ")}`,
        body: `The agentic OS is in a breach state across ${breaching.length} subsystem(s):\n${breaching.map((b) => `• ${b.label}: ${b.detail}`).join("\n")}\n\nTop open incidents:\n${incidentLines || "—"}\n\nOpen the OS Sentinel board to triage.`,
        priority: "high",
      })
      escalated = true
    }
  } catch (err) {
    console.warn("[os-sentinel] escalation failed:", (err as any)?.message)
  }

  return { overall: "breach", breachingSubsystems: breaching.map((b) => b.key), escalated, rotationEscalated }
}

async function countUnresolvedTenantFindings(svc: any): Promise<number> {
  const { count } = await svc.from("tenant_safety_findings").select("id", { count: "exact", head: true }).eq("resolved", false)
  return count ?? 0
}

async function loadSelfHeal(svc: any, now: Date): Promise<{ runs: number; replayed: number; escalated: number }> {
  const since = new Date(now.getTime() - 24 * 3_600_000).toISOString()
  const { data } = await svc.from("reaper_runs").select("reaped, escalated, ran_at").gte("ran_at", since).limit(2000)
  const rows = (data ?? []) as Array<{ reaped?: number; escalated?: number }>
  return {
    runs: rows.length,
    replayed: rows.reduce((s, r) => s + (r.reaped ?? 0), 0),
    escalated: rows.reduce((s, r) => s + (r.escalated ?? 0), 0),
  }
}

async function loadRedTeam(svc: any, now: Date): Promise<{ lastRegressionAt: string | null }> {
  const since = new Date(now.getTime() - 7 * 24 * 3_600_000).toISOString()
  const { data } = await svc.from("notifications").select("created_at").eq("type", "manager_eval_regression").gte("created_at", since).order("created_at", { ascending: false }).limit(1)
  const row = (data ?? [])[0] as { created_at?: string } | undefined
  return { lastRegressionAt: row?.created_at ?? null }
}
