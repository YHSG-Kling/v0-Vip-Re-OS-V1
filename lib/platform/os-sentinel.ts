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
  topIncidents: OsIncident[]
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

  const [aiOps, managerOps, rotationRisks, tenantFindings, reaperAgg, redTeam] = await Promise.all([
    safe((async () => (await import("@/lib/platform/ai-ops")).loadAiOps(svc, now))(), null as any),
    safe((async () => (await import("@/lib/platform/manager-ops")).loadManagerOps(svc))(), null as any),
    safe((async () => (await import("@/lib/security/credential-rotation")).loadRotationRisks(svc))(), [] as any[]),
    safe(countUnresolvedTenantFindings(svc), 0),
    safe(loadSelfHeal(svc, now), { runs: 0, replayed: 0, escalated: 0 }),
    safe(loadRedTeam(svc, now), { lastRegressionAt: null as string | null }),
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

  return rollupOsHealth({
    generatedAt,
    aiOps: { stuck: aiSummary.stuck, held: aiSummary.held, failed: aiSummary.failed, errors: aiSummary.errors, cronsFailing: aiSummary.cronsFailing },
    managerSlo: { breaching: mgrSummary.breaching ?? 0, warning: mgrSummary.warning ?? 0 },
    expiredCredentials: expired,
    expiringCredentials: expiring,
    tenantIsolationFindings: tenantFindings,
    selfHeal: reaperAgg,
    redTeam,
    topIncidents,
  })
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
