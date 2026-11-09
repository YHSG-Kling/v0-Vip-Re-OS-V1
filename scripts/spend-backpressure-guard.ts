/**
 * scripts/spend-backpressure-guard.ts — SPEND BACKPRESSURE, COST BUDGETING, ACTIVATION GOVERNANCE (wave 150, lane 150HIAB;
 * directive 150AB). npm run test:spend-backpressure (key listed for lane 150I2).
 *
 *   A  the ONE decision (lib/vendor-governance/budget-eval.ts decideSpendBackpressure): proceed / throttle / defer / refuse
 *      in DOLLARS — no price → refuse; an approval without a ceiling → refuse; an unreadable spend ledger → defer; a failing
 *      provider → defer; the approved line or the territory budget binds → throttle (or defer at zero); escalate on each;
 *   B  the REAL paid pooled lane (lib/lead-pipeline/pooled-pull.ts runPooledBatchDataLane) sized by it: a throttled
 *      territory's requests sum to what fits, a spent one issues ZERO requests, an unreadable ledger defers, and the manager
 *      escalation happens INSIDE the same run (no week-late error); the legacy record-cap path is unchanged;
 *   C  production wiring (stripped source): the spend read is ONE vendor_usage_tracking read whose error is read, the unit
 *      price is the transport constant, the escalation is a manager signal to finance_manager registered as an escalation,
 *      and paidPullApproval carries approvedAt;
 *   D  activation is never a heal: provider-config-healing classifies moving traffic onto a provider pending rights as a
 *      source edit (consequential), while a live failover stays a failover.
 *
 * Positive controls: the large-ceiling run DOES pull its full record cap with no escalation (the zeros are not a broken
 * counter); a planted fixture without the error read is flagged by the wiring regex.
 *
 * BLIND SPOTS (published): the spend read sums vendor_usage_tracking by (brokerage, usage_type = lane) since the approval —
 * a booking under another usage_type is not counted; the per-territory Apify / Exa / ZenRows / Tavily / FSBO pulls in the
 * cron are not dollar-sized here (the cron is outside this lane; Outside-lane); the territory budget is read from the
 * market row the cron passes (absent = not constraining; the approved line still is).
 */
import { readFileSync } from "fs"
import { join } from "path"
import { createRequire } from "node:module"
import { stripComments } from "./strip-comments"

const _require = createRequire(import.meta.url)
try {
  const soPath = _require.resolve("server-only")
  _require.cache[soPath] = { id: soPath, filename: soPath, loaded: true, exports: {} } as any
} catch { /* not installed */ }

