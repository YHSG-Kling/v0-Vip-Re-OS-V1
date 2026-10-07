// lib/kernel/os-health.ts
// ─────────────────────────────────────────────────────────────────────────────
// THE OS HEALTH SUPERVISOR (wave 108, lane 108C; owner: "Cron Manager = operational-health
// coordinator … recovery policy transient→retry, rate limit→backoff, provider failure→failover,
// stuck workflow→resume, data conflict→Data Steward, compliance→Compliance Manager, financial
// discrepancy→Finance Manager + HALT, unknown→human").
//
// NOT A FOURTH SYSTEM (LAW 1/2). This module owns exactly three things nothing else had:
//   1. DETECTORS that READ the survivors (each names its survivor below) and turn what they hold
//      into typed incidents for ONE tenant;
//   2. a PURE RECOVERY POLICY (decideRecovery) mapping each incident class to one recovery;
//   3. an EXECUTOR that performs the recovery THROUGH the survivor that owns it — the signal
//      reaper's bounded replay, the 104A amount-drift reconciler, the workflow engine's advanceRun,
//      the capability router (routeCapability), the manager bus (publishManagerSignal), the tenant
//      policy writer (mergeBrokerageSettings → appendTenantPolicyVersion) and the Exception Center
//      (self_heal_events) — never a parallel path.
// It runs as ONE entry of the reaper net (lib/intelligence/reaper-net.ts, lane "health") on the
// existing 30-minute manager-signals tick, so its sweep lands in reaper_runs like every reaper.
//
// SURVIVORS READ (one per detector):
//   provider_failures        lib/agentic-os/connector-gateway.ts loadProviderHealth (api_response_logs)
//                            + vendor_usage_tracking (does THIS tenant use the provider) + routeCapability
//   stale_missions           missions (m710) — the mission controller's own rows
//   stuck_workflows          workflow_runs + workflow_run_steps (the chain engine)
//   failed_webhooks          tenant_webhook_deliveries (lib/platform/tenant-webhooks.ts drain outcomes)
//   missing_reconciliations  reaper_runs (commission_amount_drift has run) + outcome_reconciliations
//                            (verdict 'contradicted' = a data conflict the reconciler found)
//   usage_inconsistencies    meter_readings (lib/finance/usage-metering.ts) vs ai_tool_usage
//   billing_drift            reaper_runs (commission_amount_drift escalated) → reconcileSummariesAgainstLedger
//   event_backlog            manager_signals (open past the reaper window) + event_processing_log failures
//   ai_anomalies             ai_tool_usage per manager → lib/platform/manager-ops.ts classifyManagerSlo
//   media_render_failures    remotion_composition_renders → lib/remotion/render-decision.ts
//                            shouldAutoRequeueFailedRender + video_render_log failures
//   compliance_flags         reaper_runs (compliance_flags_stuck escalated — the compliance reaper)
// Wave 137E (BREADTH — the non-listing domains, each with a readable failure signal on its survivor):
//   portal_invites           portal_contact_invites (status pending|sent past expires_at — the row contradicts its clock)
//   esign_requests           signature_requests (sent|partially_signed past expires_at — a stuck signature, deal step)
//   direct_mail_returns      direct_mail_recipients (delivery_status failed|returned — a bad address is a data conflict)
//   sequence_send_failures   sequence_step_executions (status failed, 24h, per provider — a send never re-sent blind)
//   transaction_deadlines    transaction_deadlines (status pending past deadline_date — contract exposure → Compliance)
//   payments_sync            accounting_sync_log (failed, or running > 2h — books; Finance reviews, nothing halted)
//
// NEVER: auto-correct money (a financial discrepancy HALTS the affected writer and hands Finance the
// evidence); retry a non-idempotent action (an in-flight step, a handler, a send — those escalate);
// retry past OS_HEALTH_RETRY_CAP; read or write outside the tenant it was handed.

import type { ManagerKey } from "@/lib/kernel/manager-registry"

type Svc = any // the injected service client (the caller gates; the net hands a verified brokerageId)

// ── Vocabulary ──────────────────────────────────────────────────────────────────────────────

/** @proofSeam the proof iterates every class to prove each maps to its recovery */
export const INCIDENT_CLASSES = [
  "transient", "rate_limit", "provider_failure", "stuck_workflow",
  "data_conflict", "compliance", "financial_discrepancy", "unknown",
] as const
export type IncidentClass = (typeof INCIDENT_CLASSES)[number]

/** @proofSeam the proof proves every registered detector exists and the registry is complete */
export const HEALTH_DETECTORS = [
  "provider_failures", "stale_missions", "stuck_workflows", "failed_webhooks",
  "missing_reconciliations", "usage_inconsistencies", "billing_drift", "event_backlog",
  "ai_anomalies", "media_render_failures", "compliance_flags",
  // wave 137E breadth
  "portal_invites", "esign_requests", "direct_mail_returns", "sequence_send_failures", "transaction_deadlines", "payments_sync",
] as const
export type HealthDetector = (typeof HEALTH_DETECTORS)[number]

const RECOVERY_ACTIONS = [
  "retry", "backoff", "failover", "resume",
  "route_data_steward", "route_compliance", "halt_and_route_finance", "escalate_human",
] as const
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number]

/** Bounded retry: the most times the supervisor re-runs one incident's idempotent recovery in 24h. */
/** @proofSeam the proof drives the retry bound to exactly this cap */
export const OS_HEALTH_RETRY_CAP = 3
/** Backoff base / ceiling (exponential: base × 2^attempt, capped). */
const OS_HEALTH_BACKOFF_BASE_MS = 5 * 60_000
const OS_HEALTH_BACKOFF_MAX_MS = 6 * 3_600_000

// ── FINANCIAL WRITERS the supervisor may HALT (the kill switch lives in tenant policy) ───────

/**
 * Every automated money writer a financial discrepancy can halt, with the file that HONORS the halt
 * (loadFinancialWriterHalt is read at its entry; a halted tenant is skipped, never "corrected").
 */
export const FINANCIAL_WRITERS = {
  commission_tracking_heal: { label: "Commission tracking auto-heal", honoredBy: "lib/finance/commission-tracking-reaper.ts reapCommissionTrackingDrift (summary-paid → ledger lock)" },
  brokerage_earnings:       { label: "Brokerage earnings rollup",      honoredBy: "lib/finance/brokerage-earnings-writer.ts runBrokerageEarningsRollup" },
  usage_metering:           { label: "Usage metering rollup",          honoredBy: "lib/finance/usage-metering.ts runUsageMeteringRollup" },
} as const
export type FinancialWriterKey = keyof typeof FINANCIAL_WRITERS

/** The registered tenant policy key (lib/kernel/tenant-policy.ts TENANT_POLICY_SETTINGS_KEYS). */
/** @proofSeam the proof asserts the halt is versioned under this registered policy key */
export const FINANCIAL_WRITER_HALTS_POLICY_KEY = "financial_writer_halts"

/** Which writer owns each 104A summary projection (reconcile-tracking.ts SummaryProjection). */
const PROJECTION_WRITER: Record<string, FinancialWriterKey> = {
  "agent_commissions.net_to_agent": "commission_tracking_heal",
  "agent_commissions.net_to_brokerage": "commission_tracking_heal",
  "transaction_commissions.calculated_amount": "commission_tracking_heal",
  "agents.ytd_gci": "commission_tracking_heal",
  "brokerage_earnings.gross_commission_income": "brokerage_earnings",
  "brokerage_earnings.brokerage_net": "brokerage_earnings",
  "meter_readings.total_cost_cents": "usage_metering",
}

// ── Incident + decision shapes ──────────────────────────────────────────────────────────────

export interface HealthIncident {
  detector: HealthDetector
  class: IncidentClass
  brokerageId: string
  /** Stable per incident across ticks — the dedupe + retry-count key (`<kind>:<id>`). */
  subjectKey: string
  /** A uuid subject when there is one (ledger subject_id); null otherwise (subject_ref carries the key). */
  subjectId: string | null
  subjectType: string
  summary: string
  /** Can the recovery run again without a second side effect? A false NEVER retries. */
  idempotent: boolean
  /** stuck_workflow only — the next step never started, so the engine can resume it safely. */
  resumable?: boolean
  /** provider_failure only — a healthy provider remains for every capability this one serves. */
  failoverAvailable?: boolean
  /** rate_limit only — the provider / rail's own next-attempt time, when it states one. */
  retryAfter?: string | null
  /** financial_discrepancy only — the writer the discrepancy came from. */
  financialWriter?: FinancialWriterKey
  /** Who performs the retry when it is not the supervisor (the rail that owns it). */
  retryOwner?: string | null
  evidence: Record<string, unknown>
}

export interface RecoveryDecision {
  action: RecoveryAction
  /** The manager the recovery is routed to, or "human". */
  routedTo: ManagerKey | "human"
  /** financial_discrepancy only — the writer to halt. */
  halt: FinancialWriterKey | null
  /** backoff only — wait this long before the next attempt. */
  delayMs: number | null
  /** The attempt number this decision is (priorAttempts + 1). */
  attempt: number
  reason: string
}

const human = (attempt: number, reason: string): RecoveryDecision =>
  ({ action: "escalate_human", routedTo: "human", halt: null, delayMs: null, attempt, reason })

/**
 * PURE — THE RECOVERY POLICY. One incident + how many recoveries it already had in the window →
 * the ONE recovery. Order of the rules is the safety order: money and compliance never retry;
 * a non-idempotent action never retries; the retry bound beats every automatic path.
 */
