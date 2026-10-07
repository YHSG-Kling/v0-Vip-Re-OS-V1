/**
 * scripts/autonomous-budgeting-guard.ts — test:autonomous-budgeting (wave 108, lane 108F).
 *
 * Proves CONTROLLED AUTONOMOUS BUDGETING + AUTONOMOUS EXPERIMENTATION against an in-memory client (no network,
 * no model):
 *   E   envelope caps — default all zero, malformed = zero (never unlimited), every envelope's cap derivation,
 *       value tiers; each with a positive control
 *   A   the ONE enforcement function — atomic consume under concurrency (the SQL's advisory lock modelled; the
 *       lock-free control over-consumes), per-scope caps, refusals ledgered FINANCIAL with the policy ref,
 *       fail-closed paths (zero, unreadable, RPC absent), release counted, tenant isolation
 *   F   Finance — the report + each anomaly (positive + negative controls) and the signals to finance_manager
 *   C   census — every autonomous spender routes through the envelope or its named ceiling (stripped source),
 *       the discovery finder with a positive control, a tombstone is not a call site
 *   X   experiments — propose → historical replay → policy/risk → class gate → deploy → cohort assignment →
 *       measure → statistical evaluation → adopt / reject; the owner's example; protected subjects refused
 *   W   wiring + migration shape + registration
 */
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join, relative } from "node:path"
import { memSupabase, type MemClient } from "./in-memory-supabase"
import { stripComments } from "./strip-comments"
import {
  resolveAutonomyBudgets, envelopeLimits, opportunityValueTier, consumeAutonomyEnvelope, releaseAutonomyEnvelope,
  composeAutonomyBudgetReport, deliverAutonomyBudgetReport, AUTONOMOUS_SPENDERS, AUTONOMY_ENVELOPES, ENVELOPE_SPECS,
  AUTONOMY_BUDGETS_POLICY_KEY,
} from "../lib/kernel/autonomy-budgets"
import {
  validateExperimentSpec, measureExperimentArms, experimentConclusion, pickVideoFirstSellerPair, proposeVideoFirstSellerExperiments,
  deployExperiment, routeEnrollmentThroughExperiments, concludeExperiments, proposeExperiment, EXPERIMENT_CLASSES, type ExperimentSpec,
} from "../lib/kernel/experiment-pipeline"
import { provenRebalance } from "../lib/ads/ad-outcome-loop"
import { planBudgetShift } from "../lib/ads/ad-manager"
import { strategySignificance } from "../lib/intelligence/strategy-learning"
import { TENANT_POLICY_SETTINGS_KEYS } from "../lib/kernel/tenant-policy"
import { PROPOSAL_SUBJECT_KINDS, PROPOSERS } from "../lib/kernel/improvement-proposals"
import { MAINTENANCE_DOMAINS, MANAGERS } from "../lib/kernel/manager-registry"
import { SIGNAL_REGISTRY } from "../lib/kernel/signal-registry"

