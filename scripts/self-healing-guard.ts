/**
 * scripts/self-healing-guard.ts — test:self-healing (wave 138, lane 138B).
 *
 * THE SELF-HEALING ENGINE, proven in memory (model + web stubbed; no network, no database):
 *   A. LIBRARY — every domain lists only declared playbooks; every os-health detector has a domain
 *      (derived from HEALTH_DETECTORS, not pinned); breadth across the OS domains.
 *   B. HARD GATE — money, cross-tenant, security and data deletion NEVER auto-act (each a POSITIVE
 *      CONTROL through the real supervisor: the executor spy stays at zero, a human is belled, the
 *      diagnosis is attached); a model's own flag adds a gate; a clean incident is not gated.
 *   C. SELECTION — the model can only select DECLARED playbooks: an invented action, a playbook the
 *      domain may not use, an undeclared parameter and SQL in a parameter are each refused (and the
 *      refusal is ledgered); a valid selection runs through its executor.
 *   D. COST — the cap is enforced BEFORE the call (model never called), the entitlement gate refuses,
 *      and a real call is booked (logAIUsage seam) and lands on the ledger row's cost_usd.
 *   E. BOUNDED ATTEMPTS — SELF_HEAL_PLAYBOOK_ATTEMPT_CAP playbook runs, then a healing PROPOSAL + a
 *      human; the next tick is skipped (already escalated) — no loop.
 *   F. LEDGER + EVENT per step (diagnose, playbook, refused, propose) and a self_heal_events row.
 *   G. PROVIDER SETUP RESEARCH — an UP-but-drifting provider is researched (cost-capped, metered);
 *      a cited finding naming a DECLARED config alternate is applied + retried once; a code-level
 *      finding becomes a proposal carrying the citations; an uncited finding is discarded; a refused
 *      credential is never researched; the cap refuses before any search.
 *   H. WIRING (stripped source): the supervisor troubleshoots every escalate_human below its own retry
 *      bound, the cron budgets research, each owning-rail executor resolves its CANONICAL service.
 *   I. (wave 139A) THE SIX OWNING-RAIL EXECUTORS, each with a positive control:
 *      1 failover runs through routeCapability + healProviderFailure; 2 requeue cannot duplicate an
 *      SMS / email / call / payment (the sent-marker); 3 re_sync calls the canonical sync service;
 *      4 a canonical table in the rebuild set is refused; 5 reconcile_counts recounts the AUTHORITATIVE
 *      table; 6 repeated failure escalates at SELF_HEAL_PLAYBOOK_ATTEMPT_CAP (imported, one source);
 *      7 money, 8 credential, 9 cross-tenant never auto-heal; 11 success records its verification;
 *      12 a failed remediation keeps its evidence and escalates; + reroute hands off and verifies.
 * BLIND SPOTS (published): the model and the web are stubbed (the live Gateway / Exa are proven by
 * their own rails); the gate is a keyword + flag classifier (fail-closed — a false positive costs a
 * human glance); the sync core, the twin builder and the provider healer are SPIES here (they reach
 * the env / network) — their wiring is proven on stripped source, their own proofs prove them; the
 * checklist recompute and the bus publish run REAL against the in-memory client.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import type { TroubleshootDeps } from "../lib/kernel/self-healing"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { HEALTH_DETECTORS, runOsHealthSupervisor, type HealthIncident } from "../lib/kernel/os-health"
import { decideRecovery } from "../lib/kernel/os-health"
import {
  SELF_HEAL_PLAYBOOKS, PLAYBOOK_DOMAINS, DOMAIN_PLAYBOOKS, DETECTOR_DOMAIN, SELF_HEAL_PLAYBOOK_ATTEMPT_CAP,
  classifyForbidden, validatePlaybookSelection, runBoundedModel, troubleshootIncident,
  RESYNC_RAILS, REBUILD_CACHES, RECONCILE_COUNTS, isDerivedCacheTable, requeueVerdict,
} from "../lib/kernel/self-healing"
import { routeCapability } from "../lib/ai-isa/property-lookup-rail"
import { LIVE_TABLES } from "./live-tables"
import { healProviderFailure, matchDeclaredConfigAlternate, providerResearchQueries } from "../lib/agentic-os/connector-healer"
import { adapterFor, type ProviderAdapter } from "../lib/kernel/provider-adapters"
import { z } from "zod"

let pass = 0, fail = 0
const ok = (c: unknown, m: string) => { if (c) { pass++; console.log(`  ✓ ${m}`) } else { fail++; console.log(`  ✗ ${m}`) } }
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

// ── in-memory supabase-js stand-in ───────────────────────────────────────────
type Row = Record<string, any>
/** `defaults` = the live column DEFAULTs a real insert would apply (e.g. manager_signals.status 'open', m217:22). */
function fakeClient(seed: Record<string, Row[]> = {}, defaults: Record<string, Row> = {}) {
  const tables: Record<string, Row[]> = JSON.parse(JSON.stringify(seed))
  let idSeq = 0
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let mode: "select" | "insert" | "update" = "select", payload: any = null, single = false, returning = false, lim = Infinity
    const run = () => {
      const t = (tables[table] ??= [])
      if (mode === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: Row) => ({ id: `00000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`, created_at: new Date().toISOString(), ...(defaults[table] ?? {}), ...r }))
        t.push(...rows)
        return { data: returning ? (single ? rows[0] : rows) : null, error: null }
      }
      const hit = t.filter((r) => filters.every((f) => f(r)))
      if (mode === "update") { hit.forEach((r) => Object.assign(r, payload)); return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null } }
      if (single) return { data: hit[hit.length - 1] ?? null, error: null }
      return { data: hit.slice(0, lim), error: null }
    }
    const b: any = {
      select: () => { if (mode !== "select") returning = true; return b },
      insert: (p: any) => { mode = "insert"; payload = p; return b },
      update: (p: any) => { mode = "update"; payload = p; return b },
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return b },
      neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return b },
      in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return b },
      gte: (c: string, v: any) => { filters.push((r) => r[c] >= v); return b },
      gt: (c: string, v: any) => { filters.push((r) => r[c] > v); return b },
      lt: (c: string, v: any) => { filters.push((r) => r[c] < v); return b },
      lte: (c: string, v: any) => { filters.push((r) => r[c] <= v); return b },
      like: (c: string, v: string) => { const pre = v.replace(/%$/, ""); filters.push((r) => String(r[c] ?? "").startsWith(pre)); return b },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b },
      order: () => b, limit: (n: number) => { lim = n; return b },
      maybeSingle: () => { single = true; return b }, single: () => { single = true; return b },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    }
    return b
  }
  return { from, tables: () => tables }
}

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const SUB = "55555555-5555-4555-8555-555555555555"
const NOW = new Date("2026-10-07T12:00:00.000Z")
const inc = (x: Partial<HealthIncident>): HealthIncident => ({ detector: "failed_webhooks", class: "unknown", brokerageId: A, subjectKey: `webhook_subscription:${SUB}`, subjectId: SUB, subjectType: "tenant_webhook_subscription", summary: "3 webhook deliveries dead after the drain's retries — 503 Service Unavailable", idempotent: false, evidence: { dead: 3, last_error: "503 Service Unavailable" }, ...x })
const dx = (playbook: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ diagnosis: "the receiver returned 503 for a short window; a single re-enqueue is safe (deliveries are idempotency-keyed)", rootCause: "transient", touches: { money: false, tenantBoundary: false, security: false, dataDeletion: false }, playbook, params, confidence: 0.9, ...extra })
/** A model stub that counts calls and answers with `answer`. */
const stubModel = (answer: () => unknown, calls: { n: number }) => async () => { calls.n++; return { object: answer(), usage: { inputTokens: 900, outputTokens: 200, model: "claude-haiku" } } }
const allow = async () => ({ allowed: true, reason: "ok" })
const actions = (c: ReturnType<typeof fakeClient>) => (c.tables().agent_action_ledger ?? []).map((r) => `${r.action}:${r.status}`)

