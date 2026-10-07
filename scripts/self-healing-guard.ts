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
 *   H. WIRING (stripped source): the supervisor troubleshoots unknowns, the cron budgets research.
 * BLIND SPOTS (published): the model and the web are stubbed (the live Gateway / Exa are proven by
 * their own rails); the gate is a keyword + flag classifier (fail-closed — a false positive costs a
 * human glance); owning-rail playbooks (failover / reroute / requeue / re_sync / rebuild_cache /
 * reconcile_counts) are offered only when an executor is injected — none is wired by default yet.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import { HEALTH_DETECTORS, runOsHealthSupervisor, type HealthIncident } from "../lib/kernel/os-health"
import {
  SELF_HEAL_PLAYBOOKS, PLAYBOOK_DOMAINS, DOMAIN_PLAYBOOKS, DETECTOR_DOMAIN, SELF_HEAL_PLAYBOOK_ATTEMPT_CAP,
  classifyForbidden, validatePlaybookSelection, runBoundedModel, troubleshootIncident,
} from "../lib/kernel/self-healing"
import { healProviderFailure, matchDeclaredConfigAlternate, providerResearchQueries } from "../lib/agentic-os/connector-healer"
import { adapterFor, type ProviderAdapter } from "../lib/kernel/provider-adapters"
import { z } from "zod"

let pass = 0, fail = 0
const ok = (c: unknown, m: string) => { if (c) { pass++; console.log(`  ✓ ${m}`) } else { fail++; console.log(`  ✗ ${m}`) } }
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")

// ── in-memory supabase-js stand-in ───────────────────────────────────────────
type Row = Record<string, any>
function fakeClient(seed: Record<string, Row[]> = {}) {
  const tables: Record<string, Row[]> = JSON.parse(JSON.stringify(seed))
  let idSeq = 0
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    let mode: "select" | "insert" | "update" = "select", payload: any = null, single = false, returning = false, lim = Infinity
    const run = () => {
      const t = (tables[table] ??= [])
      if (mode === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: Row) => ({ id: `00000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`, created_at: new Date().toISOString(), ...r }))
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
  const qbo = adapterFor("quickbooks") as ProviderAdapter
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

  // ── H. wiring ──────────────────────────────────────────────────────────────
  console.log("\nH. wiring (stripped source)")
  const osh = stripComments(read("lib/kernel/os-health.ts"))
  ok(/troubleshootIncident\(svc, inc,/.test(osh) && /inc\.class === "unknown"/.test(osh), "runOsHealthSupervisor troubleshoots every unknown → human incident")
  const cron = stripComments(read("app/api/cron/connector-health/route.ts"))
  ok(/research:\s*\{\s*capUsd:\s*PROVIDER_RESEARCH_CAP_USD\s*\}/.test(cron), "the connector-health cron budgets the research step")
  const healer = stripComments(read("lib/agentic-os/connector-healer.ts"))
  ok(/purpose:\s*"provider_setup_research"/.test(healer) && /dispatchWebSearch/.test(healer), "research is metered through the research capability survivor (dispatchWebSearch)")
  const sh = stripComments(read("lib/kernel/self-healing.ts"))
  ok(!/\.rpc\(|\bsql\b\s*\(/i.test(sh), "the troubleshooter issues no rpc / raw SQL")
  ok(/recordHealingProposal/.test(sh) && /proposal_kind:\s*"playbook_exhausted"/.test(sh), "exhausted playbooks write through the ONE healing-proposal writer")

  console.log(`\n${fail === 0 ? "RESULT: SELF_HEALING_PASS" : "RESULT: SELF_HEALING_FAIL"} — ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
