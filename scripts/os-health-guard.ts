/**
 * scripts/os-health-guard.ts — test:os-health (wave 108, lane 108C).
 *
 * OS HEALTH & SELF-HEALING, proven in memory (no network, no database):
 *   A. the RECOVERY POLICY — each incident class → its recovery; financial → HALT + Finance; unknown →
 *      human; the retry bound; a non-idempotent action is NEVER retried (with POSITIVE CONTROLS: the
 *      same incident made idempotent / under the bound DOES retry);
 *   B. the SUPERVISOR end to end over a fake client: detectors read the survivors, the executor routes
 *      through its seams, every decision is ledgered (withActionLedger) + evented (emitKernelEvent) +
 *      lands an Exception-Center row; an open escalation is not re-fired; an unreadable detector is an
 *      incident, never an all-clear, and never auto-closes what it could not see;
 *   C. TENANT SCOPING — every read of a tenant table carries tenant A's predicate, every write carries
 *      tenant A, no tenant-B row is touched (positive control: tenant B's own run sees B's incident);
 *   D. the KILL SWITCH — halt / read / fail-closed / release through the one settings writer, versioned;
 *      every FINANCIAL_WRITERS entry is honored by the file it names (stripped-source scan + control);
 *   E. WIRING — reaper-net health lane, the cron tick, the command-center line, policy key, signal
 *      registry, reason code == the latest defining migration (derived, never pinned).
 */
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import {
  decideRecovery, runOsHealthSupervisor, loadFinancialWriterHalt, haltFinancialWriter, releaseFinancialWriterHalt,
  composeOsHealthLine, foldIncidentHistory, DETECTORS, HEALTH_DETECTORS, INCIDENT_CLASSES, FINANCIAL_WRITERS,
  FINANCIAL_WRITER_HALTS_POLICY_KEY, OS_HEALTH_RETRY_CAP, subjectFor,
  type HealthIncident, type IncidentClass, type FinancialWriterKey,
} from "../lib/kernel/os-health"
import { REAPER_NET } from "../lib/intelligence/reaper-net"
import { TENANT_POLICY_SETTINGS_KEYS } from "../lib/kernel/tenant-policy"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"
import { classifyCoordination } from "../lib/kernel/coordination-kind"

const root = process.cwd()
let passed = 0, failed = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const read = (p: string) => readFileSync(join(root, p), "utf8")
const stripped = (p: string) => stripComments(read(p))

// ── an in-memory supabase-js stand-in (records every query with its filters) ──────────────────
type Row = Record<string, any>
interface QueryLog { table: string; mode: "select" | "insert" | "update" | "delete"; filters: Array<[string, string, unknown]>; rows?: Row[] }
function fakeClient(seed: Record<string, Row[]>, opts: { refuse?: Record<string, string> } = {}) {
  const tables: Record<string, Row[]> = JSON.parse(JSON.stringify(seed))
  const log: QueryLog[] = []
  let idSeq = 0
  const from = (table: string) => {
    const q: QueryLog = { table, mode: "select", filters: [] }
    let payload: any = null, single: "one" | "maybe" | null = null, limitN: number | null = null, returning = false
    const match = (r: Row) => q.filters.every(([op, col, v]) => {
      const x = r[col]
      switch (op) {
        case "eq": return x === v
        case "neq": return x !== v
        case "in": return (v as unknown[]).includes(x)
        case "gte": return x != null && String(x) >= String(v)
        case "gt": return x != null && (typeof v === "number" ? Number(x) > v : String(x) > String(v))
        case "lt": return x != null && String(x) < String(v)
        case "lte": return x != null && String(x) <= String(v)
        case "is": return v === null ? x == null : x === v
        case "like": return typeof x === "string" && x.startsWith(String(v).replace(/%$/, ""))
        case "not_is": return x != null
        default: return true
      }
    })
    const run = () => {
      log.push(q)
      if (opts.refuse?.[table]) return { data: null, error: { message: opts.refuse[table], code: "42501" } }
      const t = (tables[table] ??= [])
      if (q.mode === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: Row) => ({ id: r.id ?? `00000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`, created_at: r.created_at ?? new Date().toISOString(), ...r }))
        q.rows = rows; t.push(...rows)
        return { data: returning ? (single ? rows[0] : rows) : null, error: null }
      }
      const hit = t.filter(match)
      if (q.mode === "update") { hit.forEach((r) => Object.assign(r, payload)); q.rows = hit; return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null } }
      if (q.mode === "delete") { tables[table] = t.filter((r) => !hit.includes(r)); return { data: returning ? hit : null, error: null } }
      const out = limitN != null ? hit.slice(0, limitN) : hit
      if (single) return { data: out[0] ?? null, error: single === "one" && !out[0] ? { message: "no rows" } : null }
      return { data: out, error: null }
    }
    const b: any = {
      select: (_c?: string) => { if (q.mode !== "select") returning = true; return b },
      insert: (p: any) => { q.mode = "insert"; payload = p; return b },
      update: (p: any) => { q.mode = "update"; payload = p; return b },
      delete: () => { q.mode = "delete"; return b },
      eq: (c: string, v: unknown) => { q.filters.push(["eq", c, v]); return b },
      neq: (c: string, v: unknown) => { q.filters.push(["neq", c, v]); return b },
      in: (c: string, v: unknown[]) => { q.filters.push(["in", c, v]); return b },
      gte: (c: string, v: unknown) => { q.filters.push(["gte", c, v]); return b },
      gt: (c: string, v: unknown) => { q.filters.push(["gt", c, v]); return b },
      lt: (c: string, v: unknown) => { q.filters.push(["lt", c, v]); return b },
      lte: (c: string, v: unknown) => { q.filters.push(["lte", c, v]); return b },
      is: (c: string, v: unknown) => { q.filters.push(["is", c, v]); return b },
      like: (c: string, v: unknown) => { q.filters.push(["like", c, v]); return b },
      not: (c: string, _op: string, _v: unknown) => { q.filters.push(["not_is", c, null]); return b },
      order: () => b,
      limit: (n: number) => { limitN = n; return b },
      maybeSingle: () => { single = "maybe"; return b },
      single: () => { single = "one"; return b },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    }
    return b
  }
  return { from, tables: () => tables, log }
}

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const NOW = new Date("2026-10-07T12:00:00.000Z")
const hAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000).toISOString()
const inc = (cls: IncidentClass, over: Partial<HealthIncident> = {}): HealthIncident => ({
  detector: "event_backlog", class: cls, brokerageId: A, subjectKey: `t:${cls}`, subjectId: null, subjectType: "test",
  summary: cls, idempotent: true, evidence: {}, ...over,
})