async function main() {
  // ── A. library ─────────────────────────────────────────────────────────────
  console.log("\nA. the declared playbook library")
  const declared = new Set(Object.keys(SELF_HEAL_PLAYBOOKS))
  ok(PLAYBOOK_DOMAINS.every((d) => DOMAIN_PLAYBOOKS[d].length > 0 && DOMAIN_PLAYBOOKS[d].every((k) => declared.has(k))), `every domain (${PLAYBOOK_DOMAINS.length}) lists only declared playbooks (${declared.size} declared)`)
  ok(HEALTH_DETECTORS.every((d) => PLAYBOOK_DOMAINS.includes(DETECTOR_DOMAIN[d])), `every os-health detector (${HEALTH_DETECTORS.length}, derived) maps to a playbook domain`)
  const breadth = ["provider", "sequences", "portal", "esign", "video_render", "direct_mail", "webhooks", "crons", "transactions", "accounting_sync", "enrichment", "scraping"]
  ok(breadth.every((d) => (PLAYBOOK_DOMAINS as readonly string[]).includes(d)), "breadth: provider, sequences, portal, e-sign, video, direct mail, webhooks, crons, transactions, accounting, enrichment, scraping")
  ok(DOMAIN_PLAYBOOKS.accounting_sync.every((k) => !SELF_HEAL_PLAYBOOKS[k].acts), "accounting sync is READ-ONLY diagnosis by declaration (no acting playbook)")

  // ── B. hard gate ───────────────────────────────────────────────────────────
  console.log("\nB. forbidden classes never auto-act (positive controls through the supervisor)")
  ok(!classifyForbidden(inc({})).forbidden, "a clean transient webhook incident is NOT gated (the gate is not blanket)")
  const cases: Array<[string, HealthIncident, string]> = [
    ["money", inc({ detector: "billing_drift", subjectKey: "reconciler:summaries_unmeasured", subjectId: null, subjectType: "reconciler", summary: "drift was escalated but the reconciler could not read the ledger", evidence: { warnings: ["x"] } }), "money"],
    ["money (evidence)", inc({ summary: "dead deliveries for commission payout events" }), "money"],
    ["cross-tenant", inc({ evidence: { dead: 2, brokerage_id: B } }), "tenant_boundary"],
    ["security", inc({ summary: "webhook payload exposed an API key to the receiver" }), "security"],
    ["data deletion", inc({ summary: "deliveries purged by the receiver's retention job" }), "data_deletion"],
  ]
  for (const [label, i, cls] of cases) {
    const g = classifyForbidden(i)
    ok(g.forbidden && g.class === cls, `${label} → gate ${cls}`)
    const svc = fakeClient({ tenant_webhook_deliveries: [{ id: "d1", brokerage_id: A, subscription_id: SUB, status: "dead" }], self_heal_events: [] })
    const calls = { n: 0 }, ran: string[] = [], belled: string[] = []
    const t = await troubleshootIncident(svc, i, { playbookAttempts24h: 0, cycle: "b", attempt: 1 }, {
      model: stubModel(() => dx("re_enqueue_webhook"), calls), afford: allow, book: async () => {},
      executors: { re_enqueue_webhook: async () => { ran.push("x"); return { ok: true, outcome: "ran" } } }, notify: async (_s, x) => { belled.push(x.subjectKey) },
    })
    ok(t.kind === "escalate" && t.gate === cls && ran.length === 0 && (svc.tables().tenant_webhook_deliveries[0].status === "dead"), `${label}: NO playbook ran, nothing moved, escalated (gate=${t.kind === "escalate" ? t.gate : "-"})`)
    ok(t.kind === "escalate" && /AI diagnosis/.test(t.reason) && calls.n === 1, `${label}: the diagnosis is ATTACHED to the human escalation (diagnosis only, no playbook offered)`)
  }
  const flagged = await troubleshootIncident(fakeClient(), inc({}), { playbookAttempts24h: 0, cycle: "b2", attempt: 1 }, {
    model: stubModel(() => dx("re_enqueue_webhook", {}, { touches: { money: false, tenantBoundary: false, security: true, dataDeletion: false } }), { n: 0 }), afford: allow, book: async () => {},
    executors: { re_enqueue_webhook: async () => { throw new Error("must not run") } },
  })
  ok(flagged.kind === "escalate" && flagged.gate === "security", "the model's own security flag ADDS a gate (no action)")
  // The real supervisor: a cross-tenant unknown never reaches an executor.
  {
    const svc = fakeClient({ tenant_webhook_deliveries: [{ id: "d1", brokerage_id: A, subscription_id: SUB, status: "dead", attempts: 5, created_at: "2026-10-07T10:00:00.000Z", error_detail: "rows purged" }], self_heal_events: [] })
    const belled: string[] = [], ran: string[] = []
    const rep = await runOsHealthSupervisor(A, svc, { now: NOW, detectors: ["failed_webhooks"], executorDeps: {
      notifyHuman: async (_s, i) => { belled.push(i.subjectKey) }, emit: async () => ({ error: null }),
      troubleshoot: { model: stubModel(() => dx("re_enqueue_webhook"), { n: 0 }), afford: allow, book: async () => {}, executors: { re_enqueue_webhook: async () => { ran.push("x"); return { ok: true, outcome: "x" } } } },
    } })
    const o = rep.outcomes[0]
    ok(o?.decision.action === "escalate_human" && ran.length === 0 && belled.length === 1 && /DATA DELETION/.test(o.decision.reason), "SUPERVISOR: a data-deletion unknown → human, belled once, executor never called, reason carries the gate")
  }

  // ── C. selection ───────────────────────────────────────────────────────────
  console.log("\nC. the model can only select declared playbooks")
  const avail = new Set(["re_enqueue_webhook", "notify_owner_manager", "backoff"])
  ok(!validatePlaybookSelection("webhooks", { playbook: "drop_table_and_retry" }, avail).ok, "an INVENTED action is refused")
  ok(!validatePlaybookSelection("webhooks", { playbook: "re_render" }, new Set(["re_render"])).ok, "a declared playbook the domain may not use is refused")
  ok(!validatePlaybookSelection("webhooks", { playbook: "re_enqueue_webhook", params: { url: "https://evil.example" } }, avail).ok, "an undeclared parameter is refused")
  ok(!validatePlaybookSelection("webhooks", { playbook: "backoff", params: { minutes: 100000 } }, avail).ok, "an out-of-range parameter is refused")
  ok(!validatePlaybookSelection("webhooks", { playbook: "notify_owner_manager", params: { message: "DELETE FROM contacts WHERE 1=1" } }, avail).ok, "SQL in a parameter is refused (never LLM → SQL)")
  ok(!validatePlaybookSelection("webhooks", { playbook: "requeue" }, avail).ok && !validatePlaybookSelection("sequences", { playbook: "requeue" }, avail).ok, "a declared playbook with NO executor this tick is refused")
  const good = validatePlaybookSelection("webhooks", { playbook: "re_enqueue_webhook", params: { maxDeliveries: 5 } }, avail)
  ok(good.ok && good.playbook === "re_enqueue_webhook", "POSITIVE CONTROL: a declared, domain-allowed, executable selection with valid params passes")
  {
    const svc = fakeClient()
    const t = await troubleshootIncident(svc, inc({}), { playbookAttempts24h: 0, cycle: "c", attempt: 1 }, { model: stubModel(() => dx("run_shell_fix", { cmd: "rm -rf" }), { n: 0 }), afford: allow, book: async () => {} })
    ok(t.kind === "escalate" && /not a declared playbook/.test(t.reason) && actions(svc).includes("os_health.failed_webhooks.playbook_refused:failed"), "end-to-end: an invented action is refused, ledgered (playbook_refused) and escalated")
  }

  // ── D. cost ────────────────────────────────────────────────────────────────
  console.log("\nD. cost cap enforced before the call, entitlement-gated, booked")
  const schema = z.object({ a: z.number() })
  const capCalls = { n: 0 }
  const capped = await runBoundedModel({ brokerageId: A, feature: "t", system: "s", prompt: "p".repeat(4000), schema, capUsd: 0.00001 }, { model: stubModel(() => ({ a: 1 }), capCalls), afford: allow, book: async () => {} })
  ok(!capped.ok && /cost cap/.test(capped.reason) && capCalls.n === 0, `cap below the estimate → model NEVER called (${!capped.ok ? capped.reason.slice(0, 70) : ""})`)
  const refusedCalls = { n: 0 }
  const refused = await runBoundedModel({ brokerageId: A, feature: "t", system: "s", prompt: "p", schema, capUsd: 1 }, { model: stubModel(() => ({ a: 1 }), refusedCalls), afford: async () => ({ allowed: false, reason: "ai_budget_exhausted" }), book: async () => {} })
  ok(!refused.ok && refusedCalls.n === 0 && /entitlement refused/.test(refused.reason), "mayUseAndAfford refusal → model never called")
  const booked: any[] = []
  const paid = await runBoundedModel({ brokerageId: A, feature: "os_self_heal_diagnosis", system: "s", prompt: "p", schema, capUsd: 1 }, { model: stubModel(() => ({ a: 1 }), { n: 0 }), afford: allow, book: async (p) => { booked.push(p) } })
  ok(paid.ok && paid.booked && booked.length === 1 && booked[0].brokerageId === A && booked[0].inputTokens === 900 && paid.costUsd > 0, `a real call is BOOKED once to the tenant ($${paid.ok ? paid.costUsd.toFixed(4) : "?"})`)
  const bad = await runBoundedModel({ brokerageId: A, feature: "t", system: "s", prompt: "p", schema, capUsd: 1 }, { model: stubModel(() => ({ a: "not a number" }), { n: 0 }), afford: allow, book: async () => {} })
  ok(!bad.ok && /schema/.test(bad.reason) && bad.costUsd > 0, "malformed model output is discarded (and its spend still counted)")

  // ── E + F. bounded attempts, ledger + event per step ───────────────────────
  console.log("\nE/F. bounded attempts → proposal; ledger + event + Exception-Center row per step")
  {
    const svc = fakeClient({ tenant_webhook_deliveries: [{ id: "d1", brokerage_id: A, subscription_id: SUB, status: "dead", attempts: 5, created_at: "2026-10-07T10:00:00.000Z", error_detail: "503 Service Unavailable" }, { id: "d2", brokerage_id: B, subscription_id: SUB, status: "dead", attempts: 5, created_at: "2026-10-07T10:00:00.000Z", error_detail: "503" }], self_heal_events: [] })
    const calls = { n: 0 }, events: any[] = [], proposals: any[] = [], booked2: any[] = []
    const deps = {
      emit: async (e: any) => { events.push(e); return { error: null } }, notifyHuman: async () => {},
      troubleshoot: { model: stubModel(() => dx("re_enqueue_webhook", { maxDeliveries: 5 }), calls), afford: allow, book: async (p: any) => { booked2.push(p) },
        propose: async (p: any) => { proposals.push(p); return { id: "prop-1", error: null } } },
    }
    const tick = (min: number) => runOsHealthSupervisor(A, svc, { now: new Date(NOW.getTime() + min * 60_000), detectors: ["failed_webhooks"], executorDeps: deps })
    // the drain fails the re-enqueued delivery again before each tick (the receiver is still down)
    const kill = () => svc.tables().tenant_webhook_deliveries.filter((r) => r.brokerage_id === A).forEach((r) => { r.status = "dead" })
    const r1 = await tick(0)
    ok(r1.outcomes[0]?.playbook === "re_enqueue_webhook" && r1.outcomes[0].executed, `tick 1: diagnosed → re_enqueue_webhook ran (${r1.outcomes[0]?.outcome})`)
    ok(svc.tables().tenant_webhook_deliveries.find((r) => r.id === "d2")?.status === "dead", "the executor moved ONLY this tenant's deliveries (the other tenant's dead row untouched)")
    kill()
    const r2 = await tick(30)
    ok(r2.outcomes[0]?.playbook === "re_enqueue_webhook", "tick 2: second playbook attempt")
    kill()
    const r3 = await tick(60)
    ok(calls.n === SELF_HEAL_PLAYBOOK_ATTEMPT_CAP && proposals.length === 1 && r3.outcomes[0]?.decision.action === "escalate_human" && /exhausted/.test(r3.outcomes[0].decision.reason), `tick 3: bound reached (${SELF_HEAL_PLAYBOOK_ATTEMPT_CAP}) → proposal + human; the model was called exactly ${calls.n}×`)
    ok(proposals[0]?.connector === `os_health:failed_webhooks:webhook_subscription:${SUB}` && proposals[0]?.payload?.brokerage_id === A, "the proposal names the subject + tenant (the one healing-proposal queue)")
    const r4 = await tick(90)
    ok(r4.outcomes[0]?.skipped === "already_escalated" && calls.n === SELF_HEAL_PLAYBOOK_ATTEMPT_CAP && proposals.length === 1, "tick 4: skipped (already escalated) — no loop, no further model call or proposal")
    const acts = actions(svc)
    ok(acts.filter((a) => a === "os_health.failed_webhooks.diagnose:executed").length === 2 && acts.filter((a) => a === "os_health.failed_webhooks.playbook_re_enqueue_webhook:executed").length === 2 && acts.includes("os_health.failed_webhooks.propose:executed") && acts.includes("os_health.failed_webhooks.escalate_human:executed"), `ledger per step: ${[...new Set(acts)].join(", ")}`)
    const ledgerRows = svc.tables().agent_action_ledger ?? []
    ok(ledgerRows.every((r) => r.brokerage_id === A && r.reason_code === "OS_HEALTH_RECOVERY"), "every ledger row is this tenant's, reason OS_HEALTH_RECOVERY")
    ok(ledgerRows.filter((r) => /diagnose/.test(r.action)).every((r) => Number(r.cost_usd) > 0) && booked2.length === 2, "diagnosis cost lands on the ledger row's cost_usd AND is booked (2 calls → 2 bookings)")
    const rows = (svc.tables().self_heal_events ?? []).filter((r) => String(r.action).startsWith("os_health_playbook:"))
    ok(rows.length === 2 && rows.every((r) => r.outcome === "healed" && r.brokerage_id === A), "an Exception-Center row per playbook run (os_health_playbook:*)")
    ok(events.filter((e) => e.metadata?.recovery === "playbook").length === 2 && events.some((e) => e.metadata?.recovery === "escalate_human"), "an os_health.incident event per playbook run and for the escalation")
  }

  // ── G. provider setup research ─────────────────────────────────────────────
  console.log("\nG. provider setup research → cited finding → config apply + retry / code proposal")
  // Wave 139 (lane 139D): the LIVE QBO declaration now pins QBO_MINOR_VERSION (75) with no alternate, so
  // this research proof runs on a FIXTURE of the retired pre-75 declaration (73 + the 75 alternate it
  // carried) — the rule is proven, not the waypoint (CLAUDE.md §2). The live declaration must stay at
  // the pin with nothing to match (asserted by test:provider-adapter section D).
  const qboLive = adapterFor("quickbooks") as ProviderAdapter
  const qbo: ProviderAdapter = { ...qboLive, api: { ...qboLive.api, version: "v3 minorversion=73", deprecatedAfter: "2025-08-01",
    alternates: [{ id: "qbo_minorversion_75", level: "config", version: "v3 minorversion=75", query: { minorversion: "75" }, supersedesCurrent: true, reason: "fixture: the retired pre-75 declaration's alternate" }] } }
  ok(!matchDeclaredConfigAlternate(qboLive, { change: "version_change", newVersion: "minorversion 75", newBaseUrl: null }, null), "the LIVE QBO declaration (pinned 75) matches no researched '75' — there is nothing left to apply")
  const rentcast = adapterFor("rentcast") as ProviderAdapter
  const q = providerResearchQueries(qbo)
  ok(q.length >= 2 && q[0].query.includes(qbo.api.version) && (!qbo.api.docsUrl || q[0].includeDomains?.[0] === new URL(qbo.api.docsUrl).host), `queries carry the declared version + docs host (${q[0].includeDomains?.[0] ?? "no docs host"})`)
  ok(matchDeclaredConfigAlternate(qbo, { change: "version_change", newVersion: "minorversion 75", newBaseUrl: null }, null)?.id === "qbo_minorversion_75", "a researched '75' maps to the DECLARED config alternate qbo_minorversion_75")
  ok(!matchDeclaredConfigAlternate(qbo, { change: "version_change", newVersion: "minorversion 99", newBaseUrl: null }, null), "POSITIVE CONTROL: an undeclared version maps to nothing (the web never points egress at an undeclared change)")
  ok(!matchDeclaredConfigAlternate(qbo, { change: "version_change", newVersion: "v3", newBaseUrl: null }, null), "a token the CURRENT version already carries matches nothing")
  ok(!matchDeclaredConfigAlternate(rentcast, { change: "endpoint_change", newVersion: "v2", newBaseUrl: "https://api.rentcast.io/v2" }, null), "rentcast (code-level alternates only) → no config match")

  const UP = async () => ({ state: "healthy", routeAround: false, reason: "no faults" })
  const hits = [{ url: "https://developer.intuit.com/changelog/minor-75", title: "QBO minor version 75", text: "Minor versions 1-74 are retired; requests are served as minorversion=75." }, { url: "https://status.developer.intuit.com", title: "Intuit status", text: "All systems operational." }]
  // a synthetic declaration whose deprecation is NOT declared yet — so only the research finds it.
  const qboUndeclared: ProviderAdapter = { ...qbo, api: { ...qbo.api, deprecatedAfter: null, alternates: qbo.api.alternates.map((a) => ({ ...a, supersedesCurrent: false })) } }
  {
    const cG = fakeClient(), searched: any[] = [], applied: any[] = [], booked3: any[] = []
    let retries = 0
    const rep = await healProviderFailure({ connector: "quickbooks", brokerageId: A, failures: [{ status: 400, path: "companyinfo", error: "unsupported minor version" }], cycle: "g1", research: { capUsd: 0.06 }, retry: async () => { retries++; return { ok: true } } }, {
      client: cG, now: NOW, probe: async () => "ok", derivedHealth: UP, appliedAlternateId: async () => null, resolveAdapter: () => qboUndeclared,
      search: async (p) => { searched.push(p); return { ok: true, results: hits, costUsd: 0.007, reason: "2" } },
      researchModel: { model: stubModel(() => ({ change: "version_change", newVersion: "minorversion=75", newBaseUrl: null, summary: "Intuit retired minor versions 1-74; use 75", citations: [1], confidence: 0.9 }), { n: 0 }), afford: allow, book: async (p) => { booked3.push(p) } },
      apply: async (_c, p) => { applied.push(p); return { applied: true, proposalId: "pA", reason: `applied ${p.alternateId}` } },
      meter: async () => true,
      propose: async () => { throw new Error("must not propose") },
    })
    ok(rep.decision.step === "none" && searched.length === 2 && searched.every((s) => s.brokerageId === A), "UP + failing with NO declared drift → the provider's setup is RESEARCHED (2 metered searches, tenant-attributed)")
    ok(rep.research?.citations.length === 1 && rep.research.citations[0].url === hits[0].url, "the finding carries its CITATION (the real source URL)")
    ok(applied.length === 1 && applied[0].alternateId === "qbo_minorversion_75" && rep.applied && retries === 1 && rep.retryOk === true, "cited config-level finding → the DECLARED alternate applied through the auto-applier + retried ONCE")
    ok(JSON.stringify(applied[0].evidence).includes(hits[0].url), "the apply evidence row carries the citation")
    const acts = actions(cG)
    ok(acts.join(",") === "provider.heal.probe:executed,provider.heal.research:executed,provider.heal.apply:executed,provider.heal.retry:executed", `every step ledgered: ${acts.join(", ")}`)
    const rrow = (cG.tables().agent_action_ledger ?? []).find((r) => r.action === "provider.heal.research")
    ok(Number(rrow?.cost_usd) >= 0.014 && Number(rrow?.cost_usd) <= 0.06 && booked3.length === 1, `research cost (searches + model) booked on the ledger row ($${Number(rrow?.cost_usd).toFixed(4)}) within the cap; model usage booked`)
  }
  {
    const cE = fakeClient(), proposed: any[] = []
    const rep = await healProviderFailure({ connector: "rentcast", brokerageId: A, failures: [{ status: 200, path: "/avm/value", error: "shape_drift" }], cycle: "g2", research: { capUsd: 0.06 } }, {
      client: cE, now: NOW, probe: async () => "shape_drift", derivedHealth: UP, appliedAlternateId: async () => null,
      search: async () => ({ ok: true, results: [{ url: "https://developers.rentcast.io/changelog", title: "RentCast changelog", text: "The /avm/value response renamed price to priceEstimate." }], costUsd: 0.007, reason: "1" }),
      researchModel: { model: stubModel(() => ({ change: "shape_change", newVersion: null, newBaseUrl: null, summary: "price renamed to priceEstimate", citations: [1], confidence: 0.8 }), { n: 0 }), afford: allow, book: async () => {} },
      apply: async () => { throw new Error("must not apply") },
      propose: async (p) => { proposed.push(p); return { proposal: { id: "pR", connector: "rentcast", proposal_kind: "shape_update", proposal_summary: "", confidence: 0.8, status: "pending" }, error: null } },
    })
    ok(!rep.applied && proposed.length === 1 && proposed[0].researched?.proposalKind === "shape_update" && proposed[0].researched.citations[0].url === "https://developers.rentcast.io/changelog", "code-level researched change → a PROPOSAL carrying the citation, nothing applied")
    ok(actions(cE).join(",") === "provider.heal.probe:executed,provider.heal.research:executed,provider.heal.propose:executed", `ledgered: ${actions(cE).join(", ")}`)
  }
  {
    const cU = fakeClient(), proposed: any[] = []
    const rep = await healProviderFailure({ connector: "rentcast", brokerageId: A, failures: [{ status: 200, path: "/avm/value", error: "shape_drift" }], cycle: "g3", research: { capUsd: 0.06 } }, {
      client: cU, now: NOW, probe: async () => "shape_drift", derivedHealth: UP, appliedAlternateId: async () => null,
      search: async () => ({ ok: true, results: [{ url: "https://developers.rentcast.io/x", title: "x", text: "y" }], costUsd: 0.007, reason: "1" }),
      researchModel: { model: stubModel(() => ({ change: "endpoint_change", newVersion: "v9", newBaseUrl: "https://evil.example/v9", summary: "moved", citations: [7], confidence: 0.9 }), { n: 0 }), afford: allow, book: async () => {} },
      apply: async () => { throw new Error("must not apply") },
      propose: async (p) => { proposed.push(p); return { proposal: { id: "pU", connector: "rentcast", proposal_kind: "shape_update", proposal_summary: "", confidence: 0, status: "pending" }, error: null } },
    })
    ok(rep.research === null && proposed.length === 1 && !proposed[0].researched && /cited no real source/.test((cU.tables().agent_action_ledger ?? []).find((r) => r.action === "provider.heal.research")?.outcome ?? ""), "an UNCITED finding is discarded — the plain proposal path runs, nothing applied")
  }
  {
    const searched: any[] = []
    const rep = await healProviderFailure({ connector: "rentcast", brokerageId: A, failures: [{ status: 401, path: "/avm", error: "unauthorized" }], cycle: "g4", research: { capUsd: 0.06 } }, {
      client: fakeClient(), now: NOW, probe: async () => "auth_failed", derivedHealth: UP, appliedAlternateId: async () => null,
      search: async (p) => { searched.push(p); return { ok: true, results: [], costUsd: 0, reason: "" } },
      propose: async () => ({ proposal: { id: "pK", connector: "rentcast", proposal_kind: "rotate_key", proposal_summary: "", confidence: 0, status: "pending" }, error: null }),
    })
    ok(searched.length === 0 && rep.proposalId === "pK", "a REFUSED CREDENTIAL is never researched (rotate_key proposal; credentials are a human's call)")
  }
  {
    const cC = fakeClient(), searched: any[] = []
    await healProviderFailure({ connector: "rentcast", brokerageId: A, failures: [{ status: 200, path: "/avm", error: "shape_drift" }], cycle: "g5", research: { capUsd: 0.005 } }, {
      client: cC, now: NOW, probe: async () => "shape_drift", derivedHealth: UP, appliedAlternateId: async () => null,
      search: async (p) => { searched.push(p); return { ok: true, results: [], costUsd: 0, reason: "" } },
      propose: async () => ({ proposal: { id: "pC", connector: "rentcast", proposal_kind: "shape_update", proposal_summary: "", confidence: 0, status: "pending" }, error: null }),
    })
    ok(searched.length === 0 && /cost cap/.test((cC.tables().agent_action_ledger ?? []).find((r) => r.action === "provider.heal.research")?.outcome ?? ""), "research cap below two searches → refused BEFORE any search (ledgered)")
  }

  // ── I. owning-rail executors (wave 139A) ───────────────────────────────────
  console.log("\nI. the six owning-rail executors (139A) — typed, bounded, verified, hard stops never act")
  const T = "77777777-7777-4777-8777-777777777777", TB = "88888888-8888-4888-8888-888888888888", C = "99999999-9999-4999-8999-999999999999"
  const nowIso = () => new Date().toISOString()
  const run1 = (svc: ReturnType<typeof fakeClient>, i: HealthIncident, playbook: string, params: Record<string, unknown>, extra: Partial<TroubleshootDeps> = {}, attempts = 0) =>
    troubleshootIncident(svc, i, { playbookAttempts24h: attempts, cycle: `i.${playbook}.${attempts}`, attempt: attempts + 1 }, { model: stubModel(() => dx(playbook, params), { n: 0 }), afford: allow, book: async () => {}, notify: async () => {}, propose: async () => ({ id: "p-i", error: null }), ...extra })
  const lastRow = (c: ReturnType<typeof fakeClient>) => (c.tables().self_heal_events ?? []).filter((r) => String(r.action).startsWith("os_health_playbook:")).pop()
  const Hh = (state: string, routeAround = false) => ({ state, routeAround, reason: state })
  const provInc = (provider: string) => inc({ detector: "provider_failures", class: "provider_failure", subjectKey: `provider:${provider}`, subjectId: null, subjectType: "provider", summary: `${provider} is failing: 3 consecutive faults`, idempotent: true, evidence: { provider, state: "failing", reason: "3 consecutive faults" } })
  const seqInc = () => inc({ detector: "sequence_send_failures", class: "provider_failure", subjectKey: "sequence_provider:twilio", subjectId: null, subjectType: "sequence_send_provider", summary: "5 sequence send(s) failed through twilio in 24h", idempotent: false, evidence: { provider: "twilio", failed: 5 } })
  const esInc = (txn: string) => inc({ detector: "esign_requests", class: "stuck_workflow", subjectKey: `signature_request:${SUB}`, subjectId: SUB, subjectType: "signature_request", summary: "e-sign request sent past its expiry", idempotent: false, evidence: { transaction_id: txn, request_status: "sent" } })
  const evInc = () => inc({ detector: "event_backlog", class: "unknown", subjectKey: "event_handler:twin_refresh", subjectId: null, subjectType: "event_handler", summary: "4 kernel event(s) failed in handler twin_refresh in 24h", idempotent: false, evidence: { handler: "twin_refresh", failures: 4 } })

  // 1 + 11 FAILOVER through the canonical router + healer; success records its verification.
  {
    const health: Record<string, any> = { versium: Hh("failing", true), batchdata: Hh("healthy"), peopledata: Hh("healthy") }
    const heals: any[] = []
    const svc = fakeClient({ self_heal_events: [] })
    const t = await run1(svc, provInc("versium"), "failover", { capability: "owner_contact" }, { services: { providerHealth: async (p) => health[p] ?? null, healProviderFailure: async (x) => { heals.push(x); return { decision: { step: "failover", reason: "versium is DOWN — routed around" } } } } })
    const expected = routeCapability("owner_contact", health, new Set(["versium"])).providers.join(" > ")
    ok(t.kind === "playbook" && t.ok && heals.length === 1 && heals[0].connector === "versium" && heals[0].brokerageId === A && t.outcome.includes(`→ ${expected}`), `1 failover executes through the CANONICAL router (routeCapability → ${expected}) and hands the provider to healProviderFailure once`)
    const row = lastRow(svc)
    ok(row?.outcome === "healed" && row.detail.verification?.verified === true && /batchdata/.test(row.detail.verification.detail), `11 success records its VERIFICATION (${row?.detail.verification?.detail})`)
    ok(row?.detail.evidence?.provider === "versium" && row.detail.attempt === 1 && row.detail.attempt_ceiling === SELF_HEAL_PLAYBOOK_ATTEMPT_CAP && (svc.tables().agent_action_ledger ?? []).some((l) => l.idempotency_key === row.detail.ledger_key && l.action === "os_health.provider_failures.playbook_failover"), "11 incident ↔ evidence ↔ action (ledger key) ↔ attempt ↔ outcome on ONE Exception-Center row")
    const heals2: any[] = [], svc2 = fakeClient({ self_heal_events: [] })
    const none: Record<string, any> = { versium: Hh("failing", true), batchdata: Hh("failing", true), peopledata: Hh("failing", true) }
    const t2 = await run1(svc2, provInc("versium"), "failover", { capability: "owner_contact" }, { services: { providerHealth: async (p) => none[p], healProviderFailure: async (x) => { heals2.push(x); return { decision: { step: "none", reason: "" } } } } })
    ok(t2.kind === "playbook" && !t2.ok && heals2.length === 0 && /no healthy alternate/.test(t2.outcome) && lastRow(svc2)?.outcome === "failed", "POSITIVE CONTROL: no healthy alternate → NOT healed, the healer never called, the row says failed")
    const rl: Record<string, any> = { versium: Hh("rate_limited"), batchdata: Hh("healthy"), peopledata: Hh("healthy") }
    const svc3 = fakeClient({ self_heal_events: [] })
    const t3 = await run1(svc3, provInc("versium"), "failover", { capability: "owner_contact" }, { services: { providerHealth: async (p) => rl[p], healProviderFailure: async () => ({ decision: { step: "none", reason: "UP" } }) } })
    ok(t3.kind === "playbook" && !t3.ok && lastRow(svc3)?.detail.verification?.verified === false, "POSITIVE CONTROL: the router would still serve the rate-limited provider first → verification FAILS, not healed")
    const t4 = await run1(fakeClient({ self_heal_events: [] }), provInc("versium"), "failover", { capability: "everything" }, { services: { providerHealth: async (p) => health[p] } })
    ok(t4.kind === "playbook" && !t4.ok && /not a capability on the router's table/.test(t4.outcome), "an undeclared capability is refused by the typed executor (never free text to a query)")
    // 8 a credential refusal found mid-remediation → hard stop security
    const svc5 = fakeClient({ self_heal_events: [] })
    const t5 = await run1(svc5, provInc("versium"), "failover", { capability: "owner_contact" }, { services: { providerHealth: async (p) => health[p], healProviderFailure: async () => ({ decision: { step: "propose", reason: "UP but refused the key", proposalKind: "rotate_key" } }) } })
    ok(t5.kind === "escalate" && t5.gate === "security" && lastRow(svc5)?.outcome === "failed" && lastRow(svc5)?.detail.hard_stop === "security", "8 a refused CREDENTIAL found mid-remediation is a hard stop → a human at once (never 'healed')")
    const sec = inc({ summary: "the provider rejected the stored credential" })
    ok(classifyForbidden(sec).forbidden && (classifyForbidden(sec) as { class: string }).class === "security" && !classifyForbidden(provInc("versium")).forbidden, "8 a credential signal is gated before any executor (POSITIVE CONTROL: the plain provider incident is not)")
  }

  // REROUTE — capability routing to the accountable manager (a hand-off), verified on the bus.
  {
    const svc = fakeClient({ manager_signals: [], connector_healing_proposals: [], self_heal_events: [] }, { manager_signals: { status: "open" } })
    const t = await run1(svc, provInc("rentcast"), "reroute", { capability: "cma_generate" })
    const sig = () => (svc.tables().manager_signals ?? []).filter((r) => r.signal_type === "capability_dark")
    ok(t.kind === "playbook" && t.ok && !t.acts && sig().length === 1 && sig()[0].to_manager === "listing_concierge" && sig()[0].payload?.capability === "cma_generate" && sig()[0].brokerage_id === A, `reroute routes cma_generate to its accountable manager (${sig()[0]?.to_manager}) through routeDarkCapability + publishManagerSignal`)
    ok(lastRow(svc)?.outcome === "escalated" && lastRow(svc)?.detail.verification?.verified === true, "reroute is a HAND-OFF (row escalated until the owner closes it), verified by re-reading the bus")
    await run1(svc, provInc("rentcast"), "reroute", { capability: "cma_generate" }, {}, 1)
    ok(sig().length === 1, "re-running the reroute publishes nothing new (deduped on payload.capability — idempotent)")
    const svcH = fakeClient({ manager_signals: [], connector_healing_proposals: [{ id: "hp1", connector: "rentcast", status: "pending" }], self_heal_events: [] })
    const tH = await run1(svcH, provInc("rentcast"), "reroute", { capability: "cma_generate" })
    ok(tH.kind === "playbook" && tH.ok && (svcH.tables().manager_signals ?? []).length === 0, "POSITIVE CONTROL: a repair already in flight → held for the healer, NOTHING published")
  }

  // 2 REQUEUE cannot duplicate an SMS / email / call / payment.
  {
    const ex = (id: string, enrollment: string, channel: string, extra: Record<string, unknown> = {}) => ({ id, brokerage_id: A, enrollment_id: enrollment, step_id: "s2", sequence_id: "q1", channel, status: "failed", provider_key: "twilio", provider_message_id: null, sent_at: null, blocked_reason: null, error_message: null, created_at: nowIso(), ...extra })
    const pure = (r: Record<string, unknown>, sib: Record<string, unknown>[] = []) => requeueVerdict(r as never, sib as never)
    const shapes: Array<[string, Record<string, unknown>[], boolean]> = [
      ["sms the PROVIDER refused (error_message)", [ex("v1", "e", "sms", { error_message: "21610 unsubscribed" })], false],
      ["email holding a provider message id", [ex("v2", "e", "email", { provider_message_id: "m-1", blocked_reason: "x" })], false],
      ["ai_call with sent_at", [ex("v3", "e", "ai_call", { sent_at: nowIso(), blocked_reason: "x" })], false],
      ["send_gift (a payment) even gate-refused", [ex("v4", "e", "send_gift", { blocked_reason: "autonomy_gate" })], false],
      ["sms with no gate refusal recorded", [ex("v5", "e", "sms")], false],
    ]
    for (const [label, [r], want] of shapes) ok(pure(r).requeue === want, `2 sent-marker: ${label} → NEVER requeued`)
    ok(!pure(ex("v6", "e", "sms", { blocked_reason: "compliance_gate" }), [{ ...ex("v7", "e", "sms"), status: "delivered", provider_message_id: "SM9" }]).requeue, "2 sent-marker: a SIBLING execution already reached the provider → never requeued")
    ok(pure(ex("v8", "e", "sms", { blocked_reason: "compliance_gate: quiet hours" })).requeue === true, "POSITIVE CONTROL: a step an OS gate refused (provider never called, no sibling sent) IS requeueable")
    const seed = () => ({
      sequence_step_executions: [
        ex("x1", "e1", "sms", { blocked_reason: "compliance_gate: quiet hours" }),
        ex("x2", "e2", "email", { error_message: "550 mailbox unavailable" }),
        ex("x3", "e3", "sms", { provider_message_id: "SM123", blocked_reason: "x" }),
        ex("x4", "e4", "send_gift", { blocked_reason: "autonomy_gate" }),
        ex("x5", "e5", "ai_call", { blocked_reason: "deconflict_gate" }),
        { ...ex("x5b", "e5", "ai_call"), status: "sent", provider_message_id: "CA9", sent_at: nowIso() },
        ex("x6", "e6", "sms", { blocked_reason: "compliance_gate", brokerage_id: B }),
      ],
      campaign_sequence_steps: [{ id: "s2", sequence_id: "q1", step_number: 2 }],
      sequence_enrollments: ["e1", "e2", "e3", "e4", "e5"].map((id) => ({ id, brokerage_id: A, sequence_id: "q1", current_step: 2, status: "active", step_outputs: {} })).concat([{ id: "e6", brokerage_id: B, sequence_id: "q1", current_step: 2, status: "active", step_outputs: {} }]),
      self_heal_events: [],
    })
    const svc = fakeClient(seed())
    const t = await run1(svc, seqInc(), "requeue", { maxSteps: 5 })
    const en = (id: string) => svc.tables().sequence_enrollments.find((r) => r.id === id)
    ok(t.kind === "playbook" && t.ok && en("e1")?.current_step === 1 && ["e2", "e3", "e4", "e5", "e6"].every((id) => en(id)?.current_step === 2), `2 requeue moved ONLY the provably-unsent step (e1 → step 1 again); email / sms-with-id / gift / sibling-sent / other tenant untouched (${t.kind === "playbook" ? t.outcome.slice(0, 90) : ""})`)
    ok(lastRow(svc)?.outcome === "healed" && lastRow(svc)?.detail.verification?.verified === true, "requeue verified by re-reading the enrollment pointer")
    const again = await run1(svc, seqInc(), "requeue", { maxSteps: 5 }, {}, 1)
    ok(again.kind !== "playbook" || !again.ok, "re-running requeue moves nothing (once per step: __requeues marker + current_step CAS — idempotent)")
    ok(en("e1")?.current_step === 1 && en("e1")?.step_outputs?.__requeues?.step_2 === 1, "the requeue marker is on the enrollment (step_outputs.__requeues.step_2 = 1)")
    const svcD = fakeClient({ ...seed(), sequence_step_executions: seed().sequence_step_executions.filter((r) => ["x2", "x3"].includes(r.id)) })
    const tD = await run1(svcD, seqInc(), "requeue", { maxSteps: 5 })
    ok(tD.kind === "escalate" && tD.gate === "external_duplicate" && svcD.tables().sequence_enrollments.every((r) => r.current_step === 2), "2 only AMBIGUOUS sends left → hard stop external_duplicate → a human at once, nothing moved")
    // 7 money — a payment-step-only incident is a money hard stop
    const svcM = fakeClient({ ...seed(), sequence_step_executions: seed().sequence_step_executions.filter((r) => r.id === "x4") })
    const tM = await run1(svcM, seqInc(), "requeue", { maxSteps: 5 })
    ok(tM.kind === "escalate" && tM.gate === "money" && svcM.tables().sequence_enrollments.every((r) => r.current_step === 2), "7 a payment (send_gift) step is never requeued → hard stop money")
  }

  // 3 RE-SYNC calls the canonical sync service; 9 a foreign transaction is a tenant-boundary stop.
  {
    const svc = fakeClient({ transactions: [{ id: T, brokerage_id: A, buyer_contact_id: C, last_provider_sync_at: null }, { id: TB, brokerage_id: B, buyer_contact_id: C, last_provider_sync_at: null }], self_heal_events: [] })
    const syncs: any[] = []
    const stamping = { syncTransactionDocumentsFromProvider: async (x: any) => { syncs.push(x); const r = svc.tables().transactions.find((t) => t.id === x.transactionId); if (r) r.last_provider_sync_at = nowIso(); return { ok: true, synced: 2, skipped: null, error: null } } }
    const t = await run1(svc, esInc(T), "re_sync", { sync: "transaction_documents" }, { services: stamping })
    ok(t.kind === "playbook" && t.ok && syncs.length === 1 && syncs[0].brokerageId === A && syncs[0].transactionId === T && syncs[0].contactId === C && lastRow(svc)?.detail.verification?.verified === true, "3 re_sync calls syncTransactionDocumentsFromProvider (tenant A, its transaction, its contact) and verifies the provider-sync stamp")
    const svcN = fakeClient({ transactions: [{ id: T, brokerage_id: A, buyer_contact_id: C, last_provider_sync_at: null }], self_heal_events: [] })
    const tN = await run1(svcN, esInc(T), "re_sync", { sync: "transaction_documents" }, { services: { syncTransactionDocumentsFromProvider: async () => ({ ok: true, synced: 0, skipped: "no-provider", error: null }) } })
    ok(tN.kind === "playbook" && !tN.ok && lastRow(svcN)?.detail.verification?.verified === false, "POSITIVE CONTROL: a sync that reports ok but never stamped → verification FAILS (not healed)")
    const before = syncs.length
    const tX = await run1(svc, esInc(TB), "re_sync", { sync: "transaction_documents" }, { services: stamping })
    ok(tX.kind === "escalate" && tX.gate === "tenant_boundary" && syncs.length === before && svc.tables().transactions.find((r) => r.id === TB)?.last_provider_sync_at === null, "9 another tenant's transaction in the evidence → hard stop tenant_boundary, the sync never called, nothing touched")
    const stops: Array<[string, string]> = Object.entries(RESYNC_RAILS).filter(([, v]) => v.stop).map(([k, v]) => [k, v.stop as string])
    for (const [key, stop] of stops) {
      const tS = await run1(fakeClient({ transactions: [{ id: T, brokerage_id: A, buyer_contact_id: C }], self_heal_events: [] }), esInc(T), "re_sync", { sync: key }, { services: stamping })
      ok(tS.kind === "escalate" && tS.gate === stop && syncs.length === before, `${stop === "money" ? "7" : stop === "tenant_boundary" ? "9" : "2"} re_sync ${key} is a human's call (${stop}) — never run`)
    }
    const tU = await run1(fakeClient({ self_heal_events: [] }), esInc(T), "re_sync", { sync: "everything" }, { services: stamping })
    ok(tU.kind === "playbook" && !tU.ok && /not a declared sync rail/.test(tU.outcome), "an undeclared sync key is refused by the typed executor")
    const live = Object.entries(RESYNC_RAILS).filter(([, v]) => !v.stop)
    ok(live.length >= 1 && live.every(([, v]) => existsSync(join(process.cwd(), v.rail.split(" ")[0]))), `every LIVE sync rail names a real canonical service file (${live.length} live / ${Object.keys(RESYNC_RAILS).length} declared)`)
  }

  // 4 REBUILD — derived caches only; a canonical table in the rebuild set is refused.
  {
    const svc = fakeClient({ brokerage_twin_snapshots: [], contacts: [{ id: "c1", brokerage_id: A }], self_heal_events: [] })
    const builds: any[] = []
    const builder = (digest: string, stored = digest) => ({ buildBrokerageTwin: async (b: string) => { builds.push(b); const id = `snap-${builds.length}`; svc.tables().brokerage_twin_snapshots.push({ id, brokerage_id: b, digest: stored }); return { twin: { digest }, persist: { snapshotId: id, error: null } } } })
    const t = await run1(svc, evInc(), "rebuild_cache", { cache: "brokerage_twin_snapshot" }, { services: builder("d1") })
    ok(t.kind === "playbook" && t.ok && builds[0] === A && lastRow(svc)?.detail.verification?.verified === true, "rebuild_cache rebuilds the derived twin snapshot (buildBrokerageTwin, this tenant) and verifies the persisted digest")
    const t2 = await run1(svc, evInc(), "rebuild_cache", { cache: "brokerage_twin_snapshot" }, { services: builder("d2", "stale") }, 1)
    ok(t2.kind !== "playbook" || !t2.ok, "POSITIVE CONTROL: a persisted snapshot whose digest disagrees → verification FAILS")
    const n = builds.length
    const tC = await run1(svc, evInc(), "rebuild_cache", { cache: "contacts_rebuild" }, { services: { ...builder("d3"), rebuildSet: { contacts_rebuild: { table: "contacts", rail: "x" } } } })
    ok(tC.kind === "escalate" && tC.gate === "data_deletion" && builds.length === n && svc.tables().contacts.length === 1, "4 a CANONICAL table (contacts) in the rebuild set → refused as a hard stop; the rebuilder never runs, the table untouched")
    const canonical = ["contacts", "leads", "transactions", "listings", "agents", "users", "brokerages", "agent_commissions"].filter((x) => LIVE_TABLES.includes(x))
    ok(canonical.length >= 6 && canonical.every((x) => !isDerivedCacheTable(x)), `4 every canonical live table (${canonical.length}) is refused by isDerivedCacheTable`)
    ok(Object.values(REBUILD_CACHES).every((v) => LIVE_TABLES.includes(v.table) && isDerivedCacheTable(v.table)), `POSITIVE CONTROL: every declared rebuild target is a LIVE derived table (${Object.values(REBUILD_CACHES).map((v) => v.table).join(", ")}); ${LIVE_TABLES.filter(isDerivedCacheTable).length}/${LIVE_TABLES.length} live tables have the derived shape`)
  }

  // 5 RECONCILE COUNTS reads the AUTHORITATIVE table (the real recomputeDocumentChecklist on the in-memory client).
  {
    const docs = [{ id: "d1", transaction_id: T, brokerage_id: A, status: "approved" }, { id: "d2", transaction_id: T, brokerage_id: A, status: "approved" }, { id: "d3", transaction_id: T, brokerage_id: A, status: "pending" }, { id: "d4", transaction_id: TB, brokerage_id: B, status: "approved" }]
    const svc = fakeClient({ transactions: [{ id: T, brokerage_id: A, buyer_contact_id: C }], transaction_documents: docs, document_checklist: [{ id: "dc1", transaction_id: T, brokerage_id: A, total_count: 9, verified_count: 0 }], self_heal_events: [] })
    const t = await run1(svc, esInc(T), "reconcile_counts", { counts: "document_checklist" })
    const dc = svc.tables().document_checklist[0]
    ok(t.kind === "playbook" && t.ok && dc.total_count === 3 && dc.verified_count === 2 && /authoritative transaction_documents: 3 total \/ 2 approved/.test(lastRow(svc)?.detail.verification?.detail ?? ""), `5 reconcile_counts recomputed document_checklist 9/0 → ${dc.total_count}/${dc.verified_count} from transaction_documents and verified it against a FRESH authoritative recount`)
    const svcS = fakeClient({ transactions: [{ id: T, brokerage_id: A, buyer_contact_id: C }], transaction_documents: docs, document_checklist: [{ id: "dc1", transaction_id: T, brokerage_id: A, total_count: 9, verified_count: 0 }], self_heal_events: [] })
    const tS = await run1(svcS, esInc(T), "reconcile_counts", { counts: "document_checklist" }, { services: { recomputeDocumentChecklist: async () => {} } })
    ok(tS.kind === "playbook" && !tS.ok && lastRow(svcS)?.detail.verification?.verified === false, "POSITIVE CONTROL: a derived count left disagreeing with the authoritative recount → verification FAILS")
    for (const [key, v] of Object.entries(RECONCILE_COUNTS).filter(([, x]) => x.stop)) {
      const tM = await run1(fakeClient({ transactions: [{ id: T, brokerage_id: A }], self_heal_events: [] }), esInc(T), "reconcile_counts", { counts: key })
      ok(tM.kind === "escalate" && tM.gate === v.stop, `7 reconcile ${key} (${v.source} → ${v.table}) is a human's call (${v.stop})`)
    }
    ok(Object.values(RECONCILE_COUNTS).every((v) => LIVE_TABLES.includes(v.table) && LIVE_TABLES.includes(v.source) && String(v.table) !== String(v.source)), "every declared count names a LIVE derived table and a different LIVE authoritative source")
  }

  // 6 + 12 REPEATED FAILURE through the SUPERVISOR escalates at the ceiling; the failed attempts keep their evidence.
  {
    ok(decideRecovery(seqInc(), { priorAttempts: 0 }).action === "escalate_human" && decideRecovery(inc({ class: "financial_discrepancy", financialWriter: "usage_metering" }), { priorAttempts: 0 }).action === "halt_and_route_finance", "7 a money incident is halted + routed to Finance (never escalate_human, so never troubleshot); POSITIVE CONTROL: a non-idempotent send failure is escalate_human (troubleshootable)")
    const svc = fakeClient({ sequence_step_executions: [{ id: "y1", brokerage_id: A, enrollment_id: "e1", step_id: "s2", channel: "sms", status: "failed", provider_key: "twilio", error_message: null, blocked_reason: "compliance_gate", created_at: nowIso() }], self_heal_events: [] })
    const belled: string[] = [], proposals: any[] = [], runs = { n: 0 }
    const deps = {
      emit: async () => ({ error: null }), notifyHuman: async (_s: unknown, i: HealthIncident) => { belled.push(i.subjectKey) },
      troubleshoot: { model: stubModel(() => dx("requeue", { maxSteps: 3 }), { n: 0 }), afford: allow, book: async () => {}, propose: async (p: any) => { proposals.push(p); return { id: `prop-${proposals.length}`, error: null } },
        executors: { requeue: async () => { runs.n++; return { ok: true, outcome: "moved 1 enrollment", verification: { verified: false, detail: "re-read: the pointer moved on" } } } } },
    }
    const tick = (k: number) => runOsHealthSupervisor(A, svc, { now: new Date(Date.now() + k * 60_000), detectors: ["sequence_send_failures"], executorDeps: deps })
    const first = await tick(0)
    ok(first.outcomes[0]?.incident.class === "provider_failure" && first.outcomes[0]?.playbook === "requeue", "WIRING: a provider_failure (not only unknown) escalation reaches the requeue executor through the supervisor")
    ok(SELF_HEAL_PLAYBOOK_ATTEMPT_CAP < 2 || (proposals.length === 0 && belled.length === 0), "6 below the ceiling a failed remediation is retried next tick (no proposal, no bell yet)")
    for (let k = 1; k < SELF_HEAL_PLAYBOOK_ATTEMPT_CAP; k++) await tick(k)
    ok(runs.n === SELF_HEAL_PLAYBOOK_ATTEMPT_CAP && proposals.length === 1 && belled.length === 1, `6 repeated failure escalates AT the ceiling (${SELF_HEAL_PLAYBOOK_ATTEMPT_CAP}, imported): ${runs.n} runs → 1 proposal + 1 human`)
    const after = await tick(SELF_HEAL_PLAYBOOK_ATTEMPT_CAP)
    ok(after.outcomes[0]?.skipped === "already_escalated" && runs.n === SELF_HEAL_PLAYBOOK_ATTEMPT_CAP, "after the escalation: skipped (already escalated) — no further run")
    const failedRows = (svc.tables().self_heal_events ?? []).filter((r) => r.action === "os_health_playbook:requeue")
    ok(failedRows.length === SELF_HEAL_PLAYBOOK_ATTEMPT_CAP && failedRows.every((r) => r.outcome === "failed" && r.detail.evidence?.provider === "twilio" && r.detail.verification?.verified === false), "12 every failed remediation KEEPS its evidence + verification on its row")
    ok(proposals[0]?.payload?.failed_attempt?.verification?.verified === false && proposals[0]?.payload?.brokerage_id === A, "12 the escalation proposal carries the failed attempt (outcome + verification + ledger key)")
  }

  // ── H. wiring ──────────────────────────────────────────────────────────────
  console.log("\nH. wiring (stripped source)")
  const osh = stripComments(read("lib/kernel/os-health.ts"))
  ok(/troubleshootIncident\(svc, inc,/.test(osh) && /decision\.action === "escalate_human" && h\.attempts24h < OS_HEALTH_RETRY_CAP/.test(osh), "runOsHealthSupervisor troubleshoots every escalate_human below its OWN retry bound (139A: not only unknowns)")
  const cron = stripComments(read("app/api/cron/connector-health/route.ts"))
  // Re-anchored wave 139F: the budget is the tenant's self-healing policy (the ONE reader), not the default constant.
  ok(/loadHealingPolicy\(/.test(cron) && /research:\s*\{\s*capUsd:\s*\w+\.providerResearchCapUsd\b/.test(cron), "the connector-health cron budgets the research step from the self-healing policy")
  const healer = stripComments(read("lib/agentic-os/connector-healer.ts"))
  ok(/purpose:\s*"provider_setup_research"/.test(healer) && /dispatchWebSearch/.test(healer), "research is metered through the research capability survivor (dispatchWebSearch)")
  const sh = stripComments(read("lib/kernel/self-healing.ts"))
  ok(!/\.rpc\(|\bsql\b\s*\(/i.test(sh), "the troubleshooter issues no rpc / raw SQL")
  ok(/recordHealingProposal/.test(sh) && /proposal_kind:\s*"playbook_exhausted"/.test(sh), "exhausted playbooks write through the ONE healing-proposal writer")
  // 139A — each owning-rail executor's DEFAULT resolves the canonical survivor (the proof injects spies for the env-bound ones).
  const railWires: Array<[string, RegExp]> = [
    ["failover → routeCapability + healProviderFailure", /import\("@\/lib\/ai-isa\/property-lookup-rail"\)[\s\S]*?routeCapability\(capability[\s\S]*?import\("@\/lib\/agentic-os\/connector-healer"\)[\s\S]*?\.healProviderFailure\(/],
    ["reroute → routeDarkCapability + capability_dark on the bus", /routeDarkCapability\(\{[\s\S]*?import\("@\/lib\/kernel\/manager-signals"\)\)\.publishManagerSignal\([\s\S]*?signalType: "capability_dark"/],
    ["requeue → the enrollment pointer, guarded on the failed step (CAS)", /from\("sequence_enrollments"\)\s*\.update\([\s\S]*?\.eq\("current_step", st\.step_number\)\.select\("id"\)/],
    ["re_sync → syncTransactionDocumentsFromProvider", /import\("@\/lib\/transactions\/sync-from-provider"\)\)\.syncTransactionDocumentsFromProvider/],
    // The twin has ONE builder (the Command Center — brokerage-twin guard M2); the rebuild goes through it.
    ["rebuild_cache → buildAndPersistBrokerageTwin (the one twin builder)", /import\("@\/lib\/kernel\/command-center"\)\)\.buildAndPersistBrokerageTwin\(/],
    ["reconcile_counts → recomputeDocumentChecklist", /import\("@\/lib\/documents\/auto-filer"\)\)\.recomputeDocumentChecklist/],
  ]
  for (const [label, re] of railWires) ok(re.test(sh), `canonical service wired: ${label}`)
  const DELETE_RE = /\.delete\(/
  ok(DELETE_RE.test('svc.from("t").delete().eq("id", x)') && !DELETE_RE.test(sh), "the self-healing engine issues NO delete (POSITIVE CONTROL: the finder sees a specimen delete)")
  // The attempt ceiling has ONE source (139F will make it policy — it must not be restated anywhere).
  const CAP_DECL = /\b(?:const|let|var)\s+SELF_HEAL_PLAYBOOK_ATTEMPT_CAP\b/
  const CAP_LITERAL = /playbookAttempts24h\s*>=\s*\d/
  const capFiles = ["lib/kernel", "lib/agentic-os"].flatMap((d) => readdirSync(join(process.cwd(), d)).filter((f) => f.endsWith(".ts")).map((f) => `${d}/${f}`))
  const decls = capFiles.filter((f) => CAP_DECL.test(stripComments(read(f))))
  ok(CAP_DECL.test("export const SELF_HEAL_PLAYBOOK_ATTEMPT_CAP = 2") && CAP_LITERAL.test("if (playbookAttempts24h >= 2)") && decls.length === 1 && decls[0] === "lib/kernel/self-healing.ts" && !capFiles.some((f) => CAP_LITERAL.test(stripComments(read(f)))),
    `the attempt ceiling is declared ONCE (${decls.join(", ")}) across ${capFiles.length} kernel/agentic-os files and never restated as a literal (POSITIVE CONTROL: both finders match their specimens)`)

  console.log(`\n${fail === 0 ? "RESULT: SELF_HEALING_PASS" : "RESULT: SELF_HEALING_FAIL"} — ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