/** @proofSeam the pure recovery policy the proof asserts class by class (the supervisor is its product caller) */
export function decideRecovery(incident: HealthIncident, ctx: { priorAttempts: number }): RecoveryDecision {
  const prior = Math.max(0, Math.floor(ctx.priorAttempts || 0))
  const attempt = prior + 1
  switch (incident.class) {
    case "financial_discrepancy": {
      // NEVER auto-correct money: halt the writer the drift came from, Finance reviews the evidence.
      const writer = incident.financialWriter ?? null
      return {
        action: "halt_and_route_finance", routedTo: "finance_manager", halt: writer, delayMs: null, attempt,
        reason: writer
          ? `financial discrepancy — ${FINANCIAL_WRITERS[writer].label} HALTED for this tenant until Finance reviews; the OS never corrects money`
          : "financial discrepancy with no attributable writer — nothing halted, Finance reviews the evidence; the OS never corrects money",
      }
    }
    case "compliance":
      return { action: "route_compliance", routedTo: "compliance_officer", halt: null, delayMs: null, attempt, reason: "compliance problem — routed to the Compliance Manager; the OS never resolves a compliance finding itself" }
    case "data_conflict":
      return { action: "route_data_steward", routedTo: "data_steward", halt: null, delayMs: null, attempt, reason: "data conflict — routed to the Data Steward (provider truth vs the OS's own record); never overwritten automatically" }
    case "unknown":
      return human(attempt, "unknown failure — no proven-safe automatic recovery; a human decides")
    case "transient": {
      if (!incident.idempotent) return human(attempt, "transient failure on a NON-idempotent action — never retried (a retry could act twice); a human decides")
      if (prior >= OS_HEALTH_RETRY_CAP) return human(attempt, `retry bound reached (${prior}/${OS_HEALTH_RETRY_CAP} in 24h) — still failing, a human decides`)
      return { action: "retry", routedTo: "cron_manager", halt: null, delayMs: null, attempt, reason: `transient failure on an idempotent recovery — retry ${attempt}/${OS_HEALTH_RETRY_CAP}` }
    }
    case "rate_limit": {
      if (!incident.idempotent) return human(attempt, "rate-limited NON-idempotent action — never retried; a human decides")
      if (prior >= OS_HEALTH_RETRY_CAP) return human(attempt, `still rate-limited after ${prior} backoffs — a human decides (plan / quota)`)
      const stated = incident.retryAfter ? Date.parse(incident.retryAfter) - Date.now() : NaN
      const computed = Math.min(OS_HEALTH_BACKOFF_MAX_MS, OS_HEALTH_BACKOFF_BASE_MS * 2 ** prior)
      const delayMs = Number.isFinite(stated) && stated > 0 ? Math.min(OS_HEALTH_BACKOFF_MAX_MS, Math.max(stated, computed)) : computed
      return { action: "backoff", routedTo: "cron_manager", halt: null, delayMs, attempt, reason: `rate limited — back off ${Math.round(delayMs / 60_000)} min (attempt ${attempt}/${OS_HEALTH_RETRY_CAP})` }
    }
    case "provider_failure": {
      if (!incident.idempotent) return human(attempt, "provider failure on a NON-idempotent action — never re-sent through another provider; a human decides")
      if (!incident.failoverAvailable) return human(attempt, "provider failure with NO healthy alternative in the capability's provider chain — a human decides")
      return { action: "failover", routedTo: "cron_manager", halt: null, delayMs: null, attempt, reason: "provider failing — the capability router (routeCapability) routes around it to the next provider in the chain" }
    }
    case "stuck_workflow": {
      if (!incident.resumable) return human(attempt, "stuck workflow whose current step is IN FLIGHT or not engine-resumable — never re-run blind; a human (or its owner manager) decides")
      if (prior >= OS_HEALTH_RETRY_CAP) return human(attempt, `resume bound reached (${prior}/${OS_HEALTH_RETRY_CAP}) — the chain keeps stalling, a human decides`)
      return { action: "resume", routedTo: "campaign_orchestrator", halt: null, delayMs: null, attempt, reason: "stuck workflow whose next step never started — resumed through the workflow engine (advanceRun)" }
    }
  }
}

// ── The financial-writer kill switch (tenant policy, versioned — LAW 5) ─────────────────────

export interface FinancialWriterHalt { halted: boolean; reason: string | null; incident: string | null; setAt: string | null; readable: boolean }

/** PURE — read one writer's halt out of brokerage_settings.settings. */
function readFinancialWriterHalt(settings: Record<string, unknown> | null | undefined, writer: FinancialWriterKey): FinancialWriterHalt {
  const all = (settings?.[FINANCIAL_WRITER_HALTS_POLICY_KEY] ?? null) as Record<string, any> | null
  const h = all && typeof all === "object" ? all[writer] : null
  if (!h || typeof h !== "object" || h.halted !== true) return { halted: false, reason: null, incident: null, setAt: null, readable: true }
  return { halted: true, reason: typeof h.reason === "string" ? h.reason : null, incident: typeof h.incident === "string" ? h.incident : null, setAt: typeof h.set_at === "string" ? h.set_at : null, readable: true }
}

/**
 * Is this financial writer halted for this tenant? FAILS CLOSED (CLAUDE.md §4): a settings read that
 * is refused reports halted — a money writer that cannot prove it is allowed does not write.
 */
export async function loadFinancialWriterHalt(svc: Svc, brokerageId: string, writer: FinancialWriterKey): Promise<FinancialWriterHalt> {
  if (!brokerageId) return { halted: true, reason: "no tenant", incident: null, setAt: null, readable: false }
  try {
    const { data, error } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
    if (error) return { halted: true, reason: `halt state unreadable (${error.message}) — refusing to write money blind`, incident: null, setAt: null, readable: false }
    return readFinancialWriterHalt(((data as { settings?: Record<string, unknown> } | null)?.settings) ?? null, writer)
  } catch (e) {
    return { halted: true, reason: `halt state unreadable (${(e as Error).message}) — refusing to write money blind`, incident: null, setAt: null, readable: false }
  }
}

/** Halt one writer for one tenant through THE ONE settings writer (versioned, actor cron_manager). Idempotent. */
/** @proofSeam the default halt executor; the proof drives it directly against an in-memory settings row */
export async function haltFinancialWriter(
  svc: Svc,
  input: { brokerageId: string; writer: FinancialWriterKey; reason: string; incident: string },
): Promise<{ ok: true; alreadyHalted: boolean } | { ok: false; error: string }> {
  const current = await loadFinancialWriterHalt(svc, input.brokerageId, input.writer)
  if (current.readable && current.halted) return { ok: true, alreadyHalted: true }
  const { mergeBrokerageSettings } = await import("@/lib/settings/brokerage-settings-merge")
  const write = await mergeBrokerageSettings(svc, input.brokerageId, (settings) => {
    const prev = (settings[FINANCIAL_WRITER_HALTS_POLICY_KEY] && typeof settings[FINANCIAL_WRITER_HALTS_POLICY_KEY] === "object" ? settings[FINANCIAL_WRITER_HALTS_POLICY_KEY] : {}) as Record<string, unknown>
    return { [FINANCIAL_WRITER_HALTS_POLICY_KEY]: { ...prev, [input.writer]: { halted: true, reason: input.reason.slice(0, 500), incident: input.incident, set_by: "cron_manager", set_at: new Date().toISOString() } } }
  }, { policy: { type: "manager", managerKey: "cron_manager", userId: null, reason: `os health: halt ${input.writer} — ${input.reason}`.slice(0, 500) } })
  if (!write.ok) return { ok: false, error: write.error }
  return { ok: true, alreadyHalted: false }
}

/** Who may release a halt (wave 137 owner ruling: "platform staff may release a financial halt (with evidence)"). */
const HALT_RELEASERS = ["tenant_finance", "platform_staff"] as const
type HaltReleaser = (typeof HALT_RELEASERS)[number]

/**
 * Release a halt — called ONLY by the two gated doors: the tenant finance-admin action
 * (app/actions/os-health.ts, session tenant) and, since wave 137, the PLATFORM door
 * (app/actions/superadmin/financial-halts.ts, platform 'billing' write capability). A platform release
 * REQUIRES evidence (what reconciled the discrepancy) and refuses a writer that is not halted (or whose
 * halt state cannot be read — fail closed). Both are versioned tenant-policy changes attributed to the
 * session user (LAW 5); the entry names who released it and as what.
 */
export async function releaseFinancialWriterHalt(
  svc: Svc,
  input: { brokerageId: string; writer: FinancialWriterKey; userId: string; reason: string; releasedAs?: HaltReleaser; evidence?: string | null },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const as: HaltReleaser = input.releasedAs ?? "tenant_finance"
  const evidence = String(input.evidence ?? "").trim()
  if (as === "platform_staff") {
    if (evidence.length < 10) return { ok: false, error: "A platform release needs evidence — name what reconciled the discrepancy (a reconciliation id, ledger rows, a ticket)." }
    const cur = await loadFinancialWriterHalt(svc, input.brokerageId, input.writer)
    if (!cur.readable) return { ok: false, error: `halt state unreadable — nothing released (${cur.reason})` }
    if (!cur.halted) return { ok: false, error: `${input.writer} is not halted for this brokerage — nothing to release` }
  }
  const { mergeBrokerageSettings } = await import("@/lib/settings/brokerage-settings-merge")
  const write = await mergeBrokerageSettings(svc, input.brokerageId, (settings) => {
    const prev = (settings[FINANCIAL_WRITER_HALTS_POLICY_KEY] && typeof settings[FINANCIAL_WRITER_HALTS_POLICY_KEY] === "object" ? settings[FINANCIAL_WRITER_HALTS_POLICY_KEY] : {}) as Record<string, unknown>
    return { [FINANCIAL_WRITER_HALTS_POLICY_KEY]: { ...prev, [input.writer]: { halted: false, released_by: input.userId, released_at: new Date().toISOString(), release_reason: input.reason.slice(0, 500), released_as: as, ...(evidence ? { release_evidence: evidence.slice(0, 1000) } : {}) } } }
  }, { policy: { type: "user", userId: input.userId, reason: `${as === "platform_staff" ? "platform staff " : ""}release ${input.writer} halt — ${input.reason}${evidence ? ` (evidence: ${evidence})` : ""}`.slice(0, 500) } })
  return write.ok ? { ok: true } : { ok: false, error: write.error }
}