const ROOT = process.cwd()
let pass = 0, fail = 0
function check(name: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  PASS ${name}`) } else { fail++; console.log(`  FAIL ${name}${detail ? ` — ${detail.slice(0, 600)}` : ""}`) }
}
const src = (rel: string) => stripComments(readFileSync(join(ROOT, rel), "utf8"))

const B = "11111111-1111-4111-8111-111111111111"
const OTHER = "99999999-9999-4999-8999-999999999999"
const NOW = new Date("2026-10-07T12:00:00.000Z")
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

/** The SQL function, modelled: with `lock` the read-sum-insert runs under a per (tenant, envelope) mutex — the
 *  pg_advisory_xact_lock m731 takes; without it (the CONTROL) concurrent calls interleave between read and insert. */
function attachRpc(mem: MemClient, opts: { lock: boolean; absent?: boolean } = { lock: true }) {
  const chains = new Map<string, Promise<unknown>>()
  let n = 0
  const body = async (a: Record<string, any>) => {
    const rows = mem.tables.autonomy_budget_consumptions
    const live = rows.filter((r) => r.brokerage_id === a.p_brokerage_id && r.envelope === a.p_envelope && r.period_key === a.p_period_key && r.status === "consumed")
    const period = live.reduce((s, r) => s + Number(r.amount), 0)
    await new Promise((res) => setTimeout(res, 1)) // the window a lock closes
    if (a.p_period_cap != null && period + a.p_amount > a.p_period_cap) return { ok: false, reason: "period cap", period_consumed: period }
    const scope = live.filter((r) => r.scope_key === a.p_scope_key).reduce((s, r) => s + Number(r.amount), 0)
    if (a.p_scope_cap != null && scope + a.p_amount > a.p_scope_cap) return { ok: false, reason: "scope cap", scope_consumed: scope }
    const id = uuid(900000 + ++n)
    rows.push({ id, brokerage_id: a.p_brokerage_id, envelope: a.p_envelope, period_key: a.p_period_key, scope_key: a.p_scope_key, amount: a.p_amount, unit: a.p_unit, period_cap: a.p_period_cap, scope_cap: a.p_scope_cap, manager: a.p_manager, policy_ref: a.p_policy_ref, reason: a.p_reason, status: "consumed", created_at: NOW.toISOString() })
    return { ok: true, id, period_consumed: period + a.p_amount, scope_consumed: scope + a.p_amount }
  }
  ;(mem as any).rpc = async (fn: string, a: Record<string, any>) => {
    if (opts.absent || fn !== "consume_autonomy_budget") return { data: null, error: { code: "PGRST202", message: "Could not find the function" } }
    if (!opts.lock) return { data: await body(a), error: null }
    const key = `${a.p_brokerage_id}:${a.p_envelope}`
    const prev = chains.get(key) ?? Promise.resolve()
    const next = prev.then(() => body(a))
    chains.set(key, next.catch(() => undefined))
    return { data: await next, error: null }
  }
  return mem
}

function seed(extra: Record<string, any[]> = {}, settings: Record<string, unknown> | null = null) {
  return memSupabase({
    brokerage_settings: settings ? [{ id: uuid(1), brokerage_id: B, settings, updated_at: null }] : [],
    autonomy_budget_consumptions: [], agent_action_ledger: [], tenant_policy_versions: [], lifecycle_events: [], improvement_proposals: [],
    manager_signals: [], ai_tool_usage: [], campaign_sequences: [], campaign_sequence_steps: [], sequence_enrollments: [], contacts: [],
    transactions: [], showings: [], communications: [], isa_outreach_log: [], leads: [], listings: [], ...extra,
  }, { stampCreatedAt: true })
}

const OPEN = { autonomy_budgets: { ads_manager: { max_shift_pct_of_monthly_budget: 10 }, provider_router: { per_decision_max_usd: { high: 2, top: 5 }, monthly_max_usd: 50 }, asset_manager: { max_renders_per_campaign: 8 }, recruiting_manager: { max_prospect_data_usd_per_month: 100 }, experiments: { max_usd_per_month: 200 }, listing_concierge: { max_auto_book_usd_per_month: 500 } } }

async function main() {
  console.log("\nautonomous-budgeting-guard — wave 108F\n")

  // ── E: envelope caps ─────────────────────────────────────────────────────────────────────────
  console.log("E — envelopes")
  {
    const d = resolveAutonomyBudgets({})
    check("E1 the policy key is registered as versioned tenant policy and DEFAULTS ALL ZERO (recommendation only)", !!TENANT_POLICY_SETTINGS_KEYS[AUTONOMY_BUDGETS_POLICY_KEY] && AUTONOMY_ENVELOPES.every((e) => !envelopeLimits(d, e, { basisUsd: 10_000, valueTier: "top" }).open))
    const junk = resolveAutonomyBudgets({ autonomy_budgets: { ads_manager: { max_shift_pct_of_monthly_budget: 250 }, provider_router: { per_decision_max_usd: { top: "unlimited" }, monthly_max_usd: -5 }, asset_manager: { max_renders_per_campaign: Infinity }, recruiting_manager: { max_prospect_data_usd_per_month: "1e999" } } })
    check("E2 malformed values are ZERO, never unlimited (pct clamped to 100, -5 / 'unlimited' / Infinity → 0) — no unlimited spend", junk.ads_manager.max_shift_pct_of_monthly_budget === 100 && junk.provider_router.per_decision_max_usd.top === 0 && junk.provider_router.monthly_max_usd === 0 && junk.asset_manager.max_renders_per_campaign === 0 && junk.recruiting_manager.max_prospect_data_usd_per_month === 0, JSON.stringify(junk))
    const p = resolveAutonomyBudgets(OPEN)
    const ads = envelopeLimits(p, "ads_budget_shift", { basisUsd: 6000 })
    check("E3 ads: 10% of a $6,000 live monthly budget = a $600 period cap; no live budget = closed (positive control)", ads.open && ads.periodCap === 600 && !envelopeLimits(p, "ads_budget_shift", { basisUsd: 0 }).open, JSON.stringify(ads))
    check("E4 provider router: a standard opportunity is closed, high = $2/decision + $50/month, top = $5", !envelopeLimits(p, "provider_high_value", { valueTier: "standard" }).open && envelopeLimits(p, "provider_high_value", { valueTier: "high" }).scopeCap === 2 && envelopeLimits(p, "provider_high_value", { valueTier: "top" }).scopeCap === 5 && envelopeLimits(p, "provider_high_value", { valueTier: "top" }).periodCap === 50)
    check("E5 renders per campaign (scope), recruiting / experiments / procurement monthly (period)", envelopeLimits(p, "asset_renders").scopeCap === 8 && envelopeLimits(p, "recruiting_prospect_data").periodCap === 100 && envelopeLimits(p, "experiment_budget").periodCap === 200 && envelopeLimits(p, "procurement_auto_book").periodCap === 500)
    check("E6 value tiers: score 90 = top, 72 = high, 40 = standard, none = standard (never promoted on silence); value 2× reference = top", opportunityValueTier({ leadScore: 90 }).tier === "top" && opportunityValueTier({ leadScore: 72 }).tier === "high" && opportunityValueTier({ leadScore: 40 }).tier === "standard" && opportunityValueTier({}).tier === "standard" && opportunityValueTier({ estimatedValue: 900_000, referenceValue: 400_000 }).tier === "top")
    check("E7 every envelope names a REAL manager and a unit", AUTONOMY_ENVELOPES.every((e) => ENVELOPE_SPECS[e].manager in MANAGERS && ["usd", "renders"].includes(ENVELOPE_SPECS[e].unit)))
  }

  // ── A: the ONE enforcement function ──────────────────────────────────────────────────────────
  console.log("A — consumeAutonomyEnvelope")
  {
    const mem = attachRpc(seed({}, OPEN))
    const go = (amount: number, extra: Partial<Parameters<typeof consumeAutonomyEnvelope>[1]> = {}) => consumeAutonomyEnvelope(mem, { brokerageId: B, envelope: "recruiting_prospect_data", amount, reasonCode: "MISSION_LIFECYCLE", reasonDetail: "prospect data", subject: { type: "mission", id: uuid(7) }, now: NOW, ...extra })
    const ten = await Promise.all(Array.from({ length: 10 }, () => go(30)))
    const allowed = ten.filter((v) => v.allowed).length
    const consumed = mem.tables.autonomy_budget_consumptions.reduce((s, r) => s + Number(r.amount), 0)
    check("A1 ATOMIC: 10 concurrent $30 draws on a $100 envelope → exactly 3 allowed, $90 consumed, 7 refused", allowed === 3 && consumed === 90, JSON.stringify({ allowed, consumed }))
    const ctl = attachRpc(seed({}, OPEN), { lock: false })
    const ctlRuns = await Promise.all(Array.from({ length: 10 }, () => consumeAutonomyEnvelope(ctl, { brokerageId: B, envelope: "recruiting_prospect_data", amount: 30, reasonCode: "MISSION_LIFECYCLE", reasonDetail: "x", subject: { type: "mission", id: uuid(7) }, now: NOW })))
    const ctlSum = ctl.tables.autonomy_budget_consumptions.reduce((s, r) => s + Number(r.amount), 0)
    check("A2 POSITIVE CONTROL: the same draws WITHOUT the lock over-consume (the lock is what keeps it atomic)", ctlRuns.filter((v) => v.allowed).length > 3 && ctlSum > 100, JSON.stringify({ ctlSum }))
    const led = mem.tables.agent_action_ledger.filter((r) => r.action === "autonomy.envelope.recruiting_prospect_data")
    check("A3 every call leaves ONE FINANCIAL ledger row with the policy ref — allowed executed, refused skipped/envelope_refused", led.length === 10 && led.every((r) => r.risk_class === "FINANCIAL" && String(r.policy_ref ?? "").startsWith(`${AUTONOMY_BUDGETS_POLICY_KEY}@`)) && led.filter((r) => r.status === "executed").length === 3 && led.filter((r) => r.status === "skipped" && r.outcome === "envelope_refused").length === 7, JSON.stringify(led.slice(0, 2)))
    check("A4 the amount rides detail.envelope, NOT cost_usd (the spend's own row books what it cost)", led.every((r) => r.cost_usd == null && r.detail?.envelope?.amount === 30))
    const id = (ten.find((v) => v.allowed) as any).consumptionId as string
    const rel = await releaseAutonomyEnvelope(mem, { brokerageId: B, consumptionId: id, reason: "spend did not happen" })
    const again = await releaseAutonomyEnvelope(mem, { brokerageId: B, consumptionId: id, reason: "twice" })
    const foreign = await releaseAutonomyEnvelope(mem, { brokerageId: OTHER, consumptionId: ten.filter((v) => v.allowed).map((v: any) => v.consumptionId)[1], reason: "x" })
    const after = await go(30)
    check("A5 release is COUNTED: once ok, twice refused, another tenant's release matches nothing; the freed $30 is drawable again", rel.ok && !again.ok && !foreign.ok && after.allowed, JSON.stringify({ rel, again, foreign }))
    const zero = attachRpc(seed({}, null))
    const z = await consumeAutonomyEnvelope(zero, { brokerageId: B, envelope: "asset_renders", amount: 4, scopeKey: uuid(50), reasonCode: "CAMPAIGN_STEP", reasonDetail: "renders", subject: { type: "marketing_campaign", id: uuid(50) }, now: NOW })
    check("A6 DEFAULT (no policy) → refused 'recommendation only', nothing consumed, the refusal still ledgered", !z.allowed && /recommendation only/.test(z.reason) && zero.tables.autonomy_budget_consumptions.length === 0 && zero.tables.agent_action_ledger.filter((r) => r.status === "skipped").length === 1, JSON.stringify(z))
    const unread = attachRpc(memSupabase({ brokerage_settings: [], agent_action_ledger: [], tenant_policy_versions: [], autonomy_budget_consumptions: [], lifecycle_events: [] }, { refuse: { brokerage_settings: "permission denied" } }))
    const u = await consumeAutonomyEnvelope(unread, { brokerageId: B, envelope: "experiment_budget", amount: 10, reasonCode: "LEARNED_IMPROVEMENT", reasonDetail: "x", subject: { type: "improvement_proposal", id: uuid(3) }, now: NOW })
    check("A7 FAIL CLOSED: an unreadable policy refuses", !u.allowed && /unreadable/.test(u.reason), JSON.stringify(u))
    const absent = attachRpc(seed({}, OPEN), { lock: true, absent: true })
    const ab = await consumeAutonomyEnvelope(absent, { brokerageId: B, envelope: "experiment_budget", amount: 10, reasonCode: "LEARNED_IMPROVEMENT", reasonDetail: "x", subject: { type: "improvement_proposal", id: uuid(3) }, now: NOW })
    check("A8 before m731 the RPC is absent → refused, degraded and SAID (recommendation only)", !ab.allowed && (ab as any).degraded === true && /m731 not applied/.test(ab.reason))
    const scope = attachRpc(seed({}, OPEN))
    const r = (camp: number, n: number) => consumeAutonomyEnvelope(scope, { brokerageId: B, envelope: "asset_renders", amount: n, scopeKey: uuid(camp), reasonCode: "CAMPAIGN_STEP", reasonDetail: "renders", subject: { type: "marketing_campaign", id: uuid(camp) }, now: NOW })
    const r1 = await r(60, 4), r2 = await r(60, 4), r3 = await r(60, 4), r4 = await r(61, 4)
    check("A9 PER-CAMPAIGN: 8 renders per campaign — 4 + 4 allowed, the third 4 refused; another campaign has its own 8", r1.allowed && r2.allowed && !r3.allowed && r4.allowed, JSON.stringify(r3))
    const noScope = await consumeAutonomyEnvelope(scope, { brokerageId: B, envelope: "asset_renders", amount: 1, reasonCode: "CAMPAIGN_STEP", reasonDetail: "x", subject: { type: "media_need" }, now: NOW })
    check("A10 a per-scope envelope without a scope key is refused (never an unscoped draw)", !noScope.allowed && /scope key is required/.test(noScope.reason))
    const pv = attachRpc(seed({}, OPEN))
    const std = await consumeAutonomyEnvelope(pv, { brokerageId: B, envelope: "provider_high_value", amount: 1, scopeKey: "contact_first_touch:x", valueTier: "standard", reasonCode: "NURTURE_TOUCH", reasonDetail: "x", subject: { type: "contact", id: uuid(9) }, now: NOW })
    const hi = await consumeAutonomyEnvelope(pv, { brokerageId: B, envelope: "provider_high_value", amount: 1.5, scopeKey: "contact_first_touch:x", valueTier: "high", reasonCode: "NURTURE_TOUCH", reasonDetail: "x", subject: { type: "contact", id: uuid(9) }, now: NOW })
    const hi2 = await consumeAutonomyEnvelope(pv, { brokerageId: B, envelope: "provider_high_value", amount: 1, scopeKey: "contact_first_touch:x", valueTier: "high", reasonCode: "NURTURE_TOUCH", reasonDetail: "x", subject: { type: "contact", id: uuid(9) }, now: NOW })
    check("A11 provider router: standard refused; high $1.50 allowed; a further $1 on the SAME decision exceeds its $2 per-decision max", !std.allowed && hi.allowed && !hi2.allowed)
    const iso = attachRpc(seed({}, OPEN))
    iso.tables.autonomy_budget_consumptions.push({ id: uuid(800), brokerage_id: OTHER, envelope: "recruiting_prospect_data", period_key: "2026-10", scope_key: "all", amount: 100, unit: "usd", period_cap: 100, status: "consumed", created_at: NOW.toISOString() })
    const isoV = await consumeAutonomyEnvelope(iso, { brokerageId: B, envelope: "recruiting_prospect_data", amount: 100, reasonCode: "MISSION_LIFECYCLE", reasonDetail: "x", subject: { type: "mission", id: uuid(7) }, now: NOW })
    check("A12 TENANT ISOLATION: another brokerage's exhausted envelope never counts against this one", isoV.allowed)
    const nextMonth = await consumeAutonomyEnvelope(mem, { brokerageId: B, envelope: "recruiting_prospect_data", amount: 100, reasonCode: "MISSION_LIFECYCLE", reasonDetail: "x", subject: { type: "mission", id: uuid(7) }, now: new Date("2026-11-02T00:00:00Z") })
    check("A13 the monthly envelope resets with the period (November draws a fresh $100)", nextMonth.allowed)
  }

  // ── F: Finance watches all ───────────────────────────────────────────────────────────────────
  console.log("F — finance report + anomaly signal")
  {
    const p = resolveAutonomyBudgets(OPEN)
    const day = NOW.toISOString()
    const quiet = composeAutonomyBudgetReport({ policy: p, consumptions: [{ envelope: "recruiting_prospect_data", amount: 20, period_key: "2026-10", scope_key: "all", period_cap: 100, scope_cap: null, status: "consumed", created_at: "2026-10-02T00:00:00Z" }], refusals: [], aiUsage: [{ cost_cents: 300, created_at: "2026-10-06T10:00:00Z" }, { cost_cents: 300, created_at: day }], now: NOW })
    check("F1 NEGATIVE CONTROL: 20 % used, no burst, no refusals, flat AI → no anomaly", quiet.anomalies.length === 0 && quiet.lines.find((l) => l.envelope === "recruiting_prospect_data")?.consumedPeriod === 20, JSON.stringify(quiet.anomalies))
    const hot = composeAutonomyBudgetReport({ policy: p, consumptions: [{ envelope: "recruiting_prospect_data", amount: 85, period_key: "2026-10", scope_key: "all", period_cap: 100, scope_cap: null, status: "consumed", created_at: day }], refusals: Array.from({ length: 3 }, () => ({ action: "autonomy.envelope.experiment_budget", created_at: day })), aiUsage: [{ cost_cents: 70, created_at: "2026-10-03T10:00:00Z" }, { cost_cents: 2000, created_at: day }], now: NOW })
    const has = (re: RegExp) => hot.anomalies.some((a) => re.test(a))
    check("F2 anomalies fire: ≥ 80 % used, one-day burst, refusal pressure, AI spike", has(/85% of the 2026-10 envelope/) && has(/burst/) && has(/3 refusals today/) && has(/AI spend \$20\.00/), JSON.stringify(hot.anomalies))
    const over = composeAutonomyBudgetReport({ policy: resolveAutonomyBudgets({}), consumptions: [{ envelope: "experiment_budget", amount: 300, period_key: "2026-10", scope_key: "all", period_cap: 200, scope_cap: null, status: "consumed", created_at: day }], refusals: [], aiUsage: [], now: NOW })
    check("F3 OVER CAP and consumption under a now-CLOSED envelope are both escalated", over.anomalies.some((a) => /OVER CAP/.test(a)) && over.anomalies.some((a) => /now closed/.test(a)), JSON.stringify(over.anomalies))
    const mem = seed({ autonomy_budget_consumptions: [{ id: uuid(70), brokerage_id: B, envelope: "recruiting_prospect_data", period_key: "2026-10", scope_key: "all", amount: 90, unit: "usd", period_cap: 100, status: "consumed", created_at: day }] }, OPEN)
    const sent: any[] = []
    const d = await deliverAutonomyBudgetReport(mem, B, NOW, { publish: async (i: any) => { sent.push(i); return { ok: true, signalId: uuid(sent.length) } } })
    check("F4 the daily report goes to finance_manager, and the anomaly escalates to finance_manager (catalogued signals)", d.reported && d.escalated && sent.map((s) => `${s.toManager}:${s.signalType}`).join() === "finance_manager:autonomy_budget_report,finance_manager:autonomy_budget_escalated" && !!SIGNAL_REGISTRY.autonomy_budget_report && SIGNAL_REGISTRY.autonomy_budget_escalated?.kind === "escalation", JSON.stringify(sent.map((s) => s.message)))
    const silent: any[] = []
    const q = await deliverAutonomyBudgetReport(seed({}, null), B, NOW, { publish: async (i: any) => { silent.push(i); return { ok: true } } })
    check("F5 a tenant with no open envelope, no activity and no anomaly gets NO signal (no feed noise)", !q.reported && silent.length === 0)
  }

  // ── C: census ────────────────────────────────────────────────────────────────────────────────
  console.log("C — every autonomous spender routes through the envelope (census)")
  {
    for (const s of AUTONOMOUS_SPENDERS) {
      if (!s.file) { check(`C· ${s.spender}: no spender exists yet — envelope ready (${s.envelope})`, s.gate === "envelope" && !!s.envelope && /must call consumeAutonomyEnvelope/.test(s.note)); continue }
      const code = src(s.file)
      if (s.gate === "envelope") check(`C· ${s.spender} → consumeAutonomyEnvelope("${s.envelope}") in ${s.file}`, code.includes("consumeAutonomyEnvelope(") && code.includes(`"${s.envelope}"`))
      else check(`C· ${s.spender} → ceiling ${s.ceiling}`, (s.requires ?? []).length > 0 && (s.requires ?? []).every((t) => code.includes(t)))
    }
    // Discovery: any file calling a spend DECIDER must be in the census (or be the decider's own module).
    const DECIDERS = ["procurementAutonomyDecision(", "shouldPurchaseEnrichment(", "produceVariants(", "executeAutonomousBudgetShift(", "shouldUseExpensiveReasoning(", "consumeAutonomyEnvelope("]
    const OWNERS = new Set(["lib/kernel/autonomy-budgets.ts", "lib/kernel/resource-allocation.ts", "lib/ads/ad-manager.ts"])
    const censusFiles = new Set(AUTONOMOUS_SPENDERS.map((s) => s.file).filter(Boolean) as string[])
    const finder = (rel: string, code: string) => DECIDERS.some((t) => code.includes(t)) && !OWNERS.has(rel) && !censusFiles.has(rel)
    const files: string[] = []
    const walk = (d: string) => { for (const f of readdirSync(d)) { const p = join(d, f); if (f === "node_modules" || f.startsWith(".")) continue; const st = statSync(p); if (st.isDirectory()) walk(p); else if (/\.(ts|tsx)$/.test(f)) files.push(p) } }
    walk(join(ROOT, "lib")); walk(join(ROOT, "app"))
    const uncensused = files.map((p) => relative(ROOT, p)).filter((rel) => finder(rel, stripComments(readFileSync(join(ROOT, rel), "utf8"))))
    check(`C1 no autonomous spend decider is called outside the census (${files.length} lib/app files scanned)`, uncensused.length === 0, uncensused.join(", "))
    check("C2 POSITIVE CONTROL: the finder flags an uncensused caller of a spend decider", finder("lib/x/rogue.ts", "await produceVariants(svc, need)"))
    check("C3 A TOMBSTONE IS NOT A CALL SITE: a comment naming consumeAutonomyEnvelope( is stripped before the scan", !stripComments("// see consumeAutonomyEnvelope(svc) — survivor\nconst x = 1").includes("consumeAutonomyEnvelope("))
  }

  // ── X: experiments ───────────────────────────────────────────────────────────────────────────
  console.log("X — experiment lifecycle")
  {
    const CONTROL = uuid(1001), TREAT = uuid(1002)
    const day = (d: number) => new Date(NOW.getTime() + d * 86_400_000).toISOString()
    const sellers = Array.from({ length: 240 }, (_, i) => uuid(5000 + i))
    const xseed = (settings: Record<string, unknown>, historyN = 200) => seed({
      campaign_sequences: [
        { id: CONTROL, brokerage_id: B, is_active: true, compliance_gated: true, contact_type: "seller", enrollments_total: 400 },
        { id: TREAT, brokerage_id: B, is_active: true, compliance_gated: true, contact_type: "seller", enrollments_total: 50 },
      ],
      campaign_sequence_steps: [{ sequence_id: CONTROL, step_number: 1, channel: "email", is_active: true }, { sequence_id: TREAT, step_number: 1, channel: "video", is_active: true }],
      sequence_enrollments: Array.from({ length: historyN }, (_, i) => ({ id: uuid(20000 + i), brokerage_id: B, sequence_id: CONTROL, contact_id: uuid(30000 + i), enrolled_at: day(-1 - (i % 120)) })),
      contacts: [...Array.from({ length: historyN }, (_, i) => ({ id: uuid(30000 + i), brokerage_id: B, contact_type: "seller" })), ...sellers.map((id) => ({ id, brokerage_id: B, contact_type: "seller" })), { id: uuid(7777), brokerage_id: B, contact_type: "buyer" }],
    }, settings)

    check("X0 the spec gate refuses a protected subject, a bad metric and a short window (each named)", !validateExperimentSpec({ key: "abc", hypothesis: "raise appointments a lot", metric: "appointment", experimentClass: "sequence_choice", manager: "campaign_orchestrator", cohort: { surface: "sequence_enrollment", control_sequence_id: CONTROL, treatment_sequence_id: TREAT }, durationDays: 30, budgetUsd: 0, touches: ["commission"] }).ok && validateExperimentSpec({ key: "abc", metric: "clicks" as any, durationDays: 3 } as any).errors.length >= 3)
    check("X0b the owner's example pair: busiest standard seller sequence (control) vs busiest video-first one (treatment)", JSON.stringify(pickVideoFirstSellerPair([{ id: "a", contact_type: "seller", enrollments_total: 9, firstChannel: "email" }, { id: "b", contact_type: "seller", enrollments_total: 3, firstChannel: "video" }, { id: "c", contact_type: "buyer", enrollments_total: 99, firstChannel: "video" }])) === JSON.stringify({ control: "a", treatment: "b" }))

    // 1. Default policy: the Campaign Manager proposes; it EVALUATES but waits for a human (no class is autonomous).
    const human = xseed({})
    const p1 = await proposeVideoFirstSellerExperiments(human, B, { now: NOW }) as any
    const row1 = human.tables.improvement_proposals[0]
    check("X1 propose → historical replay → policy/risk → EVALUATED (pass) with the replay evidence (cohort volume, baseline)", p1.proposalId && row1?.subject_kind === "experiment" && row1?.proposer === "experimentation" && row1?.status === "EVALUATED" && row1?.evaluation?.verdict === "pass" && row1?.evaluation?.detail?.pipeline?.replay?.historicalCohort === 200, JSON.stringify(row1?.evaluation))
    check("X2 CLASS GATING (default none): not deployed — held for a human on the Manager Trust page", p1.deployed === false && /not in experiments\.autonomous_classes/.test(p1.held ?? ""), JSON.stringify(p1))
    const dup = await proposeVideoFirstSellerExperiments(human, B, { now: NOW }) as any
    check("X3 idempotent: a second run proposes nothing new", human.tables.improvement_proposals.length === 1 && (dup.skipped || dup.existing), JSON.stringify(dup))

    // 2. Underpowered history → the replay REJECTS it (could never decide).
    const thin = xseed({}, 10)
    await proposeVideoFirstSellerExperiments(thin, B, { now: NOW })
    check("X4 HISTORICAL REPLAY refuses an underpowered experiment (REJECTED, reason says why)", thin.tables.improvement_proposals[0]?.status === "REJECTED" && /underpowered/.test(thin.tables.improvement_proposals[0]?.decision_reason ?? ""), JSON.stringify(thin.tables.improvement_proposals[0]?.decision_reason))

    // 3. The tenant makes sequence_choice autonomous → deploys at once.
    const auto = xseed({ experiments: { autonomous_classes: ["sequence_choice"] } })
    const p3 = await proposeVideoFirstSellerExperiments(auto, B, { now: NOW }) as any
    const row3 = auto.tables.improvement_proposals[0]
    check("X5 an AUTONOMOUS class deploys: APPROVED (= running) by the governed manager, never by a model", p3.deployed === true && row3.status === "APPROVED" && /autonomous deploy/.test(row3.decision_reason ?? ""), JSON.stringify(p3))
    row3.decided_at = NOW.toISOString()

    // 4. Cohort assignment at the enrollment chokepoint.
    const routes = await Promise.all(sellers.slice(0, 200).map((c) => routeEnrollmentThroughExperiments(auto, { brokerageId: B, sequenceId: CONTROL, contactId: c, now: new Date(NOW.getTime() + 3_600_000) })))
    const t = routes.filter((r) => r.assignment?.arm === "treatment"), c = routes.filter((r) => r.assignment?.arm === "control")
    const assignRows = auto.tables.agent_action_ledger.filter((r) => r.action === "experiment.cohort.assign")
    check("X6 COHORT: seller contacts split deterministically; treatment enrolls into the video-first sequence; every assignment ledgered with detail.experiment", t.length > 60 && c.length > 60 && t.every((r) => r.sequenceId === TREAT) && c.every((r) => r.sequenceId === CONTROL) && assignRows.length === 200 && assignRows.every((r) => r.detail?.experiment?.key === `exp_${row3.subject_key.replace("experiment:", "")}`), JSON.stringify({ t: t.length, c: c.length, rows: assignRows.length }))
    const again = await routeEnrollmentThroughExperiments(auto, { brokerageId: B, sequenceId: CONTROL, contactId: sellers[0], now: new Date(NOW.getTime() + 7_200_000) })
    check("X7 deterministic: the same person always lands in the same arm (replayable)", again.assignment?.arm === routes[0].assignment?.arm)
    const buyer = await routeEnrollmentThroughExperiments(auto, { brokerageId: B, sequenceId: CONTROL, contactId: uuid(7777), now: NOW })
    check("X8 out-of-cohort (a buyer) is never assigned — the asked-for sequence stands", buyer.assignment === null && buyer.sequenceId === CONTROL)

    // 5. Measure: treatment converts far better (listing appointments); interim reads never conclude.
    auto.tables.agent_action_ledger.forEach((r) => { if (r.action === "experiment.cohort.assign") r.created_at = day(0.05) })
    t.forEach((r, i) => { if (i % 2 === 0) auto.tables.listings.push({ id: uuid(60000 + i), brokerage_id: B, seller_contact_id: sellers[routes.indexOf(r)], contact_id: null, appointment_at: day(5) }) })
    c.forEach((r, i) => { if (i % 10 === 0) auto.tables.listings.push({ id: uuid(70000 + i), brokerage_id: B, seller_contact_id: sellers[routes.indexOf(r)], contact_id: null, appointment_at: day(5) }) })
    const interim = await concludeExperiments(auto, B, { now: new Date(day(10)) })
    check("X9 INTERIM: measured, recorded, NOT concluded (no peeking) — still running", interim.measured === 1 && interim.adopted === 0 && interim.rejected === 0 && auto.tables.improvement_proposals[0].status === "APPROVED" && auto.tables.improvement_proposals[0].evaluation?.detail?.result?.conclusion === "running", JSON.stringify(interim))
    const done = await concludeExperiments(auto, B, { now: new Date(day(46)) })
    const r5 = auto.tables.improvement_proposals[0]
    const adopted = (auto.tables.brokerage_settings[0]?.settings as any)?.experiments?.adopted?.[r5.subject_key]
    check("X10 STATISTICAL EVALUATION at the end: treatment wins at 95 % → PROMOTED; the winner ADOPTED through the versioned experiments policy", done.adopted === 1 && r5.status === "PROMOTED" && r5.evaluation?.detail?.result?.significance?.verdict === "a_better" && adopted?.treatment_sequence_id === TREAT && auto.tables.tenant_policy_versions.some((v) => v.policy_key === "experiments"), JSON.stringify({ done, ev: r5.evaluation?.why }))
    const post = await routeEnrollmentThroughExperiments(auto, { brokerageId: B, sequenceId: CONTROL, contactId: sellers[230], now: new Date(day(50)) })
    check("X11 ADOPTION serves the cohort: a new seller now enrolls into the video-first sequence", post.adopted && post.sequenceId === TREAT)

    // 6. Control wins → REJECTED; a winning NON-autonomous class waits for a human.
    const lose = xseed({ experiments: { autonomous_classes: ["sequence_choice"] } })
    await proposeVideoFirstSellerExperiments(lose, B, { now: NOW })
    lose.tables.improvement_proposals[0].decided_at = NOW.toISOString()
    const lr = await Promise.all(sellers.slice(0, 200).map((cc) => routeEnrollmentThroughExperiments(lose, { brokerageId: B, sequenceId: CONTROL, contactId: cc, now: new Date(NOW.getTime() + 3_600_000) })))
    lose.tables.agent_action_ledger.forEach((r) => { if (r.action === "experiment.cohort.assign") r.created_at = day(0.05) })
    lr.forEach((r, i) => { if (r.assignment?.arm === "control" && i % 2 === 0) lose.tables.listings.push({ id: uuid(80000 + i), brokerage_id: B, seller_contact_id: sellers[i], contact_id: null, appointment_at: day(5) }) })
    lr.forEach((r, i) => { if (r.assignment?.arm === "treatment" && i % 15 === 0) lose.tables.listings.push({ id: uuid(81000 + i), brokerage_id: B, seller_contact_id: sellers[i], contact_id: null, appointment_at: day(5) }) })
    const lo = await concludeExperiments(lose, B, { now: new Date(day(46)) })
    check("X12 control held → REJECTED with the measured reason (nothing adopted)", lo.rejected === 1 && lose.tables.improvement_proposals[0].status === "REJECTED" && /reject_control_held/.test(lose.tables.improvement_proposals[0].decision_reason ?? "") && !(lose.tables.brokerage_settings[0]?.settings as any)?.experiments?.adopted, JSON.stringify(lo))
    // a human deploys a non-autonomous experiment; at the end the win waits for a human promotion
    const manual = xseed({})
    await proposeVideoFirstSellerExperiments(manual, B, { now: NOW })
    const ip = await import("../lib/kernel/improvement-proposals")
    const dm = await ip.decideProposal(manual, { brokerageId: B, id: manual.tables.improvement_proposals[0].id, decision: "approve", actor: { type: "user", userId: uuid(4), isTenantAdmin: true } })
    manual.tables.improvement_proposals[0].decided_at = NOW.toISOString()
    const mr = await Promise.all(sellers.slice(0, 200).map((cc) => routeEnrollmentThroughExperiments(manual, { brokerageId: B, sequenceId: CONTROL, contactId: cc, now: new Date(NOW.getTime() + 3_600_000) })))
    manual.tables.agent_action_ledger.forEach((r) => { if (r.action === "experiment.cohort.assign") r.created_at = day(0.05) })
    mr.forEach((r, i) => { if (r.assignment?.arm === "treatment" && i % 2 === 0) manual.tables.listings.push({ id: uuid(90000 + i), brokerage_id: B, seller_contact_id: sellers[i], contact_id: null, appointment_at: day(5) }) })
    const mc = await concludeExperiments(manual, B, { now: new Date(day(46)) })
    check("X13 a HUMAN deploys a non-autonomous class; its measured win waits for a human promotion (APPROVED, awaiting)", dm.ok && mc.awaitingHuman === 1 && manual.tables.improvement_proposals[0].status === "APPROVED" && manual.tables.improvement_proposals[0].evaluation?.detail?.result?.winner === "treatment", JSON.stringify(mc))

    // 7. Budget: an autonomous class with a budget beyond the experiment envelope does NOT deploy.
    const budget = xseed({ experiments: { autonomous_classes: ["sequence_choice"] }, autonomy_budgets: { experiments: { max_usd_per_month: 100 } } })
    attachRpc(budget)
    const spec: ExperimentSpec = { key: "budgeted_one", hypothesis: "A paid video variant raises appointments", metric: "appointment", experimentClass: "sequence_choice", manager: "campaign_orchestrator", cohort: { surface: "sequence_enrollment", control_sequence_id: CONTROL, treatment_sequence_id: TREAT, contact_types: ["seller"] }, durationDays: 45, budgetUsd: 150 }
    const bo = await proposeExperiment(budget, { brokerageId: B, spec, now: NOW })
    check("X14 BUDGET: $150 over the $100 experiment envelope → not deployed (held), nothing consumed", !bo.deployed && /envelope refused/.test(bo.held ?? "") && budget.tables.autonomy_budget_consumptions.length === 0, JSON.stringify(bo))
    const bo2 = await proposeExperiment(budget, { brokerageId: B, spec: { ...spec, key: "budgeted_two", budgetUsd: 80 }, now: NOW })
    check("X15 POSITIVE CONTROL: $80 inside the envelope deploys and consumes $80 atomically", bo2.deployed && budget.tables.autonomy_budget_consumptions.length === 1 && Number(budget.tables.autonomy_budget_consumptions[0].amount) === 80, JSON.stringify(bo2))
    const killed = xseed({ experiments: { kill_switch: true, autonomous_classes: ["sequence_choice"] } })
    await proposeVideoFirstSellerExperiments(killed, B, { now: NOW })
    check("X16 the tenant kill switch refuses the experiment at the policy/risk step", killed.tables.improvement_proposals[0]?.status === "REJECTED" && /kill switch/.test(killed.tables.improvement_proposals[0]?.decision_reason ?? ""))
    const notDeployable = await deployExperiment(killed, { brokerageId: B, id: killed.tables.improvement_proposals[0].id })
    check("X17 a rejected experiment never deploys", !notDeployable.deployed)

    // pure statistics controls
    const m = measureExperimentArms({ assignments: [{ subjectId: "a", arm: "treatment", at: "2026-10-01T00:00:00Z" }, { subjectId: "a", arm: "control", at: "2026-10-02T00:00:00Z" }, { subjectId: "b", arm: "control", at: "2026-10-01T00:00:00Z" }], outcomes: [{ kind: "appointment", subjectIds: ["a"], at: "2026-10-03T00:00:00Z" }, { kind: "appointment", subjectIds: ["b"], at: "2026-09-30T00:00:00Z" }, { kind: "reply", subjectIds: ["b"], at: "2026-10-03T00:00:00Z" }], metric: "appointment", windowEndIso: "2026-11-01T00:00:00Z" })
    check("X18 intention-to-treat: first assignment wins, a pre-assignment outcome and another metric never count", m.treatment.exposures === 1 && m.treatment.conversions === 1 && m.control.exposures === 1 && m.control.conversions === 0)
    check("X19 conclusions: running before the end; a_better adopt; b_better control held; no_difference no lift; insufficient", experimentConclusion({ verdict: "a_better" }, false) === "running" && experimentConclusion({ verdict: "a_better" }, true) === "adopt_treatment" && experimentConclusion({ verdict: "b_better" }, true) === "reject_control_held" && experimentConclusion({ verdict: "no_difference" }, true) === "reject_no_lift" && experimentConclusion({ verdict: "insufficient_sample" }, true) === "reject_insufficient")
  }

  // ── R: WAVE 137 — the roi-ledger appointment kind includes LISTING appointments (one vocabulary) ──
  console.log("R — roi-ledger appointment kind includes listing appointments")
  {
    const { loadLedgerAttribution } = await import("../lib/intelligence/roi-ledger")
    const day = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString()
    const c1 = uuid(501), c2 = uuid(502), c3 = uuid(503), cx = uuid(504)
    const mem = seed({
      showings: [{ id: uuid(601), brokerage_id: B, contact_id: c1, created_at: day(4), status: "scheduled" }],
      listing_presentations: [
        { id: uuid(611), brokerage_id: B, contact_id: c2, appointment_at: day(3), status: "scheduled" },
        { id: uuid(612), brokerage_id: B, contact_id: c3, appointment_at: day(2), status: "cancelled" },
        { id: uuid(613), brokerage_id: OTHER, contact_id: cx, appointment_at: day(2), status: "scheduled" },
      ],
      listings: [
        { id: uuid(621), brokerage_id: B, seller_contact_id: c2, contact_id: null, appointment_at: day(3) },
        { id: uuid(622), brokerage_id: B, seller_contact_id: c3, contact_id: null, appointment_at: day(1) },
      ],
    })
    const r = await loadLedgerAttribution(mem as any, B, { sinceIso: day(30) })
    const appts = r.ok ? r.result.outcomes.filter((o) => o.kind === "appointment") : []
    const refs = appts.map((o) => o.ref).sort()
    check("R1 a seller LISTING appointment (listing_presentations.appointment_at) is an `appointment` outcome beside the buyer showing", r.ok && refs.includes(`appointment:listing:${uuid(611)}`) && refs.includes(`appointment:${uuid(601)}`), JSON.stringify(refs))
    check("R2 the booking on the listing row (listings.appointment_at) is the same kind; the presentation + booking of one contact on one day count ONCE; a cancelled presentation never counts", refs.includes(`appointment:listing-row:${uuid(622)}`) && !refs.includes(`appointment:listing-row:${uuid(621)}`) && !refs.includes(`appointment:listing:${uuid(612)}`) && appts.length === 3, JSON.stringify(refs))
    check("R3 tenant isolation: another tenant's presentation never becomes this tenant's outcome", !appts.some((o) => o.subjectIds.includes(cx)))
    const none = await loadLedgerAttribution(seed({ showings: [{ id: uuid(601), brokerage_id: B, contact_id: c1, created_at: day(4), status: "scheduled" }] }) as any, B, { sinceIso: day(30) })
    check("R4 POSITIVE CONTROL: without listing rows only the showing counts (the finder is not counting everything)", none.ok && none.result.outcomes.filter((o) => o.kind === "appointment").length === 1)
    const pipe = stripComments(readFileSync("lib/kernel/experiment-pipeline.ts", "utf8"))
    check("R5 ONE reader: experiment-pipeline's side read of listings.appointment_at is gone (merged onto loadLedgerAttribution); control — the scan sees a planted read", !/from\("listings"\)/.test(pipe) && /loadLedgerAttribution\(/.test(pipe) && /from\("listings"\)/.test(pipe + `svc.from("listings")`))
  }

  // ── V: WAVE 137 — the envelope ADMIN SCREEN (read + edit through the one versioned policy path) ──
  console.log("V — envelope admin screen")
  {
    const { AUTONOMY_ENVELOPE_FIELDS, validateAutonomyBudgetsEdit, DEFAULT_AUTONOMY_BUDGETS } = await import("../lib/kernel/autonomy-budgets")
    const leaves = (o: any, pre = ""): string[] => Object.entries(o).flatMap(([k, v]) => (v && typeof v === "object" ? leaves(v, `${pre}${k}.`) : [`${pre}${k}`]))
    const resolverPaths = leaves(DEFAULT_AUTONOMY_BUDGETS).filter((p) => p !== "readable" && p !== "note").sort()
    const fieldPaths = AUTONOMY_ENVELOPE_FIELDS.map((f) => f.path).sort()
    check("V1 every value the enforcement reads is editable on the screen (field paths = the resolver's leaves, derived)", JSON.stringify(resolverPaths) === JSON.stringify(fieldPaths), JSON.stringify({ resolverPaths, fieldPaths }))
    check("V2 every USD / percent-of-budget envelope is a MONEY field; the render cap and Finance alarms are not", AUTONOMY_ENVELOPE_FIELDS.every((f) => f.money === (f.unit === "usd" || f.unit === "pct")) && AUTONOMY_ENVELOPE_FIELDS.some((f) => f.money) && AUTONOMY_ENVELOPE_FIELDS.some((f) => !f.money))
    const base = resolveAutonomyBudgets({})
    const renders = validateAutonomyBudgetsEdit({ "asset_manager.max_renders_per_campaign": 6 }, base)
    check("V3 a render-cap edit changes ONE non-money key and round-trips through resolveAutonomyBudgets", renders.ok && renders.changedKeys.join() === "asset_manager.max_renders_per_campaign" && renders.moneyChanged.length === 0 && resolveAutonomyBudgets({ [AUTONOMY_BUDGETS_POLICY_KEY]: renders.value }).asset_manager.max_renders_per_campaign === 6, JSON.stringify(renders))
    const money = validateAutonomyBudgetsEdit({ "recruiting_manager.max_prospect_data_usd_per_month": 250 }, base)
    check("V4 a USD envelope edit is reported as MONEY (the door refuses it for a non-commerce seat)", money.ok && money.moneyChanged.join() === "recruiting_manager.max_prospect_data_usd_per_month")
    const bad = validateAutonomyBudgetsEdit({ "ads_manager.max_shift_pct_of_monthly_budget": 150, "provider_router.monthly_max_usd": -1 }, base)
    check("V5 out-of-bounds values are ERRORS (never silently clamped, never unlimited)", !bad.ok && bad.errors.length === 2)
    check("V6 POSITIVE CONTROL: unchanged input → no changed keys (the diff is not reporting everything)", (() => { const r = validateAutonomyBudgetsEdit({}, base); return r.ok && r.changedKeys.length === 0 })())
    const door = stripComments(readFileSync("app/actions/admin/improvement-proposals.ts", "utf8"))
    const body = door.slice(door.indexOf("export async function submitAutonomyEnvelopesAction"))
    check("V7 the edit door: tenant-admin roster + SESSION tenant, money envelopes need isTenantCommerceAdmin, the write is a human `policy` proposal on autonomy_budgets (proposeEvaluatePromote) — never a direct settings write", /requireCallerTenant\(\)/.test(door) && /isTenantCommerceAdmin\(/.test(door) && /moneyChanged\.length && !gate\.commerce/.test(body) && /proposeEvaluatePromote\(svc, \{[\s\S]{0,200}subjectKey: AUTONOMY_BUDGETS_POLICY_KEY, proposer: "human"/.test(body) && !/mergeBrokerageSettings\(/.test(body))
    check("V8 POSITIVE CONTROL: the direct-write scan sees a planted mergeBrokerageSettings(", /mergeBrokerageSettings\(/.test(body + "mergeBrokerageSettings("))
    const read = door.slice(door.indexOf("export async function getAutonomyEnvelopeEditor"), door.indexOf("export async function submitAutonomyEnvelopesAction"))
    check("V9 the read shows caps + consumption from autonomy_budget_consumptions through the Finance report's own read (buildAutonomyBudgetReport) and fails closed on an unreadable policy", /buildAutonomyBudgetReport\(svc, gate\.brokerageId\)/.test(read) && /readable/.test(read) && /from\("autonomy_budget_consumptions"\)/.test(stripComments(readFileSync("lib/kernel/autonomy-budgets.ts", "utf8"))))
    const page = stripComments(readFileSync("app/dashboard/admin/manager-trust/page.tsx", "utf8"))
    check("V10 the screen is wired from the existing Manager Trust page", /<AutonomyEnvelopesEditor \/>/.test(page) && /submitAutonomyEnvelopesAction/.test(readFileSync("app/dashboard/admin/manager-trust/autonomy-envelopes-form.tsx", "utf8")))
  }

  // ── W: wiring + migration + registration ─────────────────────────────────────────────────────
  console.log("W — wiring, migration, registration")
  {
    const rows = [{ campaignId: "w", campaignName: "W", spend: 500, leads: 40, clicks: 400, dailyBudget: 40 }, { campaignId: "l", campaignName: "L", spend: 500, leads: 5, clicks: 400, dailyBudget: 40 }]
    check("W1 ads: a CPL gap the significance test PROVES is proven; the same gap on 20 clicks is not (positive control)", provenRebalance(rows, { fromCampaignId: "l", toCampaignId: "w" }, strategySignificance).proven && !provenRebalance(rows.map((r) => ({ ...r, clicks: 20, leads: r.leads > 10 ? 4 : 1 })), { fromCampaignId: "l", toCampaignId: "w" }, strategySignificance).proven)
    const plan = planBudgetShift(40, 480, 10)
    check("W2 the shift is a REALLOCATION under the hard caps: the receiver is clamped to the ceiling, the giver loses only what moved", plan.toAfter <= 500 && plan.shift === plan.toAfter - 480 && plan.fromAfter === 40 - plan.shift)
    const loop = src("lib/ads/ad-outcome-loop.ts")
    check("W3 the ad outcome loop tries the envelope-bound shift BEFORE the gated proposal and releases on a failed shift", loop.indexOf("autonomousShift(svc, brokerageId, rows, decision)") > 0 && loop.indexOf("autonomousShift(svc, brokerageId, rows, decision)") < loop.indexOf("signalType: \"budget_rebalance\"") && loop.includes("releaseAutonomyEnvelope("))
    check("W4 enrollContact routes a contact through running / adopted experiments (the cohort chokepoint)", src("lib/campaign-sequences/enrollment-engine.ts").includes("routeEnrollmentThroughExperiments("))
    const cron = src("app/api/cron/source-conversion-learning/route.ts")
    check("W5 the weekly learning cron proposes the owner's example and concludes running experiments", cron.includes("proposeVideoFirstSellerExperiments(") && cron.includes("concludeExperiments("))
    check("W6 the nightly Finance P&L cron delivers the envelope report", src("app/api/cron/brokerage-pl-rollup/route.ts").includes("deliverAutonomyBudgetReport("))
    check("W7 improvement_proposals evaluates an experiment through the pipeline and adopts through mergeBrokerageSettings", src("lib/kernel/improvement-proposals.ts").includes("evaluateExperimentProposal(") && /experiments\.adopted/.test(readFileSync(join(ROOT, "lib/kernel/improvement-proposals.ts"), "utf8")))
    const mig = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => /autonomy-budget-envelopes/.test(f))
    const sql = mig.length ? readFileSync(join(ROOT, "supabase/migrations", mig[0]), "utf8").split("\n").filter((l) => !l.trim().startsWith("--")).join("\n") : ""
    const iLock = sql.indexOf("pg_advisory_xact_lock"), iSum = sql.indexOf("coalesce(sum(amount)"), iIns = sql.indexOf("INSERT INTO public.autonomy_budget_consumptions")
    check("W8 the migration's consume is ATOMIC in shape: lock → sum → refuse over cap → insert, service_role only", mig.length === 1 && iLock > 0 && iLock < iSum && iSum < iIns && /REVOKE ALL ON FUNCTION public\.consume_autonomy_budget[^;]*anon, authenticated/.test(sql) && /GRANT EXECUTE ON FUNCTION public\.consume_autonomy_budget[^;]*service_role/.test(sql))
    const env = /autonomy_budget_consumptions_envelope_check CHECK \(envelope IN \(([^)]*)\)/.exec(sql)
    check("W9 the envelope CHECK mirrors AUTONOMY_ENVELOPES exactly (one vocabulary)", !!env && JSON.stringify([...env[1].matchAll(/'([^']+)'/g)].map((x) => x[1])) === JSON.stringify([...AUTONOMY_ENVELOPES]))
    // The LATEST migration defining each proposal CHECK is the definer (superset rule) — not this lane's own file:
    // a later parallel lane (108G m732) restates the union, so pinning m731 would go red the moment work finished.
    const latestDefining = (re: RegExp): RegExpExecArray | null => {
      const dir = "supabase/migrations"
      const files = readdirSync(dir).filter((f) => /^m\d+.*\.sql$/.test(f)).sort((a, b) => Number(a.slice(1).split("-")[0]) - Number(b.slice(1).split("-")[0]))
      let hit: RegExpExecArray | null = null
      for (const f of files) { const m = re.exec(stripComments(readFileSync(`${dir}/${f}`, "utf8"))); if (m) hit = m }
      return hit
    }
    const sk = latestDefining(/improvement_proposals_subject_kind_check\s*CHECK \(subject_kind IN \(([^)]*)\)/), pr = latestDefining(/improvement_proposals_proposer_check\s*CHECK \(proposer IN \(([^)]*)\)/)
    check("W10 the LATEST migration defining each proposal CHECK holds exactly the code constants (superset rule; includes experiment / experimentation)", !!sk && !!pr && JSON.stringify([...sk[1].matchAll(/'([^']+)'/g)].map((x) => x[1])) === JSON.stringify([...PROPOSAL_SUBJECT_KINDS]) && JSON.stringify([...pr[1].matchAll(/'([^']+)'/g)].map((x) => x[1])) === JSON.stringify([...PROPOSERS]))
    check("W11 experiment classes never include an authority / financial / compliance class", EXPERIMENT_CLASSES.every((c) => !/authority|financ|compliance|commission|pricing/.test(c)))
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> }
    check("W12 package.json registers test:autonomous-budgeting and the guard chain runs it (membership, never a position)", !!pkg.scripts["test:autonomous-budgeting"] && new RegExp("npm run test:autonomous-budgeting(\\s|&|$)").test(pkg.scripts.guard))
    const dom = MAINTENANCE_DOMAINS.autonomous_budgeting
    check("W13 MAINTENANCE_DOMAINS.autonomous_budgeting: finance_manager accountable, co-owners real and named in the prose", !!dom && dom.manager === "finance_manager" && dom.proof === "test:autonomous-budgeting" && (dom.coOwners ?? []).length >= 4 && (dom.coOwners ?? []).every((k) => k in MANAGERS && dom.what.includes(k)))
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`)
  process.exit(fail ? 1 : 0)
}

main().catch((e) => { console.error(e); process.exit(1) })
