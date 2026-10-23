#!/usr/bin/env tsx
/**
 * scripts/healing-policy-guard.ts — npm run test:healing-policy (wave 139, lane 139F; no network, no model)
 * ─────────────────────────────────────────────────────────────────────────────
 * Owner "approve all" (4): self-healing diagnosis / research budgets, max attempts per day, allowed remediation
 * classes and the auto-fix-vs-approval threshold are tenant/platform POLICY — platform ceilings a tenant cannot
 * exceed, today's values the defaults. Plus the healing console (platform + tenant-scoped, structured only).
 *
 *   A  DEFAULTS PRESERVED — no tenant policy + no ceiling = exactly the old constants (derived, not restated),
 *      and the legacy constants ARE the policy defaults; the un-applied column (42703) degrades to the same.
 *   B  CEILING — a tenant value above the platform ceiling is clamped (every number, the confidence floor, the
 *      classes); a tenant value below is honoured (positive control); out-of-bounds stored values ignored.
 *   C  FAIL CLOSED — a refused tenant / ceiling read → readable:false, every cap 0; the troubleshooter
 *      escalates without calling the model.
 *   D  HEALING RESEARCH OBEYS THE POLICY CAP (the 13th required proof) — diagnosis cap, attempts/day, allowed
 *      classes and threshold through troubleshootIncident; the provider research cap + auto-apply threshold
 *      through healProviderFailure with the reader's numbers; the law-rule research caps through
 *      runLawRuleHealing with NO seam (the production shape). Positive control: the default runs research.
 *   E  CONSOLE TENANT-SCOPED — every read of a tenant scope pins brokerage_id; another tenant's rows never
 *      surface; proposals are read only by ids from the tenant's own rows. Positive control: platform scope sees both.
 *   F  NO CHAIN-OF-THOUGHT STORED — a model that returns a planted reasoning field: the schema strips it, no
 *      ledger / self_heal_events row carries it, the console projection never surfaces it (positive control:
 *      the planted text was in the model output); the diagnosis contract names no reasoning field.
 *   G  WIRING + REGISTRATION (stripped source) — the four call sites read the ONE reader, the console is mounted,
 *      the ceiling writer is superadmin-gated + audited, m753, the tenant policy key, chain + ownership.
 */
import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { stripComments } from "./strip-comments"
import {
  HEALING_POLICY_DEFAULTS, HEALING_POLICY_KEY, resolveHealingPolicy, loadHealingPolicy, validateHealingCeilingsEdit,
} from "../lib/kernel/healing-policy"
import { SELF_HEAL_PLAYBOOKS, SELF_HEAL_PLAYBOOK_ATTEMPT_CAP, troubleshootIncident } from "../lib/kernel/self-healing"
import { PROVIDER_RESEARCH_CAP_USD, healProviderFailure } from "../lib/agentic-os/connector-healer"
import { runLawRuleHealing } from "../lib/kernel/law-rule-healing"
import { foldHealingIncidents, loadHealingIncidents } from "../lib/kernel/self-heal-ledger"
import { tenantScope, platformScope } from "../lib/kernel/tenant-scope"
import { TENANT_POLICY_SETTINGS_KEYS, parsePolicyKey } from "../lib/kernel/tenant-policy"
import { MAINTENANCE_DOMAINS } from "../lib/kernel/manager-registry"
import { adapterFor, type ProviderAdapter } from "../lib/kernel/provider-adapters"
import type { HealthIncident } from "../lib/kernel/os-health"

let pass = 0, fail = 0
const ok = (c: unknown, m: string) => { if (c) { pass++; console.log(`  ✓ ${m}`) } else { fail++; console.log(`  ✗ ${m}`) } }
const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8")
const stripped = (p: string) => stripComments(read(p))