/** Platform read: every tenant whose settings carry a HALTED financial writer (platform door only). */
export async function listHaltedFinancialWriters(svc: Svc, limit = 200): Promise<{ ok: true; rows: Array<{ brokerageId: string; writer: FinancialWriterKey; reason: string | null; incident: string | null; setAt: string | null }> } | { ok: false; error: string }> {
  const { data, error } = await svc.from("brokerage_settings").select("brokerage_id, settings").not(`settings->${FINANCIAL_WRITER_HALTS_POLICY_KEY}`, "is", null).limit(limit)
  if (error) return { ok: false, error: error.message ?? "refused" }
  const rows: Array<{ brokerageId: string; writer: FinancialWriterKey; reason: string | null; incident: string | null; setAt: string | null }> = []
  for (const r of (data ?? []) as Array<{ brokerage_id: string; settings: Record<string, unknown> | null }>) {
    for (const w of Object.keys(FINANCIAL_WRITERS) as FinancialWriterKey[]) {
      const h = readFinancialWriterHalt(r.settings ?? null, w)
      if (h.halted) rows.push({ brokerageId: r.brokerage_id, writer: w, reason: h.reason, incident: h.incident, setAt: h.setAt })
    }
  }
  return { ok: true, rows }
}

// ── Detectors (each reads its survivor, every read pinned to the tenant) ────────────────────

interface DetectorResult { detector: HealthDetector; readable: boolean; error: string | null; incidents: HealthIncident[] }