const ROOT = process.cwd()
let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail = "") {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`) }
}
const stripped = (p: string) => stripComments(readFileSync(join(ROOT, p), "utf8"))

async function main() {
  const { decideSpendBackpressure } = await import("../lib/vendor-governance/budget-eval")
  const { runPooledBatchDataLane } = await import("../lib/lead-pipeline/pooled-pull")
  const { paidPullApproval } = await import("../lib/lead-pipeline/source-discovery-planner")
  const { classifyProviderConfigChange } = await import("../lib/kernel/provider-config-healing")

  console.log("\nA — the one backpressure decision")
  const base = { wantRecords: 100, unitUsd: 0.05, approvedMaxUsd: 10, approvedSpentUsd: 0 }
  const ok = decideSpendBackpressure(base)
  check("positive control: $5 of $10 → proceed, 100 records, no escalation", ok.action === "proceed" && ok.records === 100 && ok.usd === 5 && !ok.escalate, JSON.stringify(ok))
  const thr = decideSpendBackpressure({ ...base, approvedSpentUsd: 7 })
  check("$3 left at $0.05 → throttle to 60 records and escalate", thr.action === "throttle" && thr.records === 60 && thr.escalate, JSON.stringify(thr))
  const spent = decideSpendBackpressure({ ...base, approvedSpentUsd: 10 })
  check("a spent approval → defer, zero records, escalate", spent.action === "defer" && spent.records === 0 && spent.escalate)
  check("no documented price → refuse (never a paid call at an unknown price)", decideSpendBackpressure({ ...base, unitUsd: null }).action === "refuse" && decideSpendBackpressure({ ...base, unitUsd: 0 }).action === "refuse")
  check("an approval without a ceiling → refuse", decideSpendBackpressure({ ...base, approvedMaxUsd: null }).action === "refuse")
  check("an unreadable spend ledger → defer + escalate (fail closed)", (() => { const v = decideSpendBackpressure({ ...base, approvedSpentUsd: null }); return v.action === "defer" && v.escalate })())
  check("a failing provider → defer + escalate (retried next cycle, not blindly)", (() => { const v = decideSpendBackpressure({ ...base, providerFailing: true }); return v.action === "defer" && v.escalate && /failing/.test(v.reason) })())
  const terr = decideSpendBackpressure({ ...base, territoryRemainingUsd: 2 })
  check("the territory's monthly budget binds when it is the smaller → 40 records, named", terr.action === "throttle" && terr.records === 40 && /territory/.test(terr.reason), JSON.stringify(terr))

  console.log("\nB — the real pooled lane, sized in dollars")
  const territory = (id: string, brokerage: string) => ({ id, brokerage_id: brokerage, state: "TX", zip_codes: ["78701"], max_records_per_run: 100 })
  const makeDeps = (over: Record<string, unknown>) => {
    const takes: number[] = []
    const escalations: Array<{ action: string; at: number }> = []
    let tick = 0
    const deps: any = {
      search: async (o: { limit: number }) => { tick++; takes.push(o.limit); return { records: [], cost: 0 } },
      dateWindow: () => ({}), statusWindow: () => true, geographyCriteria: () => ({}), maxTake: 1000, maxInList: 100,
      approval: () => ({ allowed: true, maxSpendUsd: 10, approvedAt: "2026-11-01T00:00:00Z" }),
      unitUsd: 0.05,
      spentSinceApproval: () => 7,
      escalate: (e: { action: string }) => { escalations.push({ action: e.action, at: tick }) },
      ...over,
    }
    return { deps, takes, escalations }
  }
  const want = (b: string) => [{ territory: territory(`t-${b}`, b), triggers: ["preforeclosure"], lookbackDays: null }]
  const t1 = makeDeps({})
  const r1 = await runPooledBatchDataLane("batchdata_motivated", want("b1"), t1.deps)
  check("throttled: the paid request asks for 60 records ($3 left), not the 100 record cap", t1.takes.reduce((s, n) => s + n, 0) === 60 && r1.ledger.throttledTerritories === 1, JSON.stringify(t1.takes))
  check("the escalation happened INSIDE the run, before the paid request (same cycle)", t1.escalations.length === 1 && t1.escalations[0].at === 0 && t1.escalations[0].action === "throttle")
  const t2 = makeDeps({ spentSinceApproval: () => 10 })
  const r2 = await runPooledBatchDataLane("batchdata_motivated", want("b2"), t2.deps)
  check("spent: ZERO paid requests, the territory deferred and named in errors", t2.takes.length === 0 && r2.ledger.deferredTerritories === 1 && r2.errors.some((e) => /deferred/.test(e)))
  const t3 = makeDeps({ spentSinceApproval: undefined })
  const r3 = await runPooledBatchDataLane("batchdata_motivated", want("b3"), t3.deps)
  check("no spend reader → unreadable → deferred, zero requests", t3.takes.length === 0 && r3.ledger.deferredTerritories === 1)
  const t4 = makeDeps({ approval: () => ({ allowed: true, maxSpendUsd: null, approvedAt: null }) })
  await runPooledBatchDataLane("batchdata_motivated", want("b4"), t4.deps)
  check("an approval with a null ceiling → refused, zero requests", t4.takes.length === 0 && t4.escalations.some((e) => e.action === "refuse"))
  const t5 = makeDeps({ approval: () => ({ allowed: true, maxSpendUsd: 1000, approvedAt: "2026-11-01T00:00:00Z" }), spentSinceApproval: () => 0 })
  const r5 = await runPooledBatchDataLane("batchdata_motivated", want("b5"), t5.deps)
  check("positive control: a large ceiling pulls the full 100-record cap with no escalation", t5.takes.reduce((s, n) => s + n, 0) === 100 && t5.escalations.length === 0 && (r5.ledger.throttledTerritories ?? 0) === 0)
  const t6 = makeDeps({ unitUsd: undefined, approval: () => ({ allowed: true }) })
  await runPooledBatchDataLane("batchdata_motivated", want("b6"), t6.deps)
  check("legacy deps (no unitUsd / ceiling) keep the record cap alone — unchanged", t6.takes.reduce((s, n) => s + n, 0) === 100 && t6.escalations.length === 0)
  const t7 = makeDeps({ approval: () => ({ allowed: false, reason: "no approved plan" }) })
  await runPooledBatchDataLane("batchdata_motivated", want("b7"), t7.deps)
  check("the approval gate still runs FIRST: unapproved → zero requests, no backpressure call", t7.takes.length === 0 && t7.escalations.length === 0)

  console.log("\nC — production wiring")
  const pp = stripped("lib/lead-pipeline/pooled-pull.ts")
  const wiring = /const \{ data: rows, error: spendErr \} = await createServiceClient\(\)\s*\.from\("vendor_usage_tracking"\)/
  check("the spend read is ONE vendor_usage_tracking read whose error is destructured and read", wiring.test(pp) && /if \(spendErr\)/.test(pp) && /spendRows = spendErr \? null/.test(pp))
  check("positive control: a planted read without the error is NOT matched", !wiring.test(`const { data: rows } = await createServiceClient()\n.from("vendor_usage_tracking")`))
  check("the unit price is the transport constant (no second spelling)", /unitUsd: bd\.BATCHDATA_PROPERTY_SEARCH_RECORD_COST_USD/.test(pp))
  check("the escalation is a manager signal to finance_manager (signal autonomy_budget_escalated), deduped per territory", /signalType: "autonomy_budget_escalated"/.test(pp) && /toManager: "finance_manager"/.test(pp) && /entityId: e\.territoryId/.test(pp))
  const reg = stripped("lib/kernel/signal-registry.ts")
  check("that signal is registered as an escalation consumed by finance_manager", /autonomy_budget_escalated:\s*\{\s*consumers:\s*\["finance_manager"\][^}]*kind:\s*"escalation"/.test(reg))
  const v = paidPullApproval([{ id: "p1", brokerage_id: "b", status: "approved", valid_until: "2099-01-01T00:00:00Z", lines: [{ source: "batchdata_motivated", status: "approved", maxSpendUsd: 12, approvedAt: "2026-11-02T00:00:00Z" }] }], { brokerageId: "b", source: "batchdata_motivated" })
  check("paidPullApproval carries the ceiling AND approvedAt (what spend is measured from)", v.allowed === true && (v as any).maxSpendUsd === 12 && (v as any).approvedAt === "2026-11-02T00:00:00Z")

  console.log("\nD — activation is never a heal")
  const toDormant = classifyProviderConfigChange({ kind: "runtime_failover", connector: "versium", capability: "owner_contact", toProvider: "tracerfy", summary: "route around", confidence: 0.99 }, { declaredConfigAlternate: false })
  check("failover onto a provider pending rights → consequential source edit (an activation)", toDormant.verdict === "consequential" && toDormant.class === "production_source_edit", JSON.stringify(toDormant))
  const mapped = classifyProviderConfigChange({ kind: "persisted_mapping", connector: "versium", capability: "owner_contact", toProvider: "datazapp", summary: "persist", confidence: 1 }, { declaredConfigAlternate: false })
  check("a persisted mapping onto DataZapp → consequential source edit", mapped.verdict === "consequential" && mapped.class === "production_source_edit")
  const live = classifyProviderConfigChange({ kind: "runtime_failover", connector: "versium", capability: "owner_contact", toProvider: "batchdata", summary: "route around", confidence: 0.9 }, { declaredConfigAlternate: false })
  check("positive control: failover onto a dormant SURVIVOR whose doors wait on the owner stays a failover", live.class === "provider_failover", JSON.stringify(live))

  // ═══ Wave 151 (lane 151F): the OWNER'S platform acquisition caps (null = stop before spend) and the PRE-PULL VALUE verdict ═══
  console.log("\nE — the owner's platform acquisition caps: no made-up default, null = stop before spend")
  const caps = await import("../lib/vendor-governance/platform-acquisition-caps")
  const full = { monthly_usd: 100, per_tenant_monthly_usd: 20, per_pull_usd: 5, set_by: "owner", set_at: "2026-11-09T00:00:00.000Z" }
  check("no caps row → REFUSE (stop before spend), escalate", (() => { const v = caps.decidePlatformAcquisitionSpend({ caps: null, platformSpentMonthUsd: 0, tenantSpentMonthUsd: 0, wantUsd: 1 }); return v.action === "refuse" && v.escalate && /not configured/.test(v.reasons.join()) })())
  check("ANY null cap → REFUSE naming the field (never a substituted default)", (() => { const v = caps.decidePlatformAcquisitionSpend({ caps: { ...full, per_pull_usd: null }, platformSpentMonthUsd: 0, tenantSpentMonthUsd: 0, wantUsd: 1 }); return v.action === "refuse" && /Per paid pull/.test(v.reasons.join()) })())
  check("an unreadable ledger → REFUSE (never zero spend assumed)", caps.decidePlatformAcquisitionSpend({ caps: full, platformSpentMonthUsd: null, tenantSpentMonthUsd: 0, wantUsd: 1 }).action === "refuse" && caps.decidePlatformAcquisitionSpend({ caps: full, platformSpentMonthUsd: 0, tenantSpentMonthUsd: null, wantUsd: 1 }).action === "refuse")
  check("positive control: a want that fits every cap proceeds, naming the binding cap and its remainder", (() => { const v = caps.decidePlatformAcquisitionSpend({ caps: full, platformSpentMonthUsd: 10, tenantSpentMonthUsd: 2, wantUsd: 4 }); return v.action === "proceed" && v.allowedUsd === 4 && v.remainingUsd === 5 && !v.escalate })())
  check("the per-tenant cap binds when it is the smallest → throttle to the remainder, escalate", (() => { const v = caps.decidePlatformAcquisitionSpend({ caps: full, platformSpentMonthUsd: 10, tenantSpentMonthUsd: 18, wantUsd: 4 }); return v.action === "throttle" && v.allowedUsd === 2 && /Per-tenant/.test(v.reasons.join()) && v.escalate })())
  check("an exhausted monthly cap → refuse", caps.decidePlatformAcquisitionSpend({ caps: full, platformSpentMonthUsd: 100, tenantSpentMonthUsd: 0, wantUsd: 1 }).action === "refuse")
  check("the edit validator: a negative or non-numeric cap is an error; blank keeps; explicit null is STOP; a number is kept to cents", (() => {
    const bad = caps.validateAcquisitionCapsEdit({ monthly_usd: -1 }, null, { userId: "u" }); const neg = !bad.ok
    const nan = !caps.validateAcquisitionCapsEdit({ monthly_usd: "abc" }, null, { userId: "u" }).ok
    const keep = caps.validateAcquisitionCapsEdit({ monthly_usd: "" }, full, { userId: "u" }); const stop = caps.validateAcquisitionCapsEdit({ monthly_usd: null }, full, { userId: "u" }); const num = caps.validateAcquisitionCapsEdit({ monthly_usd: "12.345" }, full, { userId: "u" })
    return neg && nan && keep.ok && keep.value.monthly_usd === 100 && stop.ok && stop.value.monthly_usd === null && num.ok && num.value.monthly_usd === 12.35 && num.value.set_by === "u"
  })())
  check("parseAcquisitionCaps: an absent / non-number field reads NULL, never a default", (() => { const p = caps.parseAcquisitionCaps({ monthly_usd: 5, per_pull_usd: "x" }); return !!p && p.monthly_usd === 5 && p.per_tenant_monthly_usd === null && p.per_pull_usd === null && caps.parseAcquisitionCaps("nope") === null })())
  const { memSupabase } = await import("./in-memory-supabase")
  const dbAbsent = memSupabase({ platform_settings: [{ id: true, created_at: "2026-01-01" }] }, { missingColumns: { platform_settings: ["acquisition_budget_caps"] } })
  const absent = await caps.loadPlatformAcquisitionCaps(dbAbsent as never)
  check("loader: the column absent (m976 unapplied) reads applied:false, caps null — and the writer refuses to write", absent.ok && !absent.applied && absent.caps === null && !(await caps.setPlatformAcquisitionCaps(dbAbsent as never, { monthly_usd: 1 }, { userId: "u" })).ok)
  const dbRefused = memSupabase({ platform_settings: [] }, { refuse: { platform_settings: "permission denied" } })
  check("loader: a REFUSED read is ok:false (never 'no caps set')", !(await caps.loadPlatformAcquisitionCaps(dbRefused as never)).ok)
  const dbLive = memSupabase({ platform_settings: [{ id: true, created_at: "2026-01-01", acquisition_budget_caps: null }], vendor_usage_tracking: [
    { brokerage_id: "b1", total_cost: 3, request_metadata: { system_source: "lead_scraping", coverage: "platform_covered" }, created_at: new Date().toISOString() },
    { brokerage_id: "b2", total_cost: 2, request_metadata: { system_source: "lead_scraping" }, created_at: new Date().toISOString() },
    { brokerage_id: "b1", total_cost: 9, request_metadata: { system_source: "tenant_provider_connection", coverage: "tenant_paid" }, created_at: new Date().toISOString() },
    { brokerage_id: "b1", total_cost: 7, request_metadata: { system_source: "ai_isa" }, created_at: new Date().toISOString() },
  ] })
  const w = await caps.setPlatformAcquisitionCaps(dbLive as never, { monthly_usd: 10, per_tenant_monthly_usd: 4, per_pull_usd: 2 }, { userId: "owner" })
  const spend = await caps.loadPlatformAcquisitionSpend(dbLive as never, { tenantId: "b1" })
  check("writer: a counted update lands all three caps with the actor; the spend read sums ONLY platform-covered acquisition rows (tenant-paid and non-acquisition rows excluded)", w.ok && w.after.monthly_usd === 10 && w.after.set_by === "owner" && spend.platformUsd === 5 && spend.tenantUsd === 3 && spend.rows === 2)
  const rem = await caps.platformCapRemainingFor(dbLive as never, "b1")
  check("platformCapRemainingFor hands backpressure the binding remainder ($1 left under b1's $4 per-tenant cap after $3)", rem.remainingUsd === 1 && rem.verdict.action === "proceed")
  const remNone = await caps.platformCapRemainingFor(memSupabase({ platform_settings: [{ id: true, created_at: "2026-01-01", acquisition_budget_caps: null }], vendor_usage_tracking: [] }) as never, "b1")
  check("…and null when the caps are unset (the backpressure then refuses)", remNone.remainingUsd === null && remNone.verdict.action === "refuse")
  check("backpressure: platformCapRemainingUsd null → REFUSE with the stop-before-spend reason, escalate", (() => { const v = decideSpendBackpressure({ ...base, platformCapRemainingUsd: null }); return v.action === "refuse" && /not configured/.test(v.reason) && v.escalate })())
  check("backpressure: the platform cap binds when it is the smallest → throttle, named as the owner's cap", (() => { const v = decideSpendBackpressure({ ...base, platformCapRemainingUsd: 1 }); return v.action === "throttle" && v.records === 20 && /platform acquisition cap/.test(v.reason) })())
  check("backpressure: undefined (a tenant-owned call / legacy fixture) leaves the decision exactly as before", JSON.stringify(decideSpendBackpressure(base)) === JSON.stringify(decideSpendBackpressure({ ...base, platformCapRemainingUsd: undefined })) && decideSpendBackpressure(base).action === "proceed")

  console.log("\nF — the pre-pull value verdict (lane 151C's interface) inside paidPullApproval")
  const plans = [{ id: "p1", brokerage_id: "b", status: "approved", valid_until: "2099-01-01T00:00:00Z", lines: [{ source: "batchdata_motivated", status: "approved", maxSpendUsd: 12, approvedAt: "2026-11-02T00:00:00Z" }] }]
  const wantPull = { brokerageId: "b", source: "batchdata_motivated" }
  check("omitted → unchanged (allowed under the approved line)", paidPullApproval(plans, wantPull).allowed === true)
  // Lane 151C's verdict shape (lib/lead-pipeline/pre-pull-value.ts), handed through the door context the planner reads.
  const verdict = (score: number, decision: "proceed" | "preview_first" | "hold" | "refuse", reasons: string[]) => ({ version: "test", score, decision, factors: {}, expectedUsableRecords: 0, totalCostUsd: null, costPerUsableUsd: null, affordableRecords: null, uncertainty: 0, reasons, disclaimer: "test", calibration: "unvalidated" }) as never
  check("a worthwhile verdict → allowed", paidPullApproval(plans, wantPull, new Date(), { value: verdict(0.7, "proceed", ["fresh", "territory match"]) }).allowed === true)
  const no = paidPullApproval(plans, wantPull, new Date(), { value: verdict(0.1, "refuse", ["stale signal", "duplicates known"]) })
  check("not worthwhile → REFUSED at the approval gate, with the planner's reasons", no.allowed === false && /not worthwhile/.test((no as { reason: string }).reason) && /stale signal/.test((no as { reason: string }).reason))
  const held = paidPullApproval(plans, wantPull, new Date(), { value: verdict(0.9, "hold", ["price unknown for this provider"]) })
  check("held pending configuration (unknown price / license) → refused as held", held.allowed === false && /held/.test((held as { reason: string }).reason))
  check("an out-of-bounds value is refused (a bounded 0..1 signal is the contract)", paidPullApproval(plans, wantPull, new Date(), { value: verdict(7, "proceed", []) }).allowed === false)
  const { prePullRefusal } = await import("../lib/vendor-governance/budget-eval")
  check("positive control: prePullRefusal(null) is null (nothing to refuse)", prePullRefusal(null) === null && prePullRefusal(undefined) === null)
  check("the planner consumes the ONE verdict reading (prePullRefusal, at the source door) rather than re-spelling it; the verdict type is lane 151C's", /prePullRefusal\(value\)/.test(stripped("lib/lead-pipeline/source-discovery-planner.ts")) && /import \{ prePullRefusal \} from "@\/lib\/vendor-governance\/budget-eval"/.test(stripped("lib/lead-pipeline/source-discovery-planner.ts")) && /type PrePullValueVerdict \} from "\.\/pre-pull-value"/.test(stripped("lib/lead-pipeline/source-discovery-planner.ts")) && !/holdReason|worthwhile:/.test(stripped("lib/vendor-governance/budget-eval.ts")))

  console.log(`\nSPEND BACKPRESSURE — RESULT: ${passed} passed, ${failed} failed ${failed === 0 ? "✅ SPEND_BACKPRESSURE_PASS" : "❌ SPEND_BACKPRESSURE_FAIL"}`)
  if (failed > 0) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