// ── in-memory supabase-js stand-in (records every query's eq filters; per-table refusals) ──────
type Row = Record<string, any>
function fakeClient(seed: Record<string, Row[]> = {}, refuse: Record<string, { code?: string; message: string }> = {}) {
  const tables: Record<string, Row[]> = JSON.parse(JSON.stringify(seed))
  const queries: Array<{ table: string; eqs: Array<[string, unknown]>; mode: string }> = []
  let idSeq = 0
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = []
    const eqs: Array<[string, unknown]> = []
    let mode: "select" | "insert" | "update" = "select", payload: any = null, single = false, returning = false, lim = Infinity
    const run = () => {
      queries.push({ table, eqs: [...eqs], mode })
      if (refuse[table]) return { data: null, error: refuse[table] }
      const t = (tables[table] ??= [])
      if (mode === "insert") {
        const rows = (Array.isArray(payload) ? payload : [payload]).map((r: Row) => ({ id: `00000000-0000-4000-8000-${String(++idSeq).padStart(12, "0")}`, created_at: new Date(Date.UTC(2026, 9, 8, 0, 0, idSeq)).toISOString(), ...r }))
        t.push(...rows)
        return { data: returning ? (single ? rows[0] : rows) : null, error: null }
      }
      const hit = t.filter((r) => filters.every((f) => f(r)))
      if (mode === "update") { hit.forEach((r) => Object.assign(r, payload)); return { data: returning ? hit.map((r) => ({ id: r.id })) : null, error: null } }
      if (single) return { data: hit[0] ?? null, error: null }
      return { data: hit.slice(0, lim), error: null }
    }
    const b: any = {
      select: () => { if (mode !== "select") returning = true; return b },
      insert: (p: any) => { mode = "insert"; payload = p; return b },
      update: (p: any) => { mode = "update"; payload = p; return b },
      eq: (c: string, v: unknown) => { eqs.push([c, v]); filters.push((r) => r[c] === v); return b },
      neq: (c: string, v: unknown) => { filters.push((r) => r[c] !== v); return b },
      in: (c: string, v: unknown[]) => { filters.push((r) => v.includes(r[c])); return b },
      gte: (c: string, v: any) => { filters.push((r) => r[c] >= v); return b },
      gt: () => b, lt: () => b, lte: () => b,
      like: (c: string, v: string) => { const pre = v.replace(/%$/, ""); filters.push((r) => String(r[c] ?? "").startsWith(pre)); return b },
      is: (c: string, v: unknown) => { filters.push((r) => (r[c] ?? null) === v); return b },
      order: () => b, limit: (n: number) => { lim = n; return b },
      maybeSingle: () => { single = true; return b }, single: () => { single = true; return b },
      then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
    }
    return b
  }
  return { from, tables: () => tables, queries }
}

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
const SUB = "55555555-5555-4555-8555-555555555555"
const D = HEALING_POLICY_DEFAULTS
const withPolicy = (brokerageId: string, policy: Record<string, unknown> | null, ceiling: Record<string, unknown> | null = null, extra: Record<string, Row[]> = {}) =>
  fakeClient({ brokerage_settings: [{ brokerage_id: brokerageId, settings: policy ? { [HEALING_POLICY_KEY]: policy } : {} }], platform_settings: [{ id: "ps1", created_at: "2026-01-01T00:00:00Z", self_healing_ceilings: ceiling }], ...extra })
const inc = (x: Partial<HealthIncident> = {}): HealthIncident => ({ detector: "failed_webhooks", class: "unknown", brokerageId: A, subjectKey: `webhook_subscription:${SUB}`, subjectId: SUB, subjectType: "tenant_webhook_subscription", summary: "3 webhook deliveries dead after the drain's retries — 503 Service Unavailable", idempotent: false, evidence: { dead: 3, last_error: "503 Service Unavailable" }, ...x })
const dx = (playbook: string, extra: Record<string, unknown> = {}) => ({ diagnosis: "the receiver returned 503 for a short window; one re-enqueue is safe", rootCause: "transient", touches: { money: false, tenantBoundary: false, security: false, dataDeletion: false }, playbook, params: {}, confidence: 0.9, ...extra })
const stubModel = (answer: () => unknown, calls: { n: number }) => async () => { calls.n++; return { object: answer(), usage: { inputTokens: 900, outputTokens: 200, model: "claude-haiku" } } }
const allow = async () => ({ allowed: true, reason: "ok" })