export interface DetectorDeps {
  now: Date
  /** connector-gateway.ts loadProviderHealth — injected by the proof. */
  providerHealth?: (provider: string) => Promise<{ state: string; routeAround: boolean; reason: string; cooldownUntil?: string | null }>
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const uuidOr = (v: unknown): string | null => (typeof v === "string" && UUID_RE.test(v) ? v : null)
const iso = (d: Date) => d.toISOString()
const hoursAgo = (now: Date, h: number) => new Date(now.getTime() - h * 3_600_000)

type Detector = (svc: Svc, brokerageId: string, deps: DetectorDeps) => Promise<HealthIncident[]>

const incident = (b: string, detector: HealthDetector, cls: IncidentClass, x: Omit<HealthIncident, "detector" | "class" | "brokerageId">): HealthIncident =>
  ({ detector, class: cls, brokerageId: b, ...x })

/** Throw a read refusal so the runner marks the detector UNREADABLE (never "checked and fine"). */
function must<T>(res: { data: T | null; error: { message?: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what} read refused: ${res.error.message ?? "unknown"}`)
  return (res.data ?? ([] as unknown)) as T
}

/** @proofSeam the proof scans this registry's stripped source for the tenant predicate */
export const DETECTORS: Record<HealthDetector, Detector> = {
  // provider health is platform-wide evidence; the incident is THIS tenant's only when it uses the provider.
  provider_failures: async (svc, b, deps) => {
    const { CONTACT_PROVIDER_ROUTES, routeCapability } = await import("@/lib/ai-isa/property-lookup-rail")
    const providers = Array.from(new Set(Object.values(CONTACT_PROVIDER_ROUTES).flat().map((e) => e.provider)))
    const usage = must(await svc.from("vendor_usage_tracking").select("vendor_name").eq("brokerage_id", b).gte("created_at", iso(hoursAgo(deps.now, 24 * 7))).limit(2000), "vendor_usage_tracking") as Array<{ vendor_name: string | null }>
    const used = new Set(usage.map((u) => String(u.vendor_name ?? "").toLowerCase()))
    const healthFn = deps.providerHealth ?? (async (p: string) => (await import("@/lib/agentic-os/connector-gateway")).loadProviderHealth(p, deps.now))
    const health: Record<string, { state: string; routeAround: boolean; reason: string; cooldownUntil?: string | null }> = {}
    for (const p of providers) health[p] = await healthFn(p)
    const out: HealthIncident[] = []
    for (const p of providers) {
      if (![...used].some((v) => v.includes(p))) continue // this tenant never asks this provider
      const h = health[p]
      if (h.state !== "failing" && h.state !== "rate_limited") continue
      const capabilities = (Object.keys(CONTACT_PROVIDER_ROUTES) as Array<keyof typeof CONTACT_PROVIDER_ROUTES>).filter((c) => CONTACT_PROVIDER_ROUTES[c].some((e) => e.provider === p))
      const routes = capabilities.map((c) => routeCapability(c, health as any))
      const failoverAvailable = routes.length > 0 && routes.every((r) => r.providers.length > 0)
      out.push(incident(b, "provider_failures", h.state === "rate_limited" ? "rate_limit" : "provider_failure", {
        subjectKey: `provider:${p}`, subjectId: null, subjectType: "provider",
        summary: `${p} is ${h.state}: ${h.reason}`,
        idempotent: true, // every capability on the route table is a READ lookup
        failoverAvailable, retryAfter: h.cooldownUntil ?? null,
        evidence: { provider: p, state: h.state, reason: h.reason, routes: routes.map((r) => ({ capability: r.capability, providers: r.providers, skipped: r.skipped })) },
      }))
    }
    return out
  },

  stale_missions: async (svc, b, deps) => {
    const rows = must(await svc.from("missions").select("id, state, deadline, state_changed_at, owner_manager, objective")
      .eq("brokerage_id", b).in("state", ["ACTIVE", "WAITING", "BLOCKED", "ESCALATED"]).limit(500), "missions") as Array<{ id: string; state: string; deadline: string | null; state_changed_at: string | null; owner_manager: string | null; objective: string | null }>
    const out: HealthIncident[] = []
    for (const m of rows) {
      const pastDeadline = !!m.deadline && Date.parse(m.deadline) < deps.now.getTime()
      const escalatedUnanswered = m.state === "ESCALATED" && !!m.state_changed_at && Date.parse(m.state_changed_at) < hoursAgo(deps.now, 72).getTime()
      if (!pastDeadline && !escalatedUnanswered) continue
      out.push(incident(b, "stale_missions", "stuck_workflow", {
        subjectKey: `mission:${m.id}`, subjectId: uuidOr(m.id), subjectType: "mission",
        summary: `mission "${(m.objective ?? "").slice(0, 80)}" is ${m.state}${pastDeadline ? " past its deadline" : " and unanswered for 72h+"}`,
        idempotent: false, resumable: false, // a mission is resumed by its owner manager or a human — never re-planned here
        evidence: { state: m.state, deadline: m.deadline, owner_manager: m.owner_manager, state_changed_at: m.state_changed_at },
      }))
    }
    return out
  },

  // 30 min idle → resume window; the stale-run reaper (2h) still owns the hard stall.
  stuck_workflows: async (svc, b, deps) => {
    const runs = must(await svc.from("workflow_runs").select("id, chain_key, status, current_step_index, updated_at, started_at")
      .eq("brokerage_id", b).eq("status", "running").lt("updated_at", iso(new Date(deps.now.getTime() - 30 * 60_000))).limit(100), "workflow_runs") as Array<{ id: string; chain_key: string | null; status: string; current_step_index: number | null; updated_at: string | null }>
    if (runs.length === 0) return []
    const steps = must(await svc.from("workflow_run_steps").select("run_id, step_index, status").in("run_id", runs.map((r) => r.id)).limit(2000), "workflow_run_steps") as Array<{ run_id: string; step_index: number; status: string }>
    return runs.map((r) => {
      const step = steps.find((s) => s.run_id === r.id && s.step_index === (r.current_step_index ?? 0))
      const resumable = !step || step.status === "pending" // the engine died BETWEEN steps — nothing in flight
      return incident(b, "stuck_workflows", "stuck_workflow", {
        subjectKey: `workflow_run:${r.id}`, subjectId: uuidOr(r.id), subjectType: "workflow_run",
        summary: `"${r.chain_key ?? "automation"}" idle since ${r.updated_at} at step ${r.current_step_index ?? 0} (${step?.status ?? "no step row"})`,
        idempotent: resumable, resumable,
        evidence: { chain_key: r.chain_key, current_step_index: r.current_step_index, step_status: step?.status ?? null, updated_at: r.updated_at },
      })
    })
  },

  failed_webhooks: async (svc, b, deps) => {
    const rows = must(await svc.from("tenant_webhook_deliveries").select("id, subscription_id, status, attempts, next_attempt_at, error_detail")
      .eq("brokerage_id", b).in("status", ["failed", "dead"]).gte("created_at", iso(hoursAgo(deps.now, 24 * 7))).limit(500), "tenant_webhook_deliveries") as Array<{ id: string; subscription_id: string; status: string; attempts: number | null; next_attempt_at: string | null; error_detail: string | null }>
    const bySub = new Map<string, typeof rows>()
    for (const r of rows) bySub.set(r.subscription_id, [...(bySub.get(r.subscription_id) ?? []), r])
    const out: HealthIncident[] = []
    for (const [sub, list] of bySub) {
      const dead = list.filter((r) => r.status === "dead")
      if (dead.length > 0) {
        out.push(incident(b, "failed_webhooks", "unknown", {
          subjectKey: `webhook_subscription:${sub}`, subjectId: uuidOr(sub), subjectType: "tenant_webhook_subscription",
          summary: `${dead.length} webhook deliver${dead.length === 1 ? "y" : "ies"} dead after the drain's retries — ${String(dead[0].error_detail ?? "").slice(0, 120)}`,
          idempotent: false, evidence: { dead: dead.length, last_error: dead[0].error_detail },
        }))
        continue
      }
      // Still failing, on the drain's own backoff schedule (nextAttemptDelayMs) — the rail owns the retry.
      const next = list.map((r) => r.next_attempt_at).filter(Boolean).sort().pop() ?? null
      out.push(incident(b, "failed_webhooks", "rate_limit", {
        subjectKey: `webhook_subscription:${sub}`, subjectId: uuidOr(sub), subjectType: "tenant_webhook_subscription",
        summary: `${list.length} webhook deliver${list.length === 1 ? "y" : "ies"} failing, next attempt ${next ?? "unscheduled"}`,
        idempotent: true, retryAfter: next, retryOwner: "lib/platform/tenant-webhooks.ts drainTenantWebhookDeliveries",
        evidence: { failing: list.length, max_attempts_seen: Math.max(...list.map((r) => r.attempts ?? 0)) },
      }))
    }
    return out
  },

  missing_reconciliations: async (svc, b, deps) => {
    const out: HealthIncident[] = []
    const [runs, books, contradicted] = await Promise.all([
      svc.from("reaper_runs").select("ran_at").eq("brokerage_id", b).eq("domain", "commission_amount_drift").gte("ran_at", iso(hoursAgo(deps.now, 48))).limit(1),
      svc.from("agent_commissions").select("id").eq("brokerage_id", b).limit(1),
      svc.from("outcome_reconciliations").select("id, entity_type, entity_id, channel, claimed_status, provider_status, explanation")
        .eq("brokerage_id", b).eq("verdict", "contradicted").is("escalated_at", null).limit(50),
    ])
    const ran = must(runs, "reaper_runs") as unknown[]
    const hasBooks = (must(books, "agent_commissions") as unknown[]).length > 0
    if (hasBooks && ran.length === 0) {
      out.push(incident(b, "missing_reconciliations", "transient", {
        subjectKey: "reconciler:commission_amount_drift", subjectId: null, subjectType: "reconciler",
        summary: "the ledger-vs-summary reconciliation has not run for this tenant in 48h",
        idempotent: true, // reapCommissionAmountDrift only READS + escalates (deduped) — it never rewrites money
        evidence: { domain: "commission_amount_drift", window_hours: 48 },
      }))
    }
    for (const c of must(contradicted, "outcome_reconciliations") as Array<{ id: string; entity_type: string | null; entity_id: string | null; channel: string | null; claimed_status: string | null; provider_status: string | null; explanation: string | null }>) {
      out.push(incident(b, "missing_reconciliations", "data_conflict", {
        subjectKey: `outcome_reconciliation:${c.id}`, subjectId: uuidOr(c.id), subjectType: "outcome_reconciliation",
        summary: `${c.channel ?? "action"} claimed '${c.claimed_status}' but the provider says '${c.provider_status}'`,
        idempotent: false, evidence: { entity_type: c.entity_type, entity_id: c.entity_id, explanation: c.explanation },
      }))
    }
    return out
  },

  usage_inconsistencies: async (svc, b, deps) => {
    const periodStart = new Date(deps.now.getFullYear(), deps.now.getMonth(), 1).toISOString()
    const meters = must(await svc.from("meter_readings").select("id, meter_type, period_start, total_units, computed_at")
      .eq("brokerage_id", b).gte("period_start", periodStart).limit(200), "meter_readings") as Array<{ id: string; meter_type: string; period_start: string; total_units: number | null; computed_at: string | null }>
    const out: HealthIncident[] = []
    const seen = new Map<string, number>()
    for (const m of meters) seen.set(`${m.meter_type}|${m.period_start}`, (seen.get(`${m.meter_type}|${m.period_start}`) ?? 0) + 1)
    for (const [k, n] of seen) {
      if (n < 2) continue
      out.push(incident(b, "usage_inconsistencies", "financial_discrepancy", {
        subjectKey: `meter_duplicate:${k}`, subjectId: null, subjectType: "meter_reading",
        summary: `${n} meter readings for ${k.replace("|", " @ ")} — a doubled meter is a doubled invoice line`,
        idempotent: false, financialWriter: "usage_metering", evidence: { meter: k, readings: n },
      }))
    }
    const ai = meters.find((m) => m.meter_type === "ai_tokens")
    if (ai?.computed_at) {
      const usage = must(await svc.from("ai_tool_usage").select("tokens_used").eq("brokerage_id", b)
        .gte("created_at", ai.period_start).lte("created_at", ai.computed_at).limit(50_000), "ai_tool_usage") as Array<{ tokens_used: number | null }>
      const raw = usage.reduce((s, r) => s + (Number(r.tokens_used) || 0), 0)
      const metered = Number(ai.total_units) || 0
      const delta = Math.abs(raw - metered)
      if (delta > 1000 && delta / Math.max(raw, metered, 1) > 0.01) {
        out.push(incident(b, "usage_inconsistencies", "financial_discrepancy", {
          subjectKey: `meter:ai_tokens:${ai.period_start}`, subjectId: uuidOr(ai.id), subjectType: "meter_reading",
          summary: `ai_tokens meter says ${metered}, the ai_tool_usage ledger says ${raw} up to ${ai.computed_at}`,
          idempotent: false, financialWriter: "usage_metering", evidence: { metered, ledger: raw, delta, computed_at: ai.computed_at },
        }))
      }
    }
    return out
  },

  // Cheap gate first (did the daily amount-drift reaper escalate?), then the 104A reconciler for attribution.
  billing_drift: async (svc, b, deps) => {
    const runs = must(await svc.from("reaper_runs").select("escalated, ran_at").eq("brokerage_id", b)
      .eq("domain", "commission_amount_drift").gte("ran_at", iso(hoursAgo(deps.now, 26))).gt("escalated", 0).limit(1), "reaper_runs") as unknown[]
    if (runs.length === 0) return []
    const { reconcileSummariesAgainstLedger } = await import("@/lib/commission/reconcile-tracking")
    const rec = await reconcileSummariesAgainstLedger(svc, { brokerageId: b })
    if (!rec.measured) {
      return [incident(b, "billing_drift", "unknown", {
        subjectKey: "reconciler:summaries_unmeasured", subjectId: null, subjectType: "reconciler",
        summary: `drift was escalated but the reconciler could not read the ledger: ${rec.warnings.slice(0, 2).join("; ")}`,
        idempotent: false, evidence: { warnings: rec.warnings.slice(0, 5) },
      })]
    }
    const byWriter = new Map<FinancialWriterKey, typeof rec.drifts>()
    for (const d of rec.drifts) {
      const w = PROJECTION_WRITER[d.projection]
      if (w) byWriter.set(w, [...(byWriter.get(w) ?? []), d])
    }
    return [...byWriter.entries()].map(([w, ds]) => incident(b, "billing_drift", "financial_discrepancy", {
      subjectKey: `financial_writer:${w}`, subjectId: null, subjectType: "financial_writer",
      summary: `${ds.length} money summar${ds.length === 1 ? "y disagrees" : "ies disagree"} with the ledger (${[...new Set(ds.map((d) => d.projection))].join(", ")}), Σ|Δ| ${ds.reduce((s, d) => s + Math.abs(d.deltaCents), 0)}¢`,
      idempotent: false, financialWriter: w,
      evidence: { drifts: ds.slice(0, 10).map((d) => ({ projection: d.projection, subjectId: d.subjectId, transactionId: d.transactionId, deltaCents: d.deltaCents })) },
    }))
  },

  event_backlog: async (svc, b, deps) => {
    const { MAX_HANDLED_OPEN_HOURS } = await import("@/lib/kernel/signal-reaper-policy")
    const [open, failures] = await Promise.all([
      svc.from("manager_signals").select("id").eq("brokerage_id", b).eq("status", "open").lt("created_at", iso(hoursAgo(deps.now, MAX_HANDLED_OPEN_HOURS + 1))).limit(500),
      svc.from("event_processing_log").select("handler, error_message").eq("brokerage_id", b).eq("status", "failure").gte("created_at", iso(hoursAgo(deps.now, 24))).limit(500),
    ])
    const out: HealthIncident[] = []
    const stuck = must(open, "manager_signals") as unknown[]
    if (stuck.length > 0) {
      out.push(incident(b, "event_backlog", "transient", {
        subjectKey: "bus:open_past_window", subjectId: null, subjectType: "manager_signals",
        summary: `${stuck.length} bus signal(s) open past the ${MAX_HANDLED_OPEN_HOURS}h reaper window`,
        idempotent: true, // reapStuckManagerSignals: bounded replay (SIGNAL_AUTO_REPLAY_CAP) then expire + escalate
        evidence: { open_past_window: stuck.length },
      }))
    }
    const fails = must(failures, "event_processing_log") as Array<{ handler: string | null; error_message: string | null }>
    const byHandler = new Map<string, number>()
    for (const f of fails) byHandler.set(f.handler ?? "unknown", (byHandler.get(f.handler ?? "unknown") ?? 0) + 1)
    for (const [handler, n] of byHandler) {
      out.push(incident(b, "event_backlog", "unknown", {
        subjectKey: `event_handler:${handler}`, subjectId: null, subjectType: "event_handler",
        summary: `${n} kernel event(s) failed in handler ${handler} in 24h`,
        idempotent: false, // a handler may send / write — re-processing could act twice
        evidence: { handler, failures: n, sample: fails.find((f) => (f.handler ?? "unknown") === handler)?.error_message ?? null },
      }))
    }
    return out
  },

  ai_anomalies: async (svc, b, deps) => {
    const { classifyManagerSlo, percentile } = await import("@/lib/platform/manager-ops")
    const rows = must(await svc.from("ai_tool_usage").select("manager, cost_cents, execution_time_ms, success")
      .eq("brokerage_id", b).eq("tool_name", "ai_model").gte("created_at", iso(hoursAgo(deps.now, 24))).limit(20_000), "ai_tool_usage") as Array<{ manager: string | null; cost_cents: number | null; execution_time_ms: number | null; success: boolean | null }>
    const by = new Map<string, { calls: number; cost: number; ms: number[]; errors: number }>()
    for (const r of rows) {
      const a = by.get(r.manager ?? "unassigned") ?? { calls: 0, cost: 0, ms: [], errors: 0 }
      a.calls++; a.cost += Number(r.cost_cents) || 0
      if (Number.isFinite(r.execution_time_ms)) a.ms.push(Number(r.execution_time_ms))
      if (r.success === false) a.errors++
      by.set(r.manager ?? "unassigned", a)
    }
    const out: HealthIncident[] = []
    for (const [manager, a] of by) {
      const m = { costCents: a.cost, p95Ms: percentile(a.ms, 95), errorRate: a.calls ? a.errors / a.calls : 0 }
      if (classifyManagerSlo(m) !== "breach") continue
      out.push(incident(b, "ai_anomalies", "unknown", {
        subjectKey: `ai_manager:${manager}`, subjectId: null, subjectType: "ai_manager",
        summary: `${manager} breached its AI SLO in 24h — ${a.calls} calls, ${a.cost}¢, p95 ${m.p95Ms}ms, ${Math.round(m.errorRate * 100)}% errors`,
        idempotent: false, evidence: { manager, calls: a.calls, ...m },
      }))
    }
    return out
  },

  media_render_failures: async (svc, b, deps) => {
    const { shouldAutoRequeueFailedRender } = await import("@/lib/remotion/render-decision")
    const [renders, legacy] = await Promise.all([
      svc.from("remotion_composition_renders").select("id, composition_id, render_status, retry_count, error_message")
        .eq("brokerage_id", b).eq("render_status", "failed").gte("created_at", iso(hoursAgo(deps.now, 24 * 7))).limit(200),
      svc.from("video_render_log").select("id, provider, error_message").eq("brokerage_id", b).eq("status", "failed").gte("created_at", iso(hoursAgo(deps.now, 24))).limit(200),
    ])
    const out: HealthIncident[] = []
    for (const r of must(renders, "remotion_composition_renders") as Array<{ id: string; composition_id: string; render_status: string; retry_count: number | null; error_message: string | null }>) {
      // missingProps unknown here → [] ; the queue re-checks the content contract before it flips the row.
      const d = shouldAutoRequeueFailedRender(r, [])
      out.push(incident(b, "media_render_failures", d.requeue ? "transient" : "unknown", {
        subjectKey: `render:${r.id}`, subjectId: uuidOr(r.id), subjectType: "remotion_composition_render",
        summary: `render ${r.composition_id} failed — ${d.reason}`,
        idempotent: d.requeue, retryOwner: d.requeue ? "app/api/cron/composition-render-queue/route.ts (guarded failed→queued flip)" : null,
        evidence: { composition_id: r.composition_id, retry_count: r.retry_count, error: r.error_message },
      }))
    }
    const lf = must(legacy, "video_render_log") as Array<{ id: string; provider: string | null; error_message: string | null }>
    if (lf.length > 0) {
      out.push(incident(b, "media_render_failures", "unknown", {
        subjectKey: "video_render_log:failed_24h", subjectId: null, subjectType: "video_render_log",
        summary: `${lf.length} provider video render(s) failed in 24h (${[...new Set(lf.map((x) => x.provider ?? "?"))].join(", ")})`,
        idempotent: false, evidence: { failures: lf.length, sample: lf[0].error_message },
      }))
    }
    return out
  },

  compliance_flags: async (svc, b, deps) => {
    const runs = must(await svc.from("reaper_runs").select("escalated, ran_at").eq("brokerage_id", b)
      .eq("domain", "compliance_flags_stuck").gt("escalated", 0).gte("ran_at", iso(hoursAgo(deps.now, 26))).order("ran_at", { ascending: false }).limit(1), "reaper_runs") as Array<{ escalated: number; ran_at: string }>
    if (runs.length === 0) return []
    return [incident(b, "compliance_flags", "compliance", {
      subjectKey: "compliance:flags_past_sla", subjectId: null, subjectType: "compliance_flags",
      summary: `${runs[0].escalated} Fair-Housing / consent flag(s) sat unreviewed past SLA (compliance reaper, ${runs[0].ran_at})`,
      idempotent: false, evidence: { escalated: runs[0].escalated, ran_at: runs[0].ran_at },
    })]
  },

  // ── wave 137E breadth: the non-listing domains ────────────────────────────────────────────
  // An invite whose row still says open while its own expiry has passed: the record contradicts itself
  // (Data Steward reconciles it; re-inviting is a SEND — never automatic).
  portal_invites: async (svc, b, deps) => {
    const rows = must(await svc.from("portal_contact_invites").select("id, contact_id, status, expires_at, portal_view")
      .eq("brokerage_id", b).in("status", ["pending", "sent"]).lt("expires_at", iso(deps.now)).limit(200), "portal_contact_invites") as Array<{ id: string; contact_id: string | null; status: string; expires_at: string | null; portal_view: string | null }>
    if (rows.length === 0) return []
    return [incident(b, "portal_invites", "data_conflict", {
      subjectKey: "portal_invites:open_past_expiry", subjectId: null, subjectType: "portal_contact_invites",
      summary: `${rows.length} client-portal invite(s) still ${[...new Set(rows.map((r) => r.status))].join("/")} after their expiry — the client cannot get in`,
      idempotent: false, evidence: { count: rows.length, sample: rows.slice(0, 5).map((r) => ({ id: r.id, contact_id: r.contact_id, expires_at: r.expires_at, portal_view: r.portal_view })) },
    })]
  },

  // A signature request past its expiry with signatures still outstanding: a stuck deal step. Re-sending an
  // envelope is a provider SEND — never re-run blind, so it is a non-resumable stuck workflow (a human).
  esign_requests: async (svc, b, deps) => {
    const rows = must(await svc.from("signature_requests").select("id, transaction_id, request_status, expires_at, sent_at")
      .eq("brokerage_id", b).in("request_status", ["sent", "partially_signed"]).lt("expires_at", iso(deps.now)).limit(200), "signature_requests") as Array<{ id: string; transaction_id: string | null; request_status: string; expires_at: string | null; sent_at: string | null }>
    return rows.map((r) => incident(b, "esign_requests", "stuck_workflow", {
      subjectKey: `signature_request:${r.id}`, subjectId: uuidOr(r.id), subjectType: "signature_request",
      summary: `e-sign request ${r.request_status} past its expiry ${r.expires_at}${r.transaction_id ? ` (transaction ${r.transaction_id})` : ""}`,
      idempotent: false, resumable: false,
      evidence: { transaction_id: r.transaction_id, request_status: r.request_status, expires_at: r.expires_at, sent_at: r.sent_at },
    }))
  },

  // Returned / failed mail is an ADDRESS problem — the Data Steward verifies the record (never a re-mail).
  direct_mail_returns: async (svc, b, deps) => {
    const rows = must(await svc.from("direct_mail_recipients").select("id, campaign_id, contact_id, delivery_status")
      .eq("brokerage_id", b).in("delivery_status", ["failed", "returned"]).gte("created_at", iso(hoursAgo(deps.now, 24 * 14))).limit(1000), "direct_mail_recipients") as Array<{ id: string; campaign_id: string | null; contact_id: string | null; delivery_status: string }>
    const byCampaign = new Map<string, typeof rows>()
    for (const r of rows) byCampaign.set(r.campaign_id ?? "unknown", [...(byCampaign.get(r.campaign_id ?? "unknown") ?? []), r])
    return [...byCampaign.entries()].map(([campaign, list]) => incident(b, "direct_mail_returns", "data_conflict", {
      subjectKey: `direct_mail_campaign:${campaign}`, subjectId: uuidOr(campaign), subjectType: "direct_mail_campaign",
      summary: `${list.length} mail piece(s) ${[...new Set(list.map((r) => r.delivery_status))].join("/")} in 14 days — the addresses need verifying before the next drop`,
      idempotent: false, evidence: { failed_or_returned: list.length, contacts: list.map((r) => r.contact_id).filter(Boolean).slice(0, 20) },
    }))
  },

  // Failed sequence sends, per provider. A send is NEVER re-sent through the supervisor (it could deliver
  // twice): a throttled provider is a non-idempotent rate_limit, any other failure a non-idempotent provider
  // failure — both reach a human with the evidence.
  sequence_send_failures: async (svc, b, deps) => {
    const rows = must(await svc.from("sequence_step_executions").select("id, provider_key, channel, error_message")
      .eq("brokerage_id", b).eq("status", "failed").gte("created_at", iso(hoursAgo(deps.now, 24))).limit(2000), "sequence_step_executions") as Array<{ id: string; provider_key: string | null; channel: string | null; error_message: string | null }>
    const byProvider = new Map<string, typeof rows>()
    for (const r of rows) byProvider.set(r.provider_key ?? r.channel ?? "unknown", [...(byProvider.get(r.provider_key ?? r.channel ?? "unknown") ?? []), r])
    return [...byProvider.entries()].map(([provider, list]) => {
      const throttled = list.some((r) => /\b429\b|rate.?limit|throttl|too many requests/i.test(r.error_message ?? ""))
      return incident(b, "sequence_send_failures", throttled ? "rate_limit" : "provider_failure", {
        subjectKey: `sequence_provider:${provider}`, subjectId: null, subjectType: "sequence_send_provider",
        summary: `${list.length} sequence send(s) failed through ${provider} in 24h${throttled ? " (rate limited)" : ""} — ${String(list[0].error_message ?? "").slice(0, 120)}`,
        idempotent: false, failoverAvailable: false,
        evidence: { provider, failed: list.length, sample: list[0].error_message },
      })
    })
  },

  // A pending contract deadline whose date has passed was neither completed, waived nor extended: contract
  // exposure, routed to the Compliance Manager (the OS never marks a deadline met or missed itself).
  transaction_deadlines: async (svc, b, deps) => {
    const rows = must(await svc.from("transaction_deadlines").select("id, transaction_id, deadline_type, deadline_date")
      .eq("brokerage_id", b).eq("status", "pending").lt("deadline_date", iso(deps.now).slice(0, 10)).limit(500), "transaction_deadlines") as Array<{ id: string; transaction_id: string | null; deadline_type: string | null; deadline_date: string | null }>
    const byTxn = new Map<string, typeof rows>()
    for (const r of rows) byTxn.set(r.transaction_id ?? "unknown", [...(byTxn.get(r.transaction_id ?? "unknown") ?? []), r])
    return [...byTxn.entries()].map(([txn, list]) => incident(b, "transaction_deadlines", "compliance", {
      subjectKey: `transaction:${txn}`, subjectId: uuidOr(txn), subjectType: "transaction",
      summary: `${list.length} contract deadline(s) passed while still pending (${list.map((r) => r.deadline_type ?? "?").join(", ")})`,
      idempotent: false, evidence: { deadlines: list.map((r) => ({ id: r.id, type: r.deadline_type, date: r.deadline_date })) },
    }))
  },

  // The accounting sync is FINANCIAL (owner, wave 137): a failed or hung sync is never re-run here (a re-run
  // could double a journal entry) — Finance reviews the evidence; no money writer is attributable, none halted.
  payments_sync: async (svc, b, deps) => {
    const rows = must(await svc.from("accounting_sync_log").select("id, provider, sync_type, status, started_at, error_summary, records_failed")
      .eq("brokerage_id", b).in("status", ["failed", "running"]).gte("started_at", iso(hoursAgo(deps.now, 72))).limit(200), "accounting_sync_log") as Array<{ id: string; provider: string | null; sync_type: string | null; status: string; started_at: string | null; error_summary: string | null; records_failed: number | null }>
    const bad = rows.filter((r) => r.status === "failed" || (!!r.started_at && Date.parse(r.started_at) < hoursAgo(deps.now, 2).getTime()))
    return bad.map((r) => incident(b, "payments_sync", "financial_discrepancy", {
      subjectKey: `accounting_sync:${r.id}`, subjectId: uuidOr(r.id), subjectType: "accounting_sync_log",
      summary: `${r.provider ?? "accounting"} ${r.sync_type ?? "sync"} ${r.status === "failed" ? "failed" : "hung > 2h"}${r.records_failed ? ` (${r.records_failed} record(s) failed)` : ""}${r.error_summary ? ` — ${r.error_summary.slice(0, 120)}` : ""}`,
      idempotent: false, evidence: { provider: r.provider, sync_type: r.sync_type, status: r.status, started_at: r.started_at, records_failed: r.records_failed },
    }))
  },
}