async function main() {
  console.log("══════════════════════════════════════════════════")
  console.log(" OS health & self-healing (test:os-health)")
  console.log("══════════════════════════════════════════════════")

  // ── A. THE RECOVERY POLICY ─────────────────────────────────────────────────────────────────
  console.log("\n[A · each incident class → its recovery]")
  const expected: Record<IncidentClass, string> = {
    transient: "retry", rate_limit: "backoff", provider_failure: "failover", stuck_workflow: "resume",
    data_conflict: "route_data_steward", compliance: "route_compliance", financial_discrepancy: "halt_and_route_finance", unknown: "escalate_human",
  }
  for (const cls of INCIDENT_CLASSES) {
    const d = decideRecovery(inc(cls, { resumable: true, failoverAvailable: true, financialWriter: "usage_metering" }), { priorAttempts: 0 })
    check(`${cls} → ${expected[cls]}`, d.action === expected[cls], d.action)
  }
  check("the policy table covers every class (no class without a recovery)", INCIDENT_CLASSES.every((c) => c in expected) && Object.keys(expected).length === INCIDENT_CLASSES.length)
  const fin = decideRecovery(inc("financial_discrepancy", { financialWriter: "brokerage_earnings" }), { priorAttempts: 0 })
  check("financial → HALT the attributed writer + route to finance_manager", fin.halt === "brokerage_earnings" && fin.routedTo === "finance_manager")
  check("financial is never retried, even when idempotent and under the bound", decideRecovery(inc("financial_discrepancy", { idempotent: true, financialWriter: "usage_metering" }), { priorAttempts: 0 }).action !== "retry")
  check("compliance → compliance_officer; data conflict → data_steward",
    decideRecovery(inc("compliance"), { priorAttempts: 0 }).routedTo === "compliance_officer" && decideRecovery(inc("data_conflict"), { priorAttempts: 0 }).routedTo === "data_steward")
  check("unknown → human", decideRecovery(inc("unknown"), { priorAttempts: 0 }).routedTo === "human")

  console.log("\n[A · retry bound]")
  for (let k = 0; k < OS_HEALTH_RETRY_CAP; k++) check(`transient retries at prior=${k} (attempt ${k + 1})`, decideRecovery(inc("transient"), { priorAttempts: k }).action === "retry")
  check(`transient at prior=${OS_HEALTH_RETRY_CAP} escalates to a human (bound)`, decideRecovery(inc("transient"), { priorAttempts: OS_HEALTH_RETRY_CAP }).action === "escalate_human")
  check("rate limit at the bound escalates", decideRecovery(inc("rate_limit"), { priorAttempts: OS_HEALTH_RETRY_CAP }).action === "escalate_human")
  check("resume at the bound escalates", decideRecovery(inc("stuck_workflow", { resumable: true }), { priorAttempts: OS_HEALTH_RETRY_CAP }).action === "escalate_human")
  const b0 = decideRecovery(inc("rate_limit"), { priorAttempts: 0 }).delayMs ?? 0, b2 = decideRecovery(inc("rate_limit"), { priorAttempts: 2 }).delayMs ?? 0
  check("backoff grows with the attempt (exponential)", b2 > b0 && b0 > 0, `${b0} → ${b2}`)

  console.log("\n[A · a non-idempotent action is NEVER retried]")
  for (const cls of ["transient", "rate_limit", "provider_failure"] as IncidentClass[]) {
    const d = decideRecovery(inc(cls, { idempotent: false, failoverAvailable: true }), { priorAttempts: 0 })
    check(`${cls} on a non-idempotent action → human, not ${expected[cls]}`, d.action === "escalate_human")
  }
  check("stuck workflow with the step IN FLIGHT (not resumable) → human", decideRecovery(inc("stuck_workflow", { resumable: false }), { priorAttempts: 0 }).action === "escalate_human")
  check("provider failure with NO healthy alternative → human", decideRecovery(inc("provider_failure", { failoverAvailable: false }), { priorAttempts: 0 }).action === "escalate_human")
  check("POSITIVE CONTROL: the same transient, idempotent, DOES retry", decideRecovery(inc("transient", { idempotent: true }), { priorAttempts: 0 }).action === "retry")

  // ── B + C. THE SUPERVISOR over a fake client, two tenants ──────────────────────────────────
  console.log("\n[B · supervisor end to end]")
  const seed: Record<string, Row[]> = {
    workflow_runs: [
      { id: "11111111-1111-4111-8111-111111111111", brokerage_id: A, chain_key: "listing_prep", status: "running", current_step_index: 1, updated_at: hAgo(1) },
      { id: "22222222-2222-4222-8222-222222222222", brokerage_id: A, chain_key: "seller_nurture", status: "running", current_step_index: 0, updated_at: hAgo(1) },
      { id: "33333333-3333-4333-8333-333333333333", brokerage_id: B, chain_key: "b_chain", status: "running", current_step_index: 0, updated_at: hAgo(1) },
    ],
    workflow_run_steps: [
      { run_id: "11111111-1111-4111-8111-111111111111", step_index: 1, status: "pending" },
      { run_id: "22222222-2222-4222-8222-222222222222", step_index: 0, status: "running" },
      { run_id: "33333333-3333-4333-8333-333333333333", step_index: 0, status: "pending" },
    ],
    meter_readings: [
      { id: "m1", brokerage_id: A, meter_type: "sms", period_start: "2026-10-01T00:00:00.000Z", total_units: 5, computed_at: hAgo(2) },
      { id: "m2", brokerage_id: A, meter_type: "sms", period_start: "2026-10-01T00:00:00.000Z", total_units: 5, computed_at: hAgo(2) },
      { id: "m3", brokerage_id: B, meter_type: "sms", period_start: "2026-10-01T00:00:00.000Z", total_units: 5, computed_at: hAgo(2) },
      { id: "m4", brokerage_id: B, meter_type: "sms", period_start: "2026-10-01T00:00:00.000Z", total_units: 5, computed_at: hAgo(2) },
    ],
    outcome_reconciliations: [
      { id: "44444444-4444-4444-8444-444444444444", brokerage_id: A, verdict: "contradicted", escalated_at: null, channel: "sms", claimed_status: "delivered", provider_status: "undelivered" },
    ],
    reaper_runs: [
      { brokerage_id: A, domain: "compliance_flags_stuck", escalated: 2, ran_at: hAgo(3) },
      { brokerage_id: A, domain: "commission_amount_drift", escalated: 0, ran_at: hAgo(5) },
    ],
    manager_signals: [{ id: "s1", brokerage_id: A, status: "open", created_at: hAgo(30) }],
    tenant_webhook_deliveries: [{ id: "w1", brokerage_id: A, subscription_id: "55555555-5555-4555-8555-555555555555", status: "dead", attempts: 6, created_at: hAgo(4), error_detail: "dead after 6 attempts — 500" }],
    missions: [{ id: "66666666-6666-4666-8666-666666666666", brokerage_id: A, state: "ACTIVE", deadline: hAgo(10), owner_manager: "campaign_orchestrator", objective: "launch" }],
    brokerage_settings: [{ id: "bs-a", brokerage_id: A, settings: {}, updated_at: hAgo(100) }, { id: "bs-b", brokerage_id: B, settings: {}, updated_at: hAgo(100) }],
    self_heal_events: [],
  }
  const svc = fakeClient(seed)
  const ledgered: any[] = [], evented: any[] = [], resumed: string[] = [], retried: string[] = [], signals: any[] = [], halts: any[] = [], belled: string[] = []
  const executorDeps = {
    ledger: (async (ctx: any, run: () => Promise<any>, hooks: any) => { ledgered.push(ctx); const r = await run(); ledgered[ledgered.length - 1].settled = hooks.settle(r); return r }) as any,
    emit: async (e: any) => { evented.push(e); return { error: null } },
    resume: async (_s: any, i: HealthIncident) => { resumed.push(i.subjectKey); return { ok: true, outcome: "resumed" } },
    retry: async (_s: any, i: HealthIncident) => { retried.push(i.subjectKey); return { ok: true, outcome: "retried" } },
    publishSignal: async (_s: any, s: any) => { signals.push(s); return { ok: true } },
    halt: async (s: any, h: any) => { halts.push(h); return haltFinancialWriter(s, h) },
    notifyHuman: async (_s: any, i: HealthIncident) => { belled.push(i.subjectKey) },
  }
  const detectorDeps = { providerHealth: async (_p: string) => ({ state: "healthy", routeAround: false, reason: "ok" }) }
  const detectors = ["stale_missions", "stuck_workflows", "failed_webhooks", "missing_reconciliations", "usage_inconsistencies", "event_backlog", "compliance_flags"] as const
  const rep = await runOsHealthSupervisor(A, svc, { now: NOW, detectors, detectorDeps, executorDeps })
  const byKey = new Map(rep.outcomes.map((o) => [o.incident.subjectKey, o]))
  check("every listed detector ran and read cleanly", rep.detectorsRun === detectors.length && rep.unreadable.length === 0, JSON.stringify(rep.unreadable))
  check("stuck run whose next step never started → RESUMED through the engine seam", byKey.get("workflow_run:11111111-1111-4111-8111-111111111111")?.decision.action === "resume" && resumed.includes("workflow_run:11111111-1111-4111-8111-111111111111"))
  check("stuck run whose step is IN FLIGHT → human, resume NOT called", byKey.get("workflow_run:22222222-2222-4222-8222-222222222222")?.decision.action === "escalate_human" && !resumed.includes("workflow_run:22222222-2222-4222-8222-222222222222"))
  const meterDup = rep.outcomes.find((o) => o.incident.detector === "usage_inconsistencies")
  check("doubled meter → financial_discrepancy → usage_metering HALTED + Finance signalled", meterDup?.decision.action === "halt_and_route_finance" && halts.some((h) => h.writer === "usage_metering") && signals.some((s) => s.toManager === "finance_manager"))
  const haltNow = await loadFinancialWriterHalt(svc, A, "usage_metering")
  check("the halt is real: loadFinancialWriterHalt(A, usage_metering) reads halted", haltNow.halted && haltNow.readable)
  check("contradicted outcome → data_conflict → Data Steward", byKey.get("outcome_reconciliation:44444444-4444-4444-8444-444444444444")?.decision.action === "route_data_steward" && signals.some((s) => s.toManager === "data_steward"))
  check("compliance reaper escalation → Compliance Manager", byKey.get("compliance:flags_past_sla")?.decision.action === "route_compliance" && signals.some((s) => s.toManager === "compliance_officer"))
  check("dead webhook → unknown → human (bell rang)", byKey.get("webhook_subscription:55555555-5555-4555-8555-555555555555")?.decision.action === "escalate_human" && belled.includes("webhook_subscription:55555555-5555-4555-8555-555555555555"))
  check("bus backlog → transient → retry through the signal reaper seam", byKey.get("bus:open_past_window")?.decision.action === "retry" && retried.includes("bus:open_past_window"))
  check("stale mission → human (a mission is never re-planned by the supervisor)", byKey.get("mission:66666666-6666-4666-8666-666666666666")?.decision.action === "escalate_human")
  const executed = rep.outcomes.filter((o) => !o.skipped)
  check("EVERY decision is ledgered (withActionLedger, reason OS_HEALTH_RECOVERY, actor cron_manager)", ledgered.length === executed.length && ledgered.every((c) => c.reasonCode === "OS_HEALTH_RECOVERY" && c.actor.managerKey === "cron_manager" && /^os_health\.[a-z_]+\.[a-z_]+$/.test(c.action)), `${ledgered.length}/${executed.length}`)
  check("the halt decision is ledgered FINANCIAL under policy key financial_writer_halts", ledgered.some((c) => c.riskClass === "FINANCIAL" && c.policyKey === FINANCIAL_WRITER_HALTS_POLICY_KEY))
  check("EVERY decision is evented (os_health.incident, audit-only)", evented.length === executed.length && evented.every((e) => e.event === "os_health.incident" && e.auditOnly === true))
  const rowsA = svc.tables().self_heal_events.filter((r: Row) => r.brokerage_id === A)
  check("EVERY decision lands an Exception-Center row (self_heal_events, data_flow, os_health: subject)", rowsA.length >= executed.length && rowsA.every((r: Row) => r.domain === "data_flow" && String(r.subject).startsWith("os_health:")))
  check("every ledger idempotency key is unique (no attempt collides)", new Set(ledgered.map((c) => c.idempotencyKey)).size === ledgered.length)

  console.log("\n[B · provider / AI / media detectors read their survivors]")
  {
    const svcP = fakeClient({
      vendor_usage_tracking: [{ brokerage_id: A, vendor_name: "Versium", created_at: hAgo(5) }, { brokerage_id: A, vendor_name: "batchdata", created_at: hAgo(5) }, { brokerage_id: A, vendor_name: "rentcast", created_at: hAgo(5) }, { brokerage_id: B, vendor_name: "peopledata", created_at: hAgo(5) }],
      ai_tool_usage: Array.from({ length: 10 }, (_, k) => ({ brokerage_id: A, tool_name: "ai_model", manager: "ai_isa", cost_cents: 10, execution_time_ms: 1000, success: k > 4, created_at: hAgo(2) })),
      remotion_composition_renders: [
        { id: "77777777-7777-4777-8777-777777777777", brokerage_id: A, composition_id: "listing", render_status: "failed", retry_count: 0, created_at: hAgo(3) },
        { id: "88888888-8888-4888-8888-888888888888", brokerage_id: A, composition_id: "listing", render_status: "failed", retry_count: 2, created_at: hAgo(3) },
      ],
      self_heal_events: [],
    })
    const health: Record<string, { state: string; routeAround: boolean; reason: string; cooldownUntil?: string | null }> = {
      versium: { state: "failing", routeAround: true, reason: "3 consecutive faults" },
      batchdata: { state: "failing", routeAround: true, reason: "3 consecutive faults" },
      peopledata: { state: "failing", routeAround: true, reason: "B only" },
      rentcast: { state: "rate_limited", routeAround: false, reason: "429s", cooldownUntil: new Date(NOW.getTime() + 600_000).toISOString() },
    }
    const repP = await runOsHealthSupervisor(A, svcP, { now: NOW, detectors: ["provider_failures", "ai_anomalies", "media_render_failures"], detectorDeps: { providerHealth: async (p) => health[p] }, executorDeps })
    const k = new Map(repP.outcomes.map((o) => [o.incident.subjectKey, o]))
    check("versium failing while EVERY other owner_contact provider is failing too → no alternative → human (routeCapability decides)",
      k.get("provider:versium")?.decision.action === "escalate_human" && k.get("provider:versium")?.incident.failoverAvailable === false)
    const svcP2 = fakeClient({ vendor_usage_tracking: [{ brokerage_id: A, vendor_name: "versium", created_at: hAgo(5) }], self_heal_events: [] })
    const repP2 = await runOsHealthSupervisor(A, svcP2, { now: NOW, detectors: ["provider_failures"], detectorDeps: { providerHealth: async (p) => (p === "versium" ? health.versium : { state: "healthy", routeAround: false, reason: "ok" }) }, executorDeps })
    const v2 = repP2.outcomes.find((o) => o.incident.subjectKey === "provider:versium")
    check("POSITIVE CONTROL: versium failing with batchdata / peopledata healthy → FAILOVER through the chain", v2?.decision.action === "failover" && v2.executed && /routed around/.test(v2.outcome))
    check("batchdata failing → a single-provider capability (dnc_tcpa) has NO alternative → human", k.get("provider:batchdata")?.decision.action === "escalate_human" && k.get("provider:batchdata")?.incident.failoverAvailable === false)
    check("a provider this tenant never uses is not THIS tenant's incident (peopledata is B's)", !k.has("provider:peopledata"))
    check("rentcast rate-limited → backoff (the incident carries the cooldown)", k.get("provider:rentcast")?.decision.action === "backoff" && !!k.get("provider:rentcast")?.incident.retryAfter)
    check("AI SLO breach (50% errors) → ai anomaly → human", k.get("ai_manager:ai_isa")?.decision.action === "escalate_human")
    check("failed render under the requeue cap → retry DELEGATED to the render queue (no second path)", k.get("render:77777777-7777-4777-8777-777777777777")?.decision.action === "retry" && !!k.get("render:77777777-7777-4777-8777-777777777777")?.incident.retryOwner)
    check("failed render past the cap → human", k.get("render:88888888-8888-4888-8888-888888888888")?.decision.action === "escalate_human")
  }

  console.log("\n[B · an open escalation is not re-fired; a cleared one closes]")
  const before = ledgered.length
  const rep2 = await runOsHealthSupervisor(A, svc, { now: new Date(NOW.getTime() + 60_000), detectors, detectorDeps, executorDeps })
  const skipped = rep2.outcomes.filter((o) => o.skipped === "already_escalated").length
  check("second tick: every still-open escalation is skipped (no second bell / ledger row)", skipped > 0 && rep2.outcomes.filter((o) => ["escalate_human", "route_compliance", "route_data_steward", "halt_and_route_finance"].includes(o.decision.action)).every((o) => o.skipped === "already_escalated"))
  check("second tick: only the automatic recoveries were re-ledgered", ledgered.slice(before).every((c) => /\.(retry|resume|backoff|failover)$/.test(c.action)))
  // clear the dead webhook → the detector reads cleanly and no longer sees it → closed 'resolved'
  svc.tables().tenant_webhook_deliveries.length = 0
  const rep3 = await runOsHealthSupervisor(A, svc, { now: new Date(NOW.getTime() + 120_000), detectors, detectorDeps, executorDeps })
  check("a cleared condition is closed (resolved row, by os_health)", rep3.closed >= 1 && svc.tables().self_heal_events.some((r: Row) => r.subject.includes("webhook_subscription") && r.outcome === "resolved"))
  check("a financial halt is NOT auto-closed by silence (only Finance releases)", !svc.tables().self_heal_events.some((r: Row) => r.subject.includes("usage_inconsistencies") && r.outcome === "resolved"))

  console.log("\n[B · retry bound holds across ticks]")
  const svcBound = fakeClient({ manager_signals: [{ id: "s9", brokerage_id: A, status: "open", created_at: hAgo(30) }], self_heal_events: [] })
  const retries: string[] = []
  const boundDeps = { ...executorDeps, retry: async (_s: any, i: HealthIncident) => { retries.push(i.subjectKey); return { ok: true, outcome: "ran" } } }
  for (let t = 0; t < OS_HEALTH_RETRY_CAP + 2; t++) await runOsHealthSupervisor(A, svcBound, { now: new Date(NOW.getTime() + t * 1_800_000), detectors: ["event_backlog"], detectorDeps, executorDeps: boundDeps })
  check(`the retry ran exactly ${OS_HEALTH_RETRY_CAP} times, then escalated once`, retries.length === OS_HEALTH_RETRY_CAP && svcBound.tables().self_heal_events.filter((r: Row) => r.outcome === "escalated").length === 1, `${retries.length} retries`)

  console.log("\n[B · fail closed: an unreadable detector is an incident, never an all-clear]")
  const svcRefuse = fakeClient({ self_heal_events: [], missions: [] }, { refuse: { missions: "permission denied" } })
  const repR = await runOsHealthSupervisor(A, svcRefuse, { now: NOW, detectors: ["stale_missions"], detectorDeps, executorDeps })
  check("refused missions read → detector unreadable + an unknown incident escalated", repR.unreadable.length === 1 && repR.outcomes.some((o) => o.incident.subjectKey === "detector_unreadable:stale_missions" && o.decision.action === "escalate_human"))
  const svcHist = fakeClient({ self_heal_events: [] }, { refuse: { self_heal_events: "denied" } })
  const ledBefore = ledgered.length
  await runOsHealthSupervisor(A, svcHist, { now: NOW, detectors: ["stale_missions"], detectorDeps, executorDeps })
  check("unreadable incident history → NO recovery at all this tick (the bound cannot be honored blind)", ledgered.length === ledBefore)

  // ── C. TENANT SCOPING ──────────────────────────────────────────────────────────────────────
  console.log("\n[C · tenant scoping]")
  const TENANT_TABLES = new Set(["workflow_runs", "meter_readings", "outcome_reconciliations", "reaper_runs", "manager_signals", "tenant_webhook_deliveries", "missions", "self_heal_events", "brokerage_settings", "vendor_usage_tracking", "ai_tool_usage", "event_processing_log", "remotion_composition_renders", "video_render_log", "agent_commissions"])
  const reads = svc.log.filter((q) => q.mode === "select" && TENANT_TABLES.has(q.table))
  const unscoped = reads.filter((q) => !q.filters.some(([op, c, v]) => op === "eq" && c === "brokerage_id" && v === A))
  check("every read of a tenant table is pinned .eq('brokerage_id', A)", reads.length > 0 && unscoped.length === 0, unscoped.map((q) => q.table).join(", "))
  const writes = svc.log.filter((q) => q.mode === "insert" && q.rows)
  check("every insert carries tenant A", writes.length > 0 && writes.every((q) => q.rows!.every((r) => r.brokerage_id === A)), writes.map((q) => q.table).join(","))
  check("no tenant-B row was touched (B's run is still running, B's settings carry no halt)",
    svc.tables().workflow_runs.find((r: Row) => r.brokerage_id === B)?.status === "running" && !resumed.some((k) => k.includes("33333333")) && Object.keys(svc.tables().brokerage_settings.find((r: Row) => r.brokerage_id === B)!.settings).length === 0)
  const stepReads = svc.log.filter((q) => q.table === "workflow_run_steps")
  check("workflow_run_steps is read only by run ids that came from the tenant-pinned runs read", stepReads.every((q) => q.filters.some(([op, c, v]) => op === "in" && c === "run_id" && (v as string[]).every((id) => seed.workflow_runs.find((r) => r.id === id)?.brokerage_id === A))))
  const svcB = fakeClient(seed)
  const repB = await runOsHealthSupervisor(B, svcB, { now: NOW, detectors: ["stuck_workflows", "usage_inconsistencies"], detectorDeps, executorDeps: { ...executorDeps, resume: async () => ({ ok: true, outcome: "x" }) } })
  check("POSITIVE CONTROL: tenant B's own run sees B's incidents (and only B's)", repB.outcomes.length >= 2 && repB.outcomes.every((o) => o.incident.brokerageId === B) && repB.outcomes.some((o) => o.incident.subjectKey.includes("33333333")))

  // static: every .from(...) in the DETECTORS body is followed by a brokerage predicate in its chain
  const osSrc = stripped("lib/kernel/os-health.ts")
  const detBody = osSrc.slice(osSrc.indexOf("export const DETECTORS"), osSrc.indexOf("async function detectIncidents"))
  const scanUnscoped = (body: string): string[] => {
    const out: string[] = []
    const re = /\.from\("([a-z_]+)"\)([\s\S]*?)(?=\.limit\(|\)\s*,\s*\n|$)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(body)) !== null) {
      if (m[1] === "workflow_run_steps") continue // scoped by tenant-pinned run ids (asserted above)
      if (!/\.eq\("brokerage_id",\s*b\)/.test(m[2])) out.push(m[1])
    }
    return out
  }
  check("static: every detector .from() chain carries .eq(\"brokerage_id\", b)", scanUnscoped(detBody).length === 0, scanUnscoped(detBody).join(", "))
  check("POSITIVE CONTROL: the scanner flags a planted unscoped read", scanUnscoped(`svc.from("missions").select("id").limit(5)`).includes("missions"))
  check("static: every detector is registered and every registered detector exists", HEALTH_DETECTORS.every((d) => typeof DETECTORS[d] === "function") && Object.keys(DETECTORS).length === HEALTH_DETECTORS.length)

  // ── D. THE KILL SWITCH ─────────────────────────────────────────────────────────────────────
  console.log("\n[D · kill switch: halt, fail closed, release, honored by every writer]")
  const ks = fakeClient({ brokerage_settings: [{ id: "x", brokerage_id: A, settings: { other_key: 1 }, updated_at: hAgo(1) }], tenant_policy_versions: [] })
  check("POSITIVE CONTROL: no halt set → not halted", !(await loadFinancialWriterHalt(ks, A, "brokerage_earnings")).halted)
  const h1 = await haltFinancialWriter(ks, { brokerageId: A, writer: "brokerage_earnings", reason: "earnings drift", incident: "os_health:billing_drift:financial_writer:brokerage_earnings" })
  check("halt writes through the one settings writer and keeps every other key", h1.ok && (await loadFinancialWriterHalt(ks, A, "brokerage_earnings")).halted && ks.tables().brokerage_settings[0].settings.other_key === 1)
  check("the halt is VERSIONED (tenant_policy_versions row, actor manager)", ks.tables().tenant_policy_versions.some((r: Row) => r.policy_key === FINANCIAL_WRITER_HALTS_POLICY_KEY && r.actor_type === "manager"))
  const h2 = await haltFinancialWriter(ks, { brokerageId: A, writer: "brokerage_earnings", reason: "again", incident: "x" })
  check("halting an already-halted writer is idempotent (no second write)", h2.ok && (h2 as any).alreadyHalted === true)
  check("the halt is per writer (another writer stays live)", !(await loadFinancialWriterHalt(ks, A, "usage_metering")).halted)
  const refused = fakeClient({}, { refuse: { brokerage_settings: "denied" } })
  check("FAIL CLOSED: an unreadable halt state reads as HALTED", (await loadFinancialWriterHalt(refused, A, "usage_metering")).halted)
  const rel = await releaseFinancialWriterHalt(ks, { brokerageId: A, writer: "brokerage_earnings", userId: "u1", reason: "reconciled with finance" })
  check("release (finance) clears the halt, versioned as a user change", rel.ok && !(await loadFinancialWriterHalt(ks, A, "brokerage_earnings")).halted && ks.tables().tenant_policy_versions.some((r: Row) => r.actor_type === "user"))
  for (const [w, spec] of Object.entries(FINANCIAL_WRITERS)) {
    const file = spec.honoredBy.split(" ")[0]
    check(`writer ${w} is honored by ${file} (stripped source reads loadFinancialWriterHalt(…, "${w}"))`, new RegExp(`loadFinancialWriterHalt\\([^)]*"${w}"\\)`).test(stripped(file)))
  }
  check("POSITIVE CONTROL: the honor scan fails on a file that never reads the halt", !/loadFinancialWriterHalt\([^)]*"usage_metering"\)/.test(stripped("lib/finance/team-pl-writer.ts")))
  const releaseSrc = stripped("app/actions/os-health.ts")
  check("release is finance-admin gated + session tenant (resolveBrokerageFinanceAdmin, requireCallerTenant, no tenant argument)",
    /resolveBrokerageFinanceAdmin\(/.test(releaseSrc) && /requireCallerTenant\(\)/.test(releaseSrc) && !/brokerageId\s*:\s*input/.test(releaseSrc))

  // ── E. WIRING ──────────────────────────────────────────────────────────────────────────────
  console.log("\n[E · wiring]")
  check("REAPER_NET carries os_health on the health lane, owned by cron_manager", REAPER_NET.some((e) => e.domain === "os_health" && e.lane === "health" && e.manager === "cron_manager"))
  check("the manager-signals cron runs the health lane over every tenant", /runReaperNet\([^)]*\{\s*lane:\s*"health"\s*\}\)/.test(stripped("app/api/cron/manager-signals/route.ts")) && /from\("brokerages"\)\.select\("id"\)/.test(stripped("app/api/cron/manager-signals/route.ts")))
  check("the command center renders the health line (getOsHealthLine in the panel on the brokerage page)",
    /getOsHealthLine\(\)/.test(stripped("app/dashboard/brokerage/components/command-center/broker-self-heal-panel.tsx")) && /<BrokerSelfHealPanel\s*\/>/.test(stripped("app/dashboard/brokerage/page.tsx")))
  check("financial_writer_halts is a registered tenant policy key", FINANCIAL_WRITER_HALTS_POLICY_KEY in TENANT_POLICY_SETTINGS_KEYS)
  const sigTypes = [...osSrc.matchAll(/signalType:\s*"([a-z_]+)"/g)].map((m) => m[1])
  check("every signal the supervisor publishes is registered, feed-only, kind = the live classifier", sigTypes.length === 3 && sigTypes.every((t) => SIGNAL_REGISTRY[t]?.disposition === "feed_only" && SIGNAL_REGISTRY[t].kind === classifyCoordination(t)), sigTypes.join(","))
  check("the default publisher is the bus (publishManagerSignal) and the default ledger/event are the kernel's",
    /publishManagerSignal\(/.test(osSrc) && /withActionLedger/.test(osSrc) && /emitKernelEvent\(/.test(osSrc))
  // reason code: the code constant and the LATEST migration defining the CHECK agree (derived)
  const al = stripped("lib/kernel/action-ledger.ts")
  const codes = [...(/const ACTION_REASON_CODES = \[([\s\S]*?)\] as const/.exec(al)?.[1] ?? "").matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]).sort()
  const migDir = join(root, "supabase/migrations")
  const latest = readdirSync(migDir).filter((f) => /^m\d+.*\.sql$/.test(f)).sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10))
    .map((f) => readFileSync(join(migDir, f), "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n"))
    .filter((s) => /agent_action_ledger_reason_code_check\s*CHECK/.test(s)).pop() ?? ""
  const sqlCodes = [...(/agent_action_ledger_reason_code_check\s*CHECK\s*\(\s*reason_code\s+IN\s*\(([^)]*)\)/.exec(latest)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]).sort()
  check("OS_HEALTH_RECOVERY is in ACTION_REASON_CODES and in the latest defining migration (lists equal)", codes.includes("OS_HEALTH_RECOVERY") && codes.join() === sqlCodes.join(), `${codes.length} vs ${sqlCodes.length}`)
  const mig = readdirSync(migDir).find((f) => /^m\d+-os-health/.test(f))
  check("the lane migration carries the lane stamp or an APPLIED LIVE stamp on line 1", !!mig && /(WRITTEN, NOT APPLIED|APPLIED LIVE \d{4}-\d{2}-\d{2})/.test(readFileSync(join(migDir, mig!), "utf8").split("\n")[0]))
  const pkg = read("package.json")
  check("test:os-health is in the guard chain (membership, not position)", new RegExp("npm run test:os-health(\\s|&|$)").test(pkg))

  // the health line composes honestly
  const line = composeOsHealthLine({ rows: [], halts: [], lastRunAt: null, now: NOW })
  check("health line: a supervisor that never ran reads UNKNOWN, never ok", line.status === "unknown")
  const okLine = composeOsHealthLine({ rows: [], halts: [], lastRunAt: hAgo(0.2), now: NOW })
  check("POSITIVE CONTROL: a fresh run with nothing open reads ok", okLine.status === "ok")
  check("health line: a halted writer reads BREACH", composeOsHealthLine({ rows: [], halts: [{ writer: "usage_metering" as FinancialWriterKey, label: "x", reason: null, setAt: null }], lastRunAt: hAgo(0.2), now: NOW }).status === "breach")
  check("fold: a later 'resolved' closes an escalation; a recovery 'healed' does not", (() => {
    const s = subjectFor({ detector: "event_backlog", subjectKey: "k" })
    const f1 = foldIncidentHistory([{ subject: s, action: "none", outcome: "escalated", created_at: hAgo(2) }, { subject: s, action: "none", outcome: "resolved", created_at: hAgo(1) }], NOW).get(s)!
    const f2 = foldIncidentHistory([{ subject: s, action: "none", outcome: "escalated", created_at: hAgo(2) }, { subject: s, action: "os_health_retry", outcome: "healed", created_at: hAgo(1) }], NOW).get(s)!
    return !f1.openEscalation && f2.openEscalation
  })())

  console.log(`\n──────────────────────────────────────────────────\n RESULT: ${passed} passed, ${failed} failed`)
  if (failed > 0) { console.log(" ❌ OS_HEALTH_FAIL"); process.exit(1) }
  console.log(" ✅ OS_HEALTH_PASS — every class → its recovery, money halts + Finance, unknown → human, bounded idempotent retries only, tenant-scoped")
}

main().catch((e) => { console.error(e); process.exit(1) })