async function main() {
  // ── A. defaults preserved ─────────────────────────────────────────────────
  console.log("\nA. defaults preserved when no policy")
  const none = await loadHealingPolicy(fakeClient(), A)
  ok(none.readable && none.source.tenant === "default" && none.source.ceiling === "default", `no rows → readable, source default/default (${JSON.stringify(none.source)})`)
  ok(none.diagnosisCapUsd === D.diagnosis_cap_usd && none.providerResearchCapUsd === D.provider_research_cap_usd && none.lawRuleResearchCapUsd === D.law_rule_research_cap_usd
    && none.lawRuleResearchMaxCalls === D.law_rule_research_max_calls && none.maxAttemptsPerDay === D.max_attempts_per_day && none.allowedRemediationClasses === null && none.autoFixMinConfidence === D.auto_fix_min_confidence,
    `every effective value is the default (diag $${none.diagnosisCapUsd}, research $${none.providerResearchCapUsd}, law $${none.lawRuleResearchCapUsd}/${none.lawRuleResearchMaxCalls}, ${none.maxAttemptsPerDay}/day, ≥${none.autoFixMinConfidence})`)
  ok(SELF_HEAL_PLAYBOOK_ATTEMPT_CAP === none.maxAttemptsPerDay && PROVIDER_RESEARCH_CAP_USD === none.providerResearchCapUsd, "the legacy constants are exactly the no-policy defaults (kept as defaults only)")
  ok(D.diagnosis_cap_usd === 0.05 && D.provider_research_cap_usd === 0.06 && D.law_rule_research_cap_usd === 0.1 && D.law_rule_research_max_calls === 6 && D.max_attempts_per_day === 2 && D.auto_fix_min_confidence === 0.5,
    "the defaults are the wave-138 values the owner said stay the fallback ($0.05 / $0.06 / $0.10 + 6 / 2 per day / 50%)")
  const unapplied = await loadHealingPolicy(fakeClient({}, { platform_settings: { code: "42703", message: "column platform_settings.self_healing_ceilings does not exist" } }), A)
  ok(unapplied.readable && unapplied.source.ceiling === "unapplied" && unapplied.maxAttemptsPerDay === D.max_attempts_per_day && /m753/.test(unapplied.note ?? ""), "before m753 (42703) the code defaults ARE the ceiling — said in the note, not silent")

  // ── B. ceiling ────────────────────────────────────────────────────────────
  console.log("\nB. a tenant policy cannot exceed the platform ceiling")
  const over = { diagnosis_cap_usd: 2, provider_research_cap_usd: 1, law_rule_research_cap_usd: 3, law_rule_research_max_calls: 40, max_attempts_per_day: 9, auto_fix_min_confidence: 0.1, allowed_remediation_classes: ["re_enqueue_webhook", "re_render", "failover"] }
  const ceil = { diagnosis_cap_usd: 0.02, provider_research_cap_usd: 0.03, law_rule_research_cap_usd: 0.05, law_rule_research_max_calls: 3, max_attempts_per_day: 1, auto_fix_min_confidence: 0.8, allowed_remediation_classes: ["re_render"] }
  const clamped = await loadHealingPolicy(withPolicy(A, over, ceil), A)
  ok(clamped.diagnosisCapUsd === 0.02 && clamped.providerResearchCapUsd === 0.03 && clamped.lawRuleResearchCapUsd === 0.05 && clamped.lawRuleResearchMaxCalls === 3 && clamped.maxAttemptsPerDay === 1,
    "every number above the ceiling is CLAMPED to the ceiling")
  ok(clamped.autoFixMinConfidence === 0.8, "the auto-fix threshold is a FLOOR: a tenant cannot lower it below the platform's (0.1 → 0.8)")
  ok(JSON.stringify(clamped.allowedRemediationClasses) === JSON.stringify(["re_render"]) && clamped.clamped.includes("allowed_remediation_classes"), "classes are tenant ∩ ceiling (a class the platform disallows never runs)")
  ok(clamped.clamped.length === 7, `every clamp is NAMED (${clamped.clamped.join(", ")})`)
  const under = await loadHealingPolicy(withPolicy(A, { diagnosis_cap_usd: 0.01, max_attempts_per_day: 1, auto_fix_min_confidence: 0.9, allowed_remediation_classes: [] }, ceil), A)
  ok(under.diagnosisCapUsd === 0.01 && under.maxAttemptsPerDay === 1 && under.autoFixMinConfidence === 0.9 && under.allowedRemediationClasses?.length === 0
    && !under.clamped.some((f) => ["diagnosis_cap_usd", "max_attempts_per_day", "auto_fix_min_confidence", "allowed_remediation_classes"].includes(f)),
    `POSITIVE CONTROL: STRICTER tenant values are honoured as written (only the unset defaults above this ceiling are clamped: ${under.clamped.join(", ")})`)
  const noCeilOver = resolveHealingPolicy(over, null)
  ok(noCeilOver.diagnosisCapUsd === D.diagnosis_cap_usd && noCeilOver.maxAttemptsPerDay === D.max_attempts_per_day, "with no platform ceiling set, the DEFAULTS are the ceiling (a tenant cannot raise spend on its own)")
  const junk = resolveHealingPolicy({ diagnosis_cap_usd: -1, max_attempts_per_day: 2.5, allowed_remediation_classes: "everything" }, { diagnosis_cap_usd: "NaN" })
  ok(junk.diagnosisCapUsd === D.diagnosis_cap_usd && junk.maxAttemptsPerDay === D.max_attempts_per_day && junk.allowedRemediationClasses === null && junk.ignored.length === 4, `out-of-bounds stored values are IGNORED and named (${junk.ignored.join(", ")})`)
  const declared = Object.entries(SELF_HEAL_PLAYBOOKS).filter(([, p]) => p.acts).map(([k]) => k)
  ok(!validateHealingCeilingsEdit({ diagnosis_cap_usd: 99 }, null, declared).ok && !validateHealingCeilingsEdit({ allowed_remediation_classes: ["drop_table"] }, null, declared).ok, "the ceiling editor refuses an out-of-bounds number and an UNDECLARED class")
  const goodEdit = validateHealingCeilingsEdit({ diagnosis_cap_usd: "0.03", allowed_remediation_classes: ["re_render"] }, null, declared)
  ok(goodEdit.ok && goodEdit.value.diagnosis_cap_usd === 0.03 && goodEdit.value.max_attempts_per_day === D.max_attempts_per_day, "POSITIVE CONTROL: a bounded edit is stored; blank fields keep the current value")

  // ── C. fail closed ────────────────────────────────────────────────────────
  console.log("\nC. fail closed")
  const refusedT = await loadHealingPolicy(fakeClient({}, { brokerage_settings: { code: "57014", message: "statement timeout" } }), A)
  const refusedC = await loadHealingPolicy(fakeClient({}, { platform_settings: { code: "42501", message: "permission denied" } }), A)
  ok(!refusedT.readable && refusedT.diagnosisCapUsd === 0 && refusedT.providerResearchCapUsd === 0 && refusedT.maxAttemptsPerDay === 0 && refusedT.allowedRemediationClasses?.length === 0 && refusedT.autoFixMinConfidence === 1, "a refused TENANT read → readable:false, every cap 0, no class, confidence 1")
  ok(!refusedC.readable && refusedC.lawRuleResearchMaxCalls === 0, "a refused CEILING read (not the absent column) → closed too")
  {
    const calls = { n: 0 }
    const t = await troubleshootIncident(fakeClient({}, { brokerage_settings: { message: "refused" } }), inc(), { playbookAttempts24h: 0, cycle: "c1", attempt: 1 }, { model: stubModel(() => dx("re_enqueue_webhook"), calls), afford: allow, book: async () => {} })
    ok(t.kind === "escalate" && /policy unreadable/.test(t.reason) && calls.n === 0, "the troubleshooter with an unreadable policy escalates to a human — the model is never called")
  }

  // ── D. healing research / diagnosis / attempts obey the policy ──────────────
  console.log("\nD. healing research obeys the policy cap (and attempts / classes / threshold)")
  {
    const calls = { n: 0 }
    const t = await troubleshootIncident(withPolicy(A, { diagnosis_cap_usd: 0 }), inc(), { playbookAttempts24h: 0, cycle: "d1", attempt: 1 }, { model: stubModel(() => dx("re_enqueue_webhook"), calls), afford: allow, book: async () => {} })
    ok(t.kind === "escalate" && /cost cap/.test(t.reason) && calls.n === 0, "a tenant diagnosis cap of $0 → the model is NOT called (cost cap)")
    const calls2 = { n: 0 }
    const t2 = await troubleshootIncident(withPolicy(A, { diagnosis_cap_usd: 1 }, { diagnosis_cap_usd: 0 }), inc(), { playbookAttempts24h: 0, cycle: "d1b", attempt: 1 }, { capUsd: 5, model: stubModel(() => dx("re_enqueue_webhook"), calls2), afford: allow, book: async () => {} })
    ok(t2.kind === "escalate" && calls2.n === 0, "a tenant cap of $1 under a platform ceiling of $0 → still not called; a seam's capUsd cannot raise it either")
  }
  {
    const calls = { n: 0 }, proposals: any[] = []
    const t = await troubleshootIncident(withPolicy(A, { max_attempts_per_day: 1 }), inc(), { playbookAttempts24h: 1, cycle: "d2", attempt: 2 }, { model: stubModel(() => dx("re_enqueue_webhook"), calls), afford: allow, book: async () => {}, propose: async (p) => { proposals.push(p); return { id: "p1", error: null } } })
    ok(t.kind === "escalate" && /exhausted \(1\/1/.test(t.reason) && proposals.length === 1 && calls.n === 0, "attempts/day from the policy (1): the 2nd attempt is a proposal + a human, no model call")
    const calls2 = { n: 0 }
    const t2 = await troubleshootIncident(withPolicy(A, null), inc(), { playbookAttempts24h: 1, cycle: "d2b", attempt: 2 }, { model: stubModel(() => dx("re_enqueue_webhook"), calls2), afford: allow, book: async () => {}, executors: { re_enqueue_webhook: async () => ({ ok: true, outcome: "re-enqueued" }) } })
    ok(t2.kind === "playbook" && calls2.n === 1, "POSITIVE CONTROL: with no policy (default 2/day) the same 2nd attempt runs")
  }
  {
    const ran: string[] = []
    const svc = withPolicy(A, { allowed_remediation_classes: ["re_render"] })
    const t = await troubleshootIncident(svc, inc(), { playbookAttempts24h: 0, cycle: "d3", attempt: 1 }, { model: stubModel(() => dx("re_enqueue_webhook"), { n: 0 }), afford: allow, book: async () => {}, executors: { re_enqueue_webhook: async () => { ran.push("x"); return { ok: true, outcome: "x" } } } })
    ok(t.kind === "escalate" && /no executor this tick|not declared/.test(t.reason) && ran.length === 0, "a remediation class the policy does not allow is never offered — the model's pick is refused, nothing ran")
    const t2 = await troubleshootIncident(withPolicy(A, { allowed_remediation_classes: [] }), inc(), { playbookAttempts24h: 0, cycle: "d3b", attempt: 1 }, { model: stubModel(() => dx("notify_owner_manager", { params: { message: "receiver down" } }), { n: 0 }), afford: allow, book: async () => {}, notify: async () => {} })
    ok(t2.kind === "playbook" && t2.playbook === "notify_owner_manager", "a HAND-OFF (acts:false) stays offered with no acting class allowed — a human is still told")
  }
  {
    const t = await troubleshootIncident(withPolicy(A, { auto_fix_min_confidence: 0.95 }), inc(), { playbookAttempts24h: 0, cycle: "d4", attempt: 1 }, { model: stubModel(() => dx("re_enqueue_webhook"), { n: 0 }), afford: allow, book: async () => {}, executors: { re_enqueue_webhook: async () => { throw new Error("must not run") } } })
    ok(t.kind === "escalate" && /auto-fix threshold 95%/.test(t.reason), "the auto-fix threshold from the policy (95%): a 90% diagnosis waits for a human approval")
  }
  // The provider research cap, as the connector-health cron / os-health failover pass it (the reader's numbers).
  // Wave 139 (139D): the live QBO declaration pins 75 and declares no alternate any more — the research path
  // needs a declared config-level alternate to apply, so this is a FIXTURE of the retired pre-75 shape (the
  // same pattern scripts/self-healing-guard.ts uses), never the live row.
  const qboLive = adapterFor("quickbooks") as ProviderAdapter
  const qbo: ProviderAdapter = { ...qboLive, api: { ...qboLive.api, version: "v3 minorversion=73",
    alternates: [{ id: "qbo_minorversion_75", level: "config", version: "v3 minorversion=75", query: { minorversion: "75" }, supersedesCurrent: true, reason: "fixture: the retired pre-75 declaration's alternate" }] } } as ProviderAdapter
  const qboUndeclared: ProviderAdapter = { ...qbo, api: { ...qbo.api, deprecatedAfter: null, alternates: qbo.api.alternates.map((a) => ({ ...a, supersedesCurrent: false })) } }
  const UP = async () => ({ state: "healthy", routeAround: false, reason: "no faults" })
  const hits = [{ url: "https://developer.intuit.com/changelog/minor-75", title: "QBO minor version 75", text: "Minor versions 1-74 are retired; requests are served as minorversion=75." }]
  const heal = async (policySvc: ReturnType<typeof fakeClient>, cycle: string, finding: Record<string, unknown> = {}) => {
    const p = await loadHealingPolicy(policySvc, A)
    const searched: any[] = [], applied: any[] = [], proposed: any[] = []
    const rep = await healProviderFailure({ connector: "quickbooks", brokerageId: A, failures: [{ status: 400, path: "companyinfo", error: "unsupported minor version" }], cycle, research: { capUsd: p.providerResearchCapUsd, autoApplyMinConfidence: p.autoFixMinConfidence }, retry: async () => ({ ok: true }) }, {
      client: fakeClient(), now: new Date("2026-10-08T12:00:00Z"), probe: async () => "ok", derivedHealth: UP, appliedAlternateId: async () => null, resolveAdapter: () => qboUndeclared,
      search: async (s) => { searched.push(s); return { ok: true, results: hits, costUsd: 0.007, reason: "1" } },
      researchModel: { model: stubModel(() => ({ change: "version_change", newVersion: "minorversion=75", newBaseUrl: null, summary: "use 75", citations: [1], confidence: 0.9, ...finding }), { n: 0 }), afford: allow, book: async () => {} },
      apply: async (_c, x) => { applied.push(x); return { applied: true, proposalId: "pA", reason: "applied" } }, meter: async () => true,
      propose: async (x) => { proposed.push(x); return { proposal: { id: "pP", connector: "quickbooks", proposal_kind: "endpoint_change", proposal_summary: "", confidence: 0.9, status: "pending" }, error: null } },
    })
    return { rep, searched, applied, proposed }
  }
  {
    const tight = await heal(withPolicy(A, { provider_research_cap_usd: 0.005 }), "r1")
    ok(tight.searched.length === 0 && tight.applied.length === 0, "a tenant research cap of $0.005 → NOT researched (refused before any search)")
    const ceilTight = await heal(withPolicy(A, { provider_research_cap_usd: 1 }, { provider_research_cap_usd: 0.005 }), "r2")
    ok(ceilTight.searched.length === 0, "a tenant cap of $1 under a platform ceiling of $0.005 → still NOT researched")
    const closed = await heal(fakeClient({}, { brokerage_settings: { message: "refused" } }), "r3")
    ok(closed.searched.length === 0, "an unreadable policy → research cap 0 → NOT researched (fail closed)")
    const dflt = await heal(withPolicy(A, null), "r4")
    ok(dflt.searched.length === 2 && dflt.applied.length === 1, "POSITIVE CONTROL: the default policy researches (2 metered searches) and applies the declared alternate at 90% confidence")
    const strict = await heal(withPolicy(A, { auto_fix_min_confidence: 0.95 }), "r5")
    ok(strict.searched.length === 2 && strict.applied.length === 0 && strict.proposed.length === 1, "the auto-apply threshold (95%): the same cited 90% finding becomes a PROPOSAL (approval), never applied")
  }
  // The law-rule research caps — production shape (no budget / call seams).
  {
    const lawSvc = (policy: Record<string, unknown> | null, ceiling: Record<string, unknown> | null = null) => withPolicy(A, policy, ceiling, { brokerages: [{ id: A, state: "QX" }], farm_territories: [], agent_licenses: [], state_protected_classes: [], agent_action_ledger: [] })
    const lawDeps = () => ({
      now: new Date("2026-10-08T12:00:00Z"), afford: async () => ({ allowed: true, reason: "ok" }),
      search: async () => ({ answer: null, hits: [], provider: "tavily", cost: 0.01 }), meter: async () => true,
      propose: async () => ({ ok: true, id: "x" }), ledger: (async (_c: any, run: () => Promise<any>) => run()) as any, emit: async () => ({}),
    })
    const byCalls = await runLawRuleHealing(lawSvc({ law_rule_research_max_calls: 1 }), A, lawDeps() as any)
    ok(byCalls.findings.length > 1 && byCalls.researched === 1 && byCalls.refused.some((x) => /call cap \(1\)/.test(x.why)), `the tenant's law-rule call cap (1) holds: ${byCalls.researched} of ${byCalls.findings.length} finding(s) researched`)
    const byCeil = await runLawRuleHealing(lawSvc({ law_rule_research_cap_usd: 5 }, { law_rule_research_cap_usd: 0.02 }), A, lawDeps() as any)
    ok(byCeil.researched === 2 && byCeil.spentUsd <= 0.02 + 1e-9, `the platform ceiling ($0.02) caps a tenant budget of $5: ${byCeil.researched} researched, $${byCeil.spentUsd.toFixed(3)} spent`)
    const lawClosed = await runLawRuleHealing(withPolicy(A, null, null, { brokerages: [{ id: A, state: "QX" }], farm_territories: [], agent_licenses: [], state_protected_classes: [], agent_action_ledger: [] }) as any, A, { ...lawDeps(), policy: { ...(await loadHealingPolicy(fakeClient({}, { brokerage_settings: { message: "x" } }), A)) } } as any)
    ok(lawClosed.researched === 0 && /fail closed/.test(lawClosed.status), "an unreadable policy researches NOTHING on the law-rule pass")
    const lawDefault = await runLawRuleHealing(lawSvc(null), A, lawDeps() as any)
    ok(lawDefault.researched === Math.min(D.law_rule_research_max_calls, lawDefault.findings.length), `POSITIVE CONTROL: the default policy researches up to ${D.law_rule_research_max_calls} (${lawDefault.researched})`)
  }

  // ── E. console tenant-scoped ───────────────────────────────────────────────
  console.log("\nE. the healing console is tenant-scoped")
  const PA = "11111111-1111-4111-8111-111111111111", PB = "22222222-2222-4222-8222-222222222222"
  const nowIso = new Date().toISOString()
  const ledgerRow = (b: string, action: string, extra: Row = {}) => ({ brokerage_id: b, action, actor_manager_key: "cron_manager", subject_ref: `webhook_subscription:${SUB}`, status: "executed", outcome: "ok", reason_detail: "r", provider: null, cost_usd: 0.002, system_source: "os_health", detail: {}, policy_ref: "self_healing@0", created_at: nowIso, ...extra })
  const consoleSeed = {
    agent_action_ledger: [
      ledgerRow(A, "os_health.failed_webhooks.diagnose", { detail: { domain: "webhooks", class: "unknown", diagnosis: { diagnosis: "A: receiver 503", rootCause: "transient", confidence: 0.9, touches: {} } } }),
      ledgerRow(A, "os_health.failed_webhooks.propose", { outcome: `proposal ${PA}` }),
      ledgerRow(B, "os_health.failed_webhooks.propose", { outcome: `proposal ${PB}`, detail: { diagnosis: { diagnosis: "B-SECRET-INCIDENT", rootCause: "data", confidence: 0.7, touches: {} } } }),
    ],
    self_heal_events: [{ brokerage_id: B, subject: `os_health:failed_webhooks:webhook_subscription:${SUB}`, action: "os_health_playbook:re_render", outcome: "healed", created_at: nowIso }],
    connector_healing_proposals: [{ id: PA, status: "pending" }, { id: PB, status: "applied" }],
    improvement_proposals: [],
  }
  const cs = fakeClient(consoleSeed)
  const mine = await loadHealingIncidents(cs, tenantScope(A, "guard"))
  ok(mine.ok && mine.incidents.length === 1 && mine.incidents.every((i) => i.brokerageId === A), `tenant A sees only its own incident (${mine.ok ? mine.incidents.length : "refused"})`)
  ok(mine.ok && !JSON.stringify(mine.incidents).includes("B-SECRET-INCIDENT") && !JSON.stringify(mine.incidents).includes(PB), "tenant B's diagnosis and proposal never reach tenant A")
  const pinned = cs.queries.filter((q) => ["agent_action_ledger", "self_heal_events", "improvement_proposals"].includes(q.table))
  ok(pinned.length >= 2 && pinned.every((q) => q.eqs.some(([c, v]) => c === "brokerage_id" && v === A)), `every tenant-scoped console read pins brokerage_id = A (${pinned.length} reads)`)
  ok(mine.ok && mine.incidents[0].escalation?.proposalId === PA && mine.incidents[0].escalation?.proposalStatus === "pending" && mine.incidents[0].finalState === "proposed", "the proposal is read by the id A's own ledger row names (status pending → final state proposed)")
  const all = await loadHealingIncidents(fakeClient(consoleSeed), platformScope("guard platform view"))
  ok(all.ok && all.incidents.length === 2 && all.incidents.some((i) => i.brokerageId === B && i.finalState === "healed"), "POSITIVE CONTROL: the platform scope sees both tenants (B's final state comes from its self_heal_events row: healed)")
  const refusedConsole = await loadHealingIncidents(fakeClient(consoleSeed, { agent_action_ledger: { message: "refused" } }), tenantScope(A, "guard"))
  ok(!refusedConsole.ok, "a refused ledger read is a refusal — never an empty 'nothing healed'")
  let threw = false
  try { tenantScope(null, "guard") } catch { threw = true }
  ok(threw, "a missing tenant id refuses (it never decays into the every-tenant view)")

  // ── F. no chain-of-thought stored ─────────────────────────────────────────
  console.log("\nF. no chain-of-thought is stored or shown")
  {
    const PLANT = "PLANTED-CHAIN-OF-THOUGHT-7f3a"
    const svc = withPolicy(A, null)
    const out = dx("re_enqueue_webhook", { chainOfThought: PLANT, reasoning: PLANT, thinking: PLANT })
    ok(JSON.stringify(out).includes(PLANT), "POSITIVE CONTROL: the stub model's output DOES carry the planted reasoning text")
    const t = await troubleshootIncident(svc, inc(), { playbookAttempts24h: 0, cycle: "f1", attempt: 1 }, { model: stubModel(() => out, { n: 0 }), afford: allow, book: async () => {}, executors: { re_enqueue_webhook: async () => ({ ok: true, outcome: "re-enqueued" }) } })
    const stored = JSON.stringify(svc.tables())
    ok(t.kind === "playbook" && !stored.includes(PLANT), "the schema strips it: no ledger / self_heal_events row stores the planted reasoning")
    ok(/"diagnosis":\{"diagnosis":"the receiver/.test(stored) && /"rootCause":"transient"/.test(stored), "the STRUCTURED diagnosis (summary, root cause, confidence) is what is stored")
    ok(/self_healing@0/.test(stored), "every troubleshooter ledger row names the policy that permitted it (self_healing@<version>)")
    const folded = foldHealingIncidents({ ledger: [ledgerRow(A, "os_health.failed_webhooks.playbook_re_render", { detail: { domain: "video_render", reasoning: PLANT, chain_of_thought: PLANT, diagnosis: { diagnosis: "render failed once", rootCause: "transient", confidence: 0.8, touches: {}, scratchpad: PLANT } } })], events: [], connectorProposals: [], lawProposals: [] })
    ok(folded.length === 1 && !JSON.stringify(folded).includes(PLANT) && folded[0].diagnosis?.summary === "render failed once" && folded[0].playbook === "re_render", "the console projection is a WHITELIST — a planted reasoning key in a stored detail never surfaces")
    const schemaBlock = (stripped("lib/kernel/self-healing.ts").match(/const DiagnosisSchema = z\.object\(\{[\s\S]*?\n\}\)/) ?? [""])[0]
    const COT = /\b(reason(?:ing)?|thoughts?|thinking|scratchpad|chain_?of_?thought|chainOfThought)\s*:/i
    ok(schemaBlock.length > 50 && !COT.test(schemaBlock), "the diagnosis contract (DiagnosisSchema) names no reasoning / thought field")
    ok(COT.test("chainOfThought: z.string()"), "POSITIVE CONTROL: the field finder recognises a reasoning field")
    ok(!/providerOptions|reasoningEffort|thinking\s*:/.test(stripped("lib/kernel/self-healing.ts")), "the bounded model call requests no extended reasoning output")
  }

  // ── G. wiring + registration ──────────────────────────────────────────────
  console.log("\nG. wiring + registration (stripped source)")
  const sh = stripped("lib/kernel/self-healing.ts")
  ok(/loadHealingPolicy\(svc, i\.brokerageId\)/.test(sh) && /policy\.maxAttemptsPerDay/.test(sh) && /policy\.diagnosisCapUsd/.test(sh) && /policy\.autoFixMinConfidence/.test(sh) && /policy\.allowedRemediationClasses/.test(sh), "the healer (troubleshootIncident) reads every field through the ONE reader")
  ok(!/=\s*0\.05\b|=\s*0\.5\b/.test(sh.replace(/HEALING_POLICY_DEFAULTS\.\w+/g, "")) && /SELF_HEAL_PLAYBOOK_ATTEMPT_CAP = HEALING_POLICY_DEFAULTS\.max_attempts_per_day/.test(sh), "no hard-coded diagnosis cap / threshold left in the healer; the attempt constant is the default alias")
  const osh = stripped("lib/kernel/os-health.ts")
  ok(/loadHealingPolicy\(svc, i\.brokerageId\)/.test(osh) && /capUsd:\s*policy\.providerResearchCapUsd/.test(osh) && !/PROVIDER_RESEARCH_CAP_USD/.test(osh), "os-health failover → healer budgets research from the reader (not the constant)")
  const cron = stripped("app/api/cron/connector-health/route.ts")
  ok(/loadHealingPolicy\(svc, brokerageId\)/.test(cron) && /capUsd:\s*healingPolicy\.providerResearchCapUsd/.test(cron) && !/PROVIDER_RESEARCH_CAP_USD/.test(cron), "the connector-health cron budgets research from the reader (not the constant)")
  const law = stripped("lib/kernel/law-rule-healing.ts")
  ok(/loadHealingPolicy\(svc, brokerageId\)/.test(law) && /policy\.lawRuleResearchCapUsd/.test(law) && /policy\.lawRuleResearchMaxCalls/.test(law) && !/LAW_RULE_RESEARCH_BUDGET_USD|LAW_RULE_RESEARCH_MAX_CALLS/.test(law), "law-rule healing reads its research caps from the reader")
  ok(/runLawRuleHealing\(supabase, b\.id\)/.test(stripped("app/api/cron/regulatory-watcher/route.ts")), "the ONE production law-rule caller passes no budget seam (the policy is the cap)")
  const healer = stripped("lib/agentic-os/connector-healer.ts")
  ok(/rs\.finding\.confidence >= \(input\.research\.autoApplyMinConfidence \?\? 0\)/.test(healer), "the provider healer applies a researched alternate only at or above the policy threshold")
  ok(TENANT_POLICY_SETTINGS_KEYS[HEALING_POLICY_KEY]?.store === "brokerage_settings.settings" && parsePolicyKey(HEALING_POLICY_KEY)?.kind === "settings", "`self_healing` is a registered, versioned tenant policy key (the generic policy-proposal path writes it)")
  const hp = stripped("lib/kernel/healing-policy.ts")
  ok(/from\("platform_settings"\)\.select\("self_healing_ceilings"\)/.test(hp) && /\.update\(\{ self_healing_ceilings:/.test(hp) && /\.select\("id"\)/.test(hp), "the ceiling has ONE reader and ONE writer on the platform_settings singleton (the update is counted)")
  const pc = stripped("app/actions/superadmin/platform-controls.ts")
  const setFn = pc.slice(pc.indexOf("export async function setHealingCeilingsAction"))
  ok(/requireSuperadmin\(\)/.test(setFn.slice(0, 400)) && /superadmin_audit_log/.test(setFn) && /self_healing_ceilings\.set/.test(setFn), "the ceiling writer is superadmin-gated and audited")
  ok(/requirePlatformCapability\("sentinel"\)/.test(pc) && /platformScope\(/.test(pc), "the platform console read is sentinel-gated and states its platform scope")
  const oh = stripped("app/actions/os-health.ts")
  ok(/tenantScope\(caller\.brokerageId/.test(oh) && /isTenantAdmin/.test(oh), "the tenant console read is tenant-admin gated and scoped to the SESSION's brokerage")
  ok(/<HealingConsole\s*\/>/.test(stripped("app/dashboard/superadmin/sentinel/page.tsx")) && /getMyHealingIncidentsAction\(\)/.test(stripped("app/dashboard/brokerage/components/command-center/broker-self-heal-panel.tsx")), "mounted: the sentinel page (platform) and the brokerage self-heal panel (tenant)")
  const migs = readdirSync(join(process.cwd(), "supabase/migrations")).filter((f) => /^m753-/.test(f))
  const mig = migs.length === 1 ? read(`supabase/migrations/${migs[0]}`) : ""
  ok(/^-- ── (WRITTEN, NOT APPLIED|APPLIED LIVE)/.test(mig) && /ADD COLUMN IF NOT EXISTS self_healing_ceilings jsonb/.test(mig), "the ceiling column migration exists (lane stamp or applied stamp)")
  const pkg = JSON.parse(read("package.json"))
  ok(!!pkg.scripts["test:healing-policy"] && new RegExp("npm run test:healing-policy(\\s|&|$)").test(pkg.scripts.guard), "registered: test:healing-policy is in the guard chain")
  const dom = Object.values(MAINTENANCE_DOMAINS as Record<string, { proof: string }>).find((d) => d.proof === "test:healing-policy")
  ok(!!dom, "a MAINTENANCE_DOMAINS entry owns the proof")
  ok(existsSync(join(process.cwd(), "scripts/strip-comments.ts")), "scans read stripped source (scripts/strip-comments.ts)")

  console.log(`\n${fail === 0 ? "RESULT: HEALING_POLICY_PASS" : "RESULT: HEALING_POLICY_FAIL"} — ${pass} passed, ${fail} failed`)
  process.exit(fail === 0 ? 0 : 1)
}

main().catch((e) => { console.error(e); process.exit(1) })