/** Run every detector for ONE tenant. A refused read marks the detector UNREADABLE — never all-clear. */
async function detectIncidents(svc: Svc, brokerageId: string, deps: DetectorDeps, only?: readonly HealthDetector[]): Promise<DetectorResult[]> {
  const out: DetectorResult[] = []
  for (const d of only ?? HEALTH_DETECTORS) {
    try {
      out.push({ detector: d, readable: true, error: null, incidents: await DETECTORS[d](svc, brokerageId, deps) })
    } catch (e) {
      out.push({ detector: d, readable: false, error: e instanceof Error ? e.message : String(e), incidents: [] })
    }
  }
  return out
}

// ── The incident ledger fold (self_heal_events — the Exception Center's own record) ─────────

const OS_HEALTH_SUBJECT_PREFIX = "os_health:"
const RECOVERY_LEDGER_ACTIONS = new Set(["os_health_retry", "os_health_backoff", "os_health_resume", "os_health_failover"])
const CLOSERS = new Set(["resolved", "dismissed", "healed"])

export interface IncidentHistory {
  attempts24h: number
  openEscalation: boolean
  /** Every row this subject has in the window — monotonic per tick, so it makes each ledger key unique. */
  rowsSeen: number
  /** Wave 138B — self-healing playbook runs (os_health_playbook:* rows) in 24h: the troubleshooter's bound. */
  playbookAttempts24h: number
}

const PLAYBOOK_ROW_PREFIX = "os_health_playbook:"

/** PURE — fold this tenant's os_health ledger rows into per-subject attempts + open-escalation state. */
/** @proofSeam the pure ledger fold the proof checks for closer semantics */
export function foldIncidentHistory(rows: Array<{ subject: string; action: string | null; outcome: string; created_at: string }>, now: Date): Map<string, IncidentHistory> {
  const out = new Map<string, IncidentHistory>()
  const dayAgo = now.getTime() - 24 * 3_600_000
  for (const r of [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at))) {
    const h = out.get(r.subject) ?? { attempts24h: 0, openEscalation: false, rowsSeen: 0, playbookAttempts24h: 0 }
    h.rowsSeen++
    if (r.action && RECOVERY_LEDGER_ACTIONS.has(r.action) && Date.parse(r.created_at) >= dayAgo) h.attempts24h++
    if (r.action?.startsWith(PLAYBOOK_ROW_PREFIX) && Date.parse(r.created_at) >= dayAgo) h.playbookAttempts24h++
    if (r.outcome === "escalated") h.openEscalation = true
    else if (CLOSERS.has(r.outcome) && !(r.action && RECOVERY_LEDGER_ACTIONS.has(r.action))) h.openEscalation = false
    out.set(r.subject, h)
  }
  return out
}

/** @proofSeam the proof derives Exception-Center subjects with the same spelling the supervisor writes */
export const subjectFor = (i: Pick<HealthIncident, "detector" | "subjectKey">) => `${OS_HEALTH_SUBJECT_PREFIX}${i.detector}:${i.subjectKey}`

// ── Executor ────────────────────────────────────────────────────────────────────────────────

export interface ExecutorDeps {
  /** Run the idempotent retry for a transient incident (the owning survivor). */
  retry?: (svc: Svc, i: HealthIncident) => Promise<{ ok: boolean; outcome: string }>
  /** Resume a stuck chain through the workflow engine. */
  resume?: (svc: Svc, i: HealthIncident) => Promise<{ ok: boolean; outcome: string }>
  /** The manager bus (publishManagerSignal). */
  publishSignal?: (svc: Svc, s: { brokerageId: string; toManager: "data_steward" | "compliance_officer" | "finance_manager"; message: string; payload: Record<string, unknown> }) => Promise<{ ok: boolean; reason?: string }>
  /** The financial-writer kill switch. */
  halt?: (svc: Svc, h: { brokerageId: string; writer: FinancialWriterKey; reason: string; incident: string }) => Promise<{ ok: boolean; error?: string; alreadyHalted?: boolean }>
  /** Bell a human (org recipients). */
  notifyHuman?: (svc: Svc, i: HealthIncident, reason: string) => Promise<void>
  /** Wave 138 (138A): the provider self-healer's exported entry (connector-healer.ts healProviderFailure)
   *  the failover step calls after routing around — probe-first, then apply-declared / propose. */
  healProvider?: (input: { connector: string; brokerageId: string; failures: Array<{ status: number | null; path: string | null; error: string | null }>; cycle: string },
    deps: { client: Svc; derivedHealth: (k: string) => Promise<{ state: string; routeAround: boolean; reason: string } | null> }) => Promise<{ decision: { step: string; reason: string } }>
  /** withActionLedger (LAW 5) and emitKernelEvent seams — the real ones by default. */
  ledger?: typeof import("@/lib/kernel/action-ledger").withActionLedger
  emit?: (input: Record<string, unknown>) => Promise<{ error: string | null }>
  /**
   * Wave 138B — the self-healing troubleshooter (lib/kernel/self-healing.ts) for every incident this
   * policy sends to a human as `unknown`: hard gate → bounded AI diagnosis → a DECLARED playbook, or the
   * human escalation below with the diagnosis attached. Seams for its model / budget / executors;
   * `false` = this supervisor run escalates unknowns without troubleshooting (a proof fixture's choice).
   */
  troubleshoot?: import("@/lib/kernel/self-healing").TroubleshootDeps | false
}

export interface SupervisorOutcome {
  incident: HealthIncident
  decision: RecoveryDecision
  executed: boolean
  outcome: string
  skipped?: "already_escalated"
  /** Wave 138B — the declared playbook the troubleshooter ran instead of escalating. */
  playbook?: string
}

export interface SupervisorReport {
  brokerageId: string
  detectorsRun: number
  unreadable: Array<{ detector: HealthDetector; error: string }>
  incidents: number
  recovered: number
  escalated: number
  closed: number
  outcomes: SupervisorOutcome[]
}

const defaultRetry = async (svc: Svc, i: HealthIncident): Promise<{ ok: boolean; outcome: string }> => {
  if (i.retryOwner) return { ok: true, outcome: `retry delegated to its rail: ${i.retryOwner}` } // the owning rail retries; no second path
  if (i.subjectKey === "bus:open_past_window") {
    const { reapStuckManagerSignals } = await import("@/lib/kernel/signal-reaper")
    const r = await reapStuckManagerSignals(i.brokerageId, svc)
    return { ok: true, outcome: `signal reaper re-run: ${r.replayed} replayed, ${r.expired} expired, ${r.escalated} escalated` }
  }
  if (i.subjectKey === "reconciler:commission_amount_drift") {
    const { reapCommissionAmountDrift } = await import("@/lib/finance/commission-tracking-reaper")
    const { recordReaperRun } = await import("@/lib/intelligence/reaper-net")
    const r = await reapCommissionAmountDrift(i.brokerageId, svc)
    await recordReaperRun({ brokerageId: i.brokerageId, domain: "commission_amount_drift", manager: "finance_manager", ...r, detail: "re-run by the OS health supervisor (missing reconciliation)" }, svc)
    return { ok: true, outcome: `reconciler re-run: ${r.scanned} checked, ${r.escalated} drift(s) escalated` }
  }
  return { ok: false, outcome: `no retry survivor registered for ${i.subjectKey}` }
}

const defaultResume = async (svc: Svc, i: HealthIncident): Promise<{ ok: boolean; outcome: string }> => {
  const runId = i.subjectId
  if (!runId) return { ok: false, outcome: "no run id" }
  // Re-check right before acting: the step must STILL be un-started (a racing engine may have moved it).
  const { data: run, error } = await svc.from("workflow_runs").select("id, status, current_step_index").eq("id", runId).eq("brokerage_id", i.brokerageId).maybeSingle()
  if (error || !run || (run as any).status !== "running") return { ok: false, outcome: `run no longer resumable (${error?.message ?? (run as any)?.status ?? "gone"})` }
  const { data: step, error: stepErr } = await svc.from("workflow_run_steps").select("status").eq("run_id", runId).eq("step_index", (run as any).current_step_index ?? 0).maybeSingle()
  if (stepErr) return { ok: false, outcome: `step unreadable: ${stepErr.message}` }
  if (step && (step as any).status !== "pending") return { ok: false, outcome: `step is '${(step as any).status}' — in flight, not resumed` }
  const { advanceRun } = await import("@/lib/workflow-orchestrator/engine")
  const r = await advanceRun(runId)
  return { ok: r.success, outcome: r.success ? `resumed → ${r.status ?? "advanced"}` : `engine refused: ${r.error}` }
}

/** The bus. Literal signal types per route so test:signal-integrity sees every publication. */
const defaultPublish: NonNullable<ExecutorDeps["publishSignal"]> = async (svc, s) => {
  const { publishManagerSignal } = await import("@/lib/kernel/manager-signals")
  const base = { brokerageId: s.brokerageId, fromManager: "cron_manager" as const, message: s.message, entityType: "os_health_incident", payload: s.payload }
  if (s.toManager === "finance_manager") return publishManagerSignal({ ...base, toManager: "finance_manager", signalType: "os_health_escalated_financial" }, svc)
  if (s.toManager === "compliance_officer") return publishManagerSignal({ ...base, toManager: "compliance_officer", signalType: "os_health_escalated_compliance" }, svc)
  return publishManagerSignal({ ...base, toManager: "data_steward", signalType: "os_health_escalated_data_conflict" }, svc)
}

const defaultNotify = async (svc: Svc, i: HealthIncident, reason: string): Promise<void> => {
  const { resolveOrgRecipients } = await import("@/lib/kernel/org-recipients")
  const recipients = await resolveOrgRecipients(svc, i.brokerageId, { limit: 3 })
  if (recipients.length === 0) return
  const { error } = await svc.from("notifications").insert(recipients.map((user_id) => ({
    user_id, brokerage_id: i.brokerageId, type: "os_health_escalation",
    title: `Your OS needs a human: ${i.summary}`.slice(0, 200),
    body: `${reason}. It is waiting in the Exception Center with its evidence.`,
    entity_type: i.subjectType, entity_id: i.subjectId, priority: i.class === "financial_discrepancy" ? "high" : "medium", is_read: false,
  })))
  if (error) console.error(`[os-health] escalation bell refused: ${error.message}`)
}

/**
 * Perform one decision through its survivor, ledger it (withActionLedger, LAW 5) and event it
 * (emitKernelEvent, audit-only), and append the incident row the Exception Center reads.
 */
async function execute(svc: Svc, i: HealthIncident, d: RecoveryDecision, deps: ExecutorDeps, cycle: string): Promise<SupervisorOutcome> {
  const subject = subjectFor(i)
  const ledger = deps.ledger ?? (await import("@/lib/kernel/action-ledger")).withActionLedger
  const emit = deps.emit ?? (async (input: Record<string, unknown>) => (await import("@/lib/kernel/emit")).emitKernelEvent(input as any))
  const ledgerAction = { retry: "os_health_retry", backoff: "os_health_backoff", resume: "os_health_resume", failover: "os_health_failover" } as Record<string, string>

  const act = async (): Promise<{ ok: boolean; outcome: string }> => {
    switch (d.action) {
      case "retry": return (deps.retry ?? defaultRetry)(svc, i)
      case "resume": return (deps.resume ?? defaultResume)(svc, i)
      case "backoff": return { ok: true, outcome: `backoff until ${new Date(Date.now() + (d.delayMs ?? 0)).toISOString()}${i.retryOwner ? ` (the retry belongs to ${i.retryOwner})` : ""}` }
      case "failover": {
        // Wave 138 (138A — closes 137C open loop 3): after routing around, hand the provider to the
        // self-healer's exported entry (probe → failover / apply-declared + retry / proposal, each step
        // ledgered under this tenant). The derived health is the incident's own evidence. A healer that
        // cannot run never undoes the failover — the router already routes around — it is reported.
        const routed = `routed around by routeCapability: ${JSON.stringify((i.evidence.routes as unknown[] | undefined) ?? []).slice(0, 300)}`
        const provider = String(i.evidence.provider ?? "")
        if (!provider) return { ok: true, outcome: routed }
        try {
          // The real healer also gets its metered internet-research budget (138B) — the same constant the
          // connector-health cron passes, never a second number.
          const healer = deps.healProvider ? null : await import("@/lib/agentic-os/connector-healer")
          const heal = deps.healProvider ?? ((input, d) => healer!.healProviderFailure(input, d as never))
          const h = await heal(
            { connector: provider, brokerageId: i.brokerageId, failures: [{ status: null, path: null, error: String(i.evidence.reason ?? i.summary).slice(0, 300) }], cycle, ...(healer ? { research: { capUsd: healer.PROVIDER_RESEARCH_CAP_USD } } : {}) },
            { client: svc, derivedHealth: async () => ({ state: String(i.evidence.state ?? "failing"), routeAround: i.evidence.state === "failing", reason: String(i.evidence.reason ?? "") }) },
          )
          return { ok: true, outcome: `${routed}; provider heal: ${h.decision.step} — ${h.decision.reason}`.slice(0, 600) }
        } catch (e) {
          return { ok: true, outcome: `${routed}; provider heal could not run: ${e instanceof Error ? e.message : String(e)}`.slice(0, 600) }
        }
      }
      case "route_data_steward":
      case "route_compliance": {
        const r = await (deps.publishSignal ?? defaultPublish)(svc, { brokerageId: i.brokerageId, toManager: d.action === "route_compliance" ? "compliance_officer" : "data_steward", message: i.summary, payload: { subject, class: i.class, evidence: i.evidence } })
        return { ok: r.ok, outcome: r.ok ? `routed to ${d.routedTo}` : `signal refused: ${r.reason}` }
      }
      case "halt_and_route_finance": {
        let haltNote = "no attributable writer — nothing halted"
        if (d.halt) {
          const h = await (deps.halt ?? haltFinancialWriter)(svc, { brokerageId: i.brokerageId, writer: d.halt, reason: i.summary, incident: subject })
          if (!h.ok) return { ok: false, outcome: `HALT REFUSED for ${d.halt}: ${(h as { error?: string }).error} — escalated to a human` }
          haltNote = (h as { alreadyHalted?: boolean }).alreadyHalted ? `${d.halt} already halted` : `${d.halt} halted`
        }
        const r = await (deps.publishSignal ?? defaultPublish)(svc, { brokerageId: i.brokerageId, toManager: "finance_manager", message: i.summary, payload: { subject, halted_writer: d.halt, evidence: i.evidence } })
        return { ok: r.ok, outcome: `${haltNote}; ${r.ok ? "Finance Manager signalled" : `finance signal refused: ${r.reason}`}` }
      }
      case "escalate_human":
        await (deps.notifyHuman ?? defaultNotify)(svc, i, d.reason)
        return { ok: true, outcome: "escalated to a human (Exception Center)" }
    }
  }

  const result = await ledger(
    {
      brokerageId: i.brokerageId,
      action: `os_health.${i.detector}.${d.action}`,
      actor: { type: "manager", managerKey: "cron_manager" },
      subject: { type: i.subjectType, id: i.subjectId, ref: i.subjectKey },
      reasonCode: "OS_HEALTH_RECOVERY",
      reasonDetail: d.reason,
      idempotencyKey: `os_health:${i.brokerageId}:${i.detector}:${i.subjectKey}:${d.action}:${d.attempt}:${cycle}`,
      riskClass: d.action === "halt_and_route_finance" ? "FINANCIAL" : "LOW_RISK_WRITE",
      systemSource: "os_health",
      policyKey: d.action === "halt_and_route_finance" && d.halt ? FINANCIAL_WRITER_HALTS_POLICY_KEY : null,
      detail: { class: i.class, detector: i.detector, summary: i.summary, evidence: i.evidence, decision: d },
    },
    act,
    {
      settle: (r) => ({ status: r.ok ? "executed" : "failed", outcome: r.outcome.slice(0, 300), error: r.ok ? null : r.outcome }),
      replay: (claim) => ({ ok: true, outcome: `already recorded for this attempt (${claim.kind}) — not re-run` }),
    },
    { client: svc },
  )

  // The incident row the Exception Center folds. An automatic recovery records 'healed' (it ran) or
  // 'failed' (it did not, or a backoff is still waiting) and counts toward the retry bound — the
  // policy escalates once the bound is reached. Every routed decision records 'escalated' (open until
  // its owner closes it); a routed decision whose route itself was refused also bells a human.
  const isRecovery = !!ledgerAction[d.action]
  const outcomeRow = !isRecovery ? "escalated" : result.ok && d.action !== "backoff" ? "healed" : "failed"
  const { error: rowErr } = await svc.from("self_heal_events").insert({
    brokerage_id: i.brokerageId, domain: "data_flow", subject, action: ledgerAction[d.action] ?? "none", outcome: outcomeRow,
    detail: { flow: `os_health_${i.detector}`, class: i.class, recovery: d.action, routed_to: d.routedTo, reason: result.ok ? d.reason : `${d.reason} — ${result.outcome}`, outcome: result.outcome, summary: i.summary, attempt: d.attempt },
  })
  if (rowErr) console.error(`[os-health] incident row refused for ${subject}: ${rowErr.message}`)
  if (!isRecovery && !result.ok && d.action !== "escalate_human") await (deps.notifyHuman ?? defaultNotify)(svc, i, `${d.reason} — but the route was refused: ${result.outcome}`)

  const ev = await emit({
    event: "os_health.incident", brokerageId: i.brokerageId, entityType: "os_health_incident", entityId: null,
    source: "cron", auditOnly: true, client: svc,
    dedupeKey: `${subject}:${d.action}:${d.attempt}`, dedupeWindowSec: 86_400,
    metadata: { subject, detector: i.detector, class: i.class, recovery: d.action, routed_to: d.routedTo, halted_writer: d.halt, attempt: d.attempt, outcome: result.outcome, ok: result.ok },
  })
  if (ev.error) console.error(`[os-health] incident event not recorded for ${subject}: ${ev.error}`)
  return { incident: i, decision: d, executed: result.ok, outcome: result.outcome }
}

/**
 * THE SUPERVISOR — one tick for ONE tenant. Detect → (skip what is already escalated and open) →
 * decide → execute through the survivor → ledger + event. Subjects whose detector READ cleanly and
 * no longer see them are closed with a 'resolved' row (condition cleared) — except a financial halt,
 * which only Finance releases. Never throws (a supervisor must not take down its host cron).
 */
export async function runOsHealthSupervisor(
  brokerageId: string,
  svc: Svc,
  opts: { now?: Date; detectors?: readonly HealthDetector[]; detectorDeps?: Omit<DetectorDeps, "now">; executorDeps?: ExecutorDeps } = {},
): Promise<SupervisorReport> {
  const now = opts.now ?? new Date()
  const report: SupervisorReport = { brokerageId, detectorsRun: 0, unreadable: [], incidents: 0, recovered: 0, escalated: 0, closed: 0, outcomes: [] }
  if (!brokerageId) return report
  try {
    const results = await detectIncidents(svc, brokerageId, { now, ...(opts.detectorDeps ?? {}) }, opts.detectors)
    report.detectorsRun = results.length
    const incidents: HealthIncident[] = []
    for (const r of results) {
      if (!r.readable) {
        report.unreadable.push({ detector: r.detector, error: r.error ?? "unknown" })
        // "Nobody checked" is itself an incident — never an all-clear (§4).
        incidents.push(incident(brokerageId, r.detector, "unknown", { subjectKey: `detector_unreadable:${r.detector}`, subjectId: null, subjectType: "os_health_detector", summary: `health detector ${r.detector} could not read its survivor: ${r.error}`, idempotent: false, evidence: { error: r.error } }))
      }
      incidents.push(...r.incidents)
    }
    report.incidents = incidents.length

    const { data: hist, error: histErr } = await svc.from("self_heal_events").select("subject, action, outcome, created_at")
      .eq("brokerage_id", brokerageId).eq("domain", "data_flow").like("subject", `${OS_HEALTH_SUBJECT_PREFIX}%`)
      .gte("created_at", iso(hoursAgo(now, 24 * 7))).limit(5000)
    if (histErr) {
      // Without the history the retry bound and the escalation dedupe cannot be honored — act on nothing.
      console.error(`[os-health] incident history unreadable for ${brokerageId}: ${histErr.message} — no recovery this tick`)
      report.unreadable.push({ detector: "event_backlog", error: `self_heal_events: ${histErr.message}` })
      return report
    }
    const history = foldIncidentHistory((hist ?? []) as Array<{ subject: string; action: string | null; outcome: string; created_at: string }>, now)

    for (const inc of incidents) {
      const h = history.get(subjectFor(inc)) ?? { attempts24h: 0, openEscalation: false, rowsSeen: 0, playbookAttempts24h: 0 }
      if (h.openEscalation) {
        report.outcomes.push({ incident: inc, decision: decideRecovery(inc, { priorAttempts: h.attempts24h }), executed: false, outcome: "already escalated — waiting on its owner", skipped: "already_escalated" })
        continue
      }
      let decision = decideRecovery(inc, { priorAttempts: h.attempts24h })
      const cycle = `${now.toISOString().slice(0, 10)}.${h.rowsSeen}`
      const xd = opts.executorDeps ?? {}
      // Wave 138B — "unknown → human" is first TROUBLESHOOTED (gate → bounded diagnosis → declared playbook).
      if (decision.action === "escalate_human" && inc.class === "unknown" && xd.troubleshoot !== false) {
        try {
          const { troubleshootIncident } = await import("@/lib/kernel/self-healing")
          const t = await troubleshootIncident(svc, inc, { playbookAttempts24h: h.playbookAttempts24h, cycle, attempt: decision.attempt }, {
            ...(xd.troubleshoot ?? {}), ledger: xd.troubleshoot?.ledger ?? xd.ledger, emit: xd.troubleshoot?.emit ?? xd.emit,
            notify: xd.troubleshoot?.notify ?? xd.notifyHuman ?? defaultNotify,
            executors: { retry: (s, i) => (xd.retry ?? defaultRetry)(s, i), resume: (s, i) => (xd.resume ?? defaultResume)(s, i), ...(xd.troubleshoot?.executors ?? {}) },
          })
          if (t.kind === "playbook") {
            report.outcomes.push({ incident: inc, decision: { ...decision, reason: `self-healing playbook ${t.playbook}: ${t.diagnosis.diagnosis.slice(0, 200)}` }, executed: t.ok, outcome: t.outcome, playbook: t.playbook })
            if (t.ok && t.acts) report.recovered++
            else report.escalated++
            continue
          }
          decision = { ...decision, reason: `${decision.reason} — ${t.reason}`.slice(0, 1500) }
        } catch (e) {
          decision = { ...decision, reason: `${decision.reason} — troubleshooter failed: ${(e as Error).message}` }
        }
      }
      try {
        const o = await execute(svc, inc, decision, xd, cycle)
        report.outcomes.push(o)
        if (["retry", "backoff", "failover", "resume"].includes(decision.action) && o.executed) report.recovered++
        else report.escalated++
      } catch (e) {
        report.outcomes.push({ incident: inc, decision, executed: false, outcome: `executor threw: ${(e as Error).message}` })
        report.escalated++
      }
    }

    // Close what cleared — only for detectors that READ cleanly this tick, never a financial halt.
    const readable = new Set(results.filter((r) => r.readable).map((r) => r.detector))
    const live = new Set(incidents.map(subjectFor))
    for (const [subject, h] of history) {
      if (!h.openEscalation || live.has(subject)) continue
      const detector = subject.slice(OS_HEALTH_SUBJECT_PREFIX.length).split(":")[0] as HealthDetector
      if (!readable.has(detector)) continue
      if (detector === "billing_drift" || detector === "usage_inconsistencies") continue // a halt is released by Finance, not by silence
      const { error } = await svc.from("self_heal_events").insert({ brokerage_id: brokerageId, domain: "data_flow", subject, action: "none", outcome: "resolved", detail: { flow: `os_health_${detector}`, reason: "condition cleared — the detector no longer sees it", by: "os_health" } })
      if (!error) report.closed++
    }
  } catch (e) {
    console.error(`[os-health] supervisor tick failed for ${brokerageId}: ${(e as Error).message}`)
  }
  return report
}

// ── The command-center health line (read) ───────────────────────────────────────────────────

export interface OsHealthLine {
  status: "ok" | "warn" | "breach" | "unknown"
  line: string
  openByClass: Partial<Record<IncidentClass, number>>
  recovered24h: number
  halts: Array<{ writer: FinancialWriterKey; label: string; reason: string | null; setAt: string | null }>
  lastRunAt: string | null
}

/** PURE — compose the one line from the incident ledger, the halts and the supervisor's last run. */
/** @proofSeam the pure health-line composer the proof checks for fail-closed status */
export function composeOsHealthLine(input: {
  rows: Array<{ subject: string; action: string | null; outcome: string; created_at: string; detail: Record<string, unknown> | null }>
  halts: OsHealthLine["halts"]
  lastRunAt: string | null
  now: Date
}): OsHealthLine {
  const history = foldIncidentHistory(input.rows, input.now)
  const openByClass: Partial<Record<IncidentClass, number>> = {}
  for (const [subject, h] of history) {
    if (!h.openEscalation) continue
    const last = [...input.rows].filter((r) => r.subject === subject && r.outcome === "escalated").sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
    const cls = ((last?.detail?.class as IncidentClass | undefined) ?? "unknown")
    openByClass[cls] = (openByClass[cls] ?? 0) + 1
  }
  const dayAgo = input.now.getTime() - 24 * 3_600_000
  const recovered24h = input.rows.filter((r) => r.outcome === "healed" && Date.parse(r.created_at) >= dayAgo).length
  const open = Object.values(openByClass).reduce((s, n) => s + (n ?? 0), 0)
  const stale = !input.lastRunAt || input.now.getTime() - Date.parse(input.lastRunAt) > 2 * 3_600_000
  const status: OsHealthLine["status"] = stale ? "unknown" : input.halts.length > 0 || (openByClass.financial_discrepancy ?? 0) > 0 ? "breach" : open > 0 ? "warn" : "ok"
  const parts: string[] = []
  if (stale) parts.push(input.lastRunAt ? `health supervisor last ran ${input.lastRunAt.slice(0, 16).replace("T", " ")} — not checked since` : "health supervisor has not run — nothing has been checked")
  if (input.halts.length > 0) parts.push(`${input.halts.length} financial writer(s) HALTED for Finance review`)
  if (open > 0) parts.push(`${open} incident(s) waiting on a manager or a human`)
  parts.push(`${recovered24h} recovered automatically in 24h`)
  return { status, line: parts.join(" · "), openByClass, recovered24h, halts: input.halts, lastRunAt: input.lastRunAt }
}

/** Load the health line for ONE tenant (the caller gated the session and resolved the tenant). */
export async function loadOsHealthLine(svc: Svc, brokerageId: string, now: Date = new Date()): Promise<OsHealthLine> {
  const [rowsRes, runRes, settingsRes] = await Promise.all([
    svc.from("self_heal_events").select("subject, action, outcome, created_at, detail").eq("brokerage_id", brokerageId).eq("domain", "data_flow")
      .like("subject", `${OS_HEALTH_SUBJECT_PREFIX}%`).gte("created_at", iso(hoursAgo(now, 24 * 7))).limit(5000),
    svc.from("reaper_runs").select("ran_at").eq("brokerage_id", brokerageId).eq("domain", "os_health").order("ran_at", { ascending: false }).limit(1),
    svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle(),
  ])
  const halts: OsHealthLine["halts"] = []
  for (const w of Object.keys(FINANCIAL_WRITERS) as FinancialWriterKey[]) {
    const h = settingsRes.error
      ? { halted: true, reason: `halt state unreadable: ${settingsRes.error.message}`, setAt: null }
      : readFinancialWriterHalt((settingsRes.data as { settings?: Record<string, unknown> } | null)?.settings ?? null, w)
    if (h.halted) halts.push({ writer: w, label: FINANCIAL_WRITERS[w].label, reason: h.reason, setAt: h.setAt })
  }
  const line = composeOsHealthLine({
    rows: rowsRes.error ? [] : (rowsRes.data ?? []),
    halts,
    lastRunAt: runRes.error ? null : (((runRes.data ?? [])[0] as { ran_at?: string } | undefined)?.ran_at ?? null),
    now,
  })
  if (rowsRes.error) return { ...line, status: "unknown", line: `incident ledger unreadable (${rowsRes.error.message}) — not checked · ${line.line}` }
  return line
}
