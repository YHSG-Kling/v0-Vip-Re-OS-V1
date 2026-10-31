// lib/intelligence/strategy-learning.ts
// ─────────────────────────────────────────────────────────────────────────────
// STRATEGY LEARNING (wave 107, lane 107F; owner: "which strategies work, tenant vs platform …
// Strategy A vs B on conversion, appointments, revenue, cost, complaints, opt-outs, time-to-conversion,
// agent workload … 'Strategy B works platform-wide, but Strategy A works better for this brokerage.'").
//
// NOT A NEW SUBSYSTEM (LAW 1/2). Every number is a reading of a survivor:
//   · which strategy a row served ... agent_action_ledger.detail.strategy (107E activations write it;
//                                     roi-ledger.ts strategyRefOf is the ONE spelling — lazy seam)
//   · outcomes + revenue ............ roi-ledger.ts loadLedgerAttribution (the deterministic last-touch rule)
//   · cost .......................... agent_action_ledger.cost_usd on the strategy's own rows
//   · opt-outs / complaints ......... leads.opted_out_at / opt_out_reason + contact_suppression_list
//   · agent workload ................ ledger rows a HUMAN performed (actor_type 'user') per subject
//   · platform scope ................ network_benchmarks (m726) k-anonymous cells ONLY — never another
//                                     tenant's rows (lib/intelligence/network-benchmarks.ts)
//   · the finding ................... improvement_proposals (subject_kind 'strategy', proposer
//                                     'strategy_learning') — RECOMMENDATION; a human approves (authority 6)
// The verdict is deterministic statistics (two-proportion z-test + Wilson 95 % intervals) — no model.

import { loadLedgerAttribution, strategyRefOf } from "@/lib/intelligence/roi-ledger"

type Svc = { from: (t: string) => any }

/** Minimum exposed subjects per arm before any verdict (thin data is never a verdict). */
const STRATEGY_MIN_SAMPLE = 30
/** Two-sided 95 %. */
const Z_95 = 1.959964

export interface StrategyStats {
  ref: string
  /** Distinct subjects (contact / lead / deal) the strategy touched in the window — the sample size. */
  exposures: number
  /** Distinct subjects whose contract / closing was last-touch credited to the strategy. */
  conversions: number
  conversionRate: number | null
  /** Wilson 95 % interval on conversionRate. */
  interval: [number, number] | null
  appointments: number
  revenueCents: number
  costUsd: number
  optOuts: number
  complaints: number
  /** Median days from the strategy's first touch to the converting outcome. */
  medianDaysToConversion: number | null
  /** Ledger rows a human agent performed per exposed subject. */
  humanTouchesPerSubject: number | null
}

export type StrategyVerdict = "a_better" | "b_better" | "no_difference" | "insufficient_sample"

export interface StrategySignificance {
  verdict: StrategyVerdict
  z: number | null
  /** Difference in conversion rate (a − b). */
  diff: number | null
  why: string
}

/** PURE — Wilson score 95 % interval for k successes in n. */
function wilsonInterval(k: number, n: number): [number, number] | null {
  if (!(n > 0)) return null
  const p = k / n, z2 = Z_95 * Z_95
  const den = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / den
  const half = (Z_95 * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den
  return [Math.max(0, +(centre - half).toFixed(4)), Math.min(1, +(centre + half).toFixed(4))]
}

/**
 * PURE — the deterministic significance verdict on conversion: a pooled two-proportion z-test, two-sided
 * α = 0.05, with a sample floor (each arm ≥ STRATEGY_MIN_SAMPLE exposures and ≥ 5 conversions overall).
 * @proofSeam exported so scripts/network-intelligence-guard.ts asserts the significance controls directly.
 */
export function strategySignificance(a: { exposures: number; conversions: number }, b: { exposures: number; conversions: number }, minSample = STRATEGY_MIN_SAMPLE): StrategySignificance {
  if (a.exposures < minSample || b.exposures < minSample || a.conversions + b.conversions < 5) {
    return { verdict: "insufficient_sample", z: null, diff: null, why: `needs ≥ ${minSample} exposures per strategy and ≥ 5 conversions (have ${a.exposures}/${b.exposures} exposures, ${a.conversions + b.conversions} conversions)` }
  }
  const pa = a.conversions / a.exposures, pb = b.conversions / b.exposures
  const pool = (a.conversions + b.conversions) / (a.exposures + b.exposures)
  const se = Math.sqrt(pool * (1 - pool) * (1 / a.exposures + 1 / b.exposures))
  const diff = +(pa - pb).toFixed(4)
  if (!(se > 0)) return { verdict: "no_difference", z: 0, diff, why: "no variance in conversion" }
  const z = +((pa - pb) / se).toFixed(3)
  if (Math.abs(z) < Z_95) return { verdict: "no_difference", z, diff, why: `|z| = ${Math.abs(z)} < 1.96 — not significant at 95 %` }
  return { verdict: z > 0 ? "a_better" : "b_better", z, diff, why: `z = ${z} (95 %): ${(pa * 100).toFixed(1)}% vs ${(pb * 100).toFixed(1)}% conversion` }
}

/** Does a ledger ref match the asked-for strategy? `key` matches every version, `key@vN` only that one. */
function refMatches(rowRef: { key: string; ref: string }, wanted: string): boolean {
  return wanted.includes("@") ? rowRef.ref === wanted : rowRef.key === wanted
}

interface StrategyRow { id: string; subject_type: string; subject_id: string | null; actor_type: string; cost_usd: number | string | null; created_at: string; detail: Record<string, unknown> | null }

/**
 * PURE — the tenant-scope stats of each wanted strategy from its ledger rows, the last-touch credits and the
 * opt-out / complaint subjects. One subject may serve two strategies; each counts it once.
 * @proofSeam exported so scripts/network-intelligence-guard.ts asserts the attribution → stats rule directly.
 */
export function strategyStatsFromRows(input: {
  wanted: string[]
  rows: StrategyRow[]
  credits: Array<{ actionId: string; model: string; kind: string; cents: number; outcomeRef: string }>
  outcomeAt: ReadonlyMap<string, string>
  optOutSubjects: ReadonlySet<string>
  complaintSubjects: ReadonlySet<string>
}): StrategyStats[] {
  return input.wanted.map((wanted) => {
    const rows = input.rows.filter((r) => { const s = strategyRefOf(r.detail); return !!s && refMatches(s, wanted) })
    const firstTouch = new Map<string, number>()
    let cost = 0, human = 0
    for (const r of rows) {
      cost += Number(r.cost_usd ?? 0) || 0
      if (r.actor_type === "user") human++
      if (!r.subject_id) continue
      const t = Date.parse(r.created_at)
      const prev = firstTouch.get(r.subject_id)
      if (Number.isFinite(t) && (prev === undefined || t < prev)) firstTouch.set(r.subject_id, t)
    }
    const byId = new Map(rows.map((r) => [r.id, r]))
    const converted = new Map<string, number>()
    let appointments = 0, revenueCents = 0
    for (const c of input.credits) {
      if (c.model !== "last_touch") continue
      const r = byId.get(c.actionId)
      if (!r) continue
      if (c.kind === "appointment") appointments++
      if (c.kind === "closed") revenueCents += c.cents
      if ((c.kind === "contract" || c.kind === "closed") && r.subject_id) {
        const at = Date.parse(input.outcomeAt.get(c.outcomeRef) ?? "")
        const prev = converted.get(r.subject_id)
        if (Number.isFinite(at) && (prev === undefined || at < prev)) converted.set(r.subject_id, at)
      }
    }
    const days = [...converted.entries()].map(([s, at]) => (at - (firstTouch.get(s) ?? at)) / 86_400_000).filter((d) => d >= 0).sort((x, y) => x - y)
    const exposures = firstTouch.size
    const conversions = converted.size
    const subjects = [...firstTouch.keys()]
    return {
      ref: wanted, exposures, conversions,
      conversionRate: exposures > 0 ? +(conversions / exposures).toFixed(4) : null,
      interval: wilsonInterval(conversions, exposures),
      appointments, revenueCents, costUsd: +cost.toFixed(4),
      optOuts: subjects.filter((s) => input.optOutSubjects.has(s)).length,
      complaints: subjects.filter((s) => input.complaintSubjects.has(s)).length,
      medianDaysToConversion: days.length ? +days[Math.floor((days.length - 1) / 2)].toFixed(1) : null,
      humanTouchesPerSubject: exposures > 0 ? +(human / exposures).toFixed(2) : null,
    }
  })
}

const COMPLAINT_RE = /complain|spam|abuse/i
const LEDGER_LIMIT = 5000

/**
 * Read the tenant's strategy rows + their attribution + opt-out / complaint subjects in the window and
 * return stats for `wanted` (every strategy seen when `wanted` is null). Every read pinned to brokerageId
 * (the caller's SESSION tenant or the cron's per-tenant loop); refusals are returned, never zeros.
 */
export async function tenantStrategyStats(
  svc: Svc,
  brokerageId: string,
  opts: { sinceIso: string; wanted?: string[] | null },
): Promise<{ ok: true; stats: StrategyStats[]; refsSeen: string[] } | { ok: false; error: string }> {
  if (!brokerageId) return { ok: false, error: "no brokerage" }
  const { data, error } = await svc.from("agent_action_ledger")
    .select("id, subject_type, subject_id, actor_type, cost_usd, created_at, detail")
    .eq("brokerage_id", brokerageId).gte("created_at", opts.sinceIso).not("detail->strategy", "is", null).limit(LEDGER_LIMIT)
  if (error) return { ok: false, error: `agent_action_ledger: ${error.message}` }
  const rows = (data ?? []) as StrategyRow[]
  const refsSeen = [...new Set(rows.map((r) => strategyRefOf(r.detail)?.ref).filter((x): x is string => !!x))].sort()
  const wanted = opts.wanted ?? refsSeen
  if (rows.length === 0 || wanted.length === 0) return { ok: true, stats: strategyStatsFromRows({ wanted, rows: [], credits: [], outcomeAt: new Map(), optOutSubjects: new Set(), complaintSubjects: new Set() }), refsSeen }
  const attr = await loadLedgerAttribution(svc, brokerageId, { sinceIso: opts.sinceIso })
  if (!attr.ok) return { ok: false, error: `attribution: ${attr.error}` }
  const leadIds = [...new Set(rows.filter((r) => r.subject_type === "lead" && r.subject_id).map((r) => r.subject_id as string))]
  const contactIds = [...new Set(rows.filter((r) => r.subject_type === "contact" && r.subject_id).map((r) => r.subject_id as string))]
  const optOut = new Set<string>(), complaint = new Set<string>()
  for (let i = 0; i < leadIds.length; i += 200) {
    const r = await svc.from("leads").select("id, opted_out_at, opt_out_reason").eq("brokerage_id", brokerageId).in("id", leadIds.slice(i, i + 200)).gte("opted_out_at", opts.sinceIso)
    if (r.error) return { ok: false, error: `leads: ${r.error.message}` }
    for (const l of (r.data ?? []) as Array<{ id: string; opted_out_at: string | null; opt_out_reason: string | null }>) {
      if (!l.opted_out_at) continue
      ;(COMPLAINT_RE.test(String(l.opt_out_reason ?? "")) ? complaint : optOut).add(l.id)
    }
  }
  for (let i = 0; i < contactIds.length; i += 200) {
    const r = await svc.from("contact_suppression_list").select("contact_id, suppression_reason, source").eq("brokerage_id", brokerageId).in("contact_id", contactIds.slice(i, i + 200)).gte("created_at", opts.sinceIso)
    if (r.error) return { ok: false, error: `contact_suppression_list: ${r.error.message}` }
    for (const s of (r.data ?? []) as Array<{ contact_id: string | null; suppression_reason: string | null; source: string | null }>) {
      if (!s.contact_id) continue
      ;(COMPLAINT_RE.test(`${s.suppression_reason ?? ""} ${s.source ?? ""}`) ? complaint : optOut).add(s.contact_id)
    }
  }
  const outcomeAt = new Map(attr.result.outcomes.map((o) => [o.ref, o.at]))
  return { ok: true, refsSeen, stats: strategyStatsFromRows({ wanted, rows, credits: attr.result.credits, outcomeAt, optOutSubjects: optOut, complaintSubjects: complaint }) }
}

/** Platform-scope stats from the published k-anonymous cells (network_benchmarks, latest period). Conversion only. */
async function platformStrategyStats(svc: Svc, wanted: string[]): Promise<{ ok: true; stats: Array<{ ref: string; exposures: number; conversions: number; conversionRate: number | null; tenants: number } | null> } | { ok: false; error: string }> {
  const { readNetworkBenchmarks } = await import("@/lib/intelligence/network-benchmarks")
  const r = await readNetworkBenchmarks(svc, { metric: "strategy_conversion" })
  if (!r.ok) return r
  return {
    ok: true, stats: wanted.map((w) => {
      const c = r.cells.find((x) => x.strategy_key === w)
      if (!c) return null
      const n = Number(c.sample_size ?? 0)
      return { ref: w, exposures: n, conversions: Math.round(Number(c.rate ?? 0) * n), conversionRate: c.rate, tenants: Number(c.tenant_count ?? 0) }
    }),
  }
}

export interface StrategyComparison {
  scope: "tenant" | "platform"
  windowDays: number
  a: StrategyStats | { ref: string; exposures: number; conversions: number; conversionRate: number | null; tenants: number } | null
  b: StrategyStats | { ref: string; exposures: number; conversions: number; conversionRate: number | null; tenants: number } | null
  significance: StrategySignificance
  blindSpots: string[]
}

/**
 * compareStrategies(brokerageId, a, b, window) — the owner's comparison. `scope: "tenant"` reads only this
 * brokerage's ledger; `scope: "platform"` reads only the published k-anonymous benchmark cells (never another
 * tenant's rows; conversion only, published after ≥ k tenants and ≥ n events). Deterministic, no model.
 */
export async function compareStrategies(
  svc: Svc,
  brokerageId: string,
  a: string,
  b: string,
  window: { days: number; now?: Date } = { days: 90 },
  opts: { scope?: "tenant" | "platform" } = {},
): Promise<{ ok: true; comparison: StrategyComparison } | { ok: false; error: string }> {
  const scope = opts.scope ?? "tenant"
  const windowDays = Math.max(1, Math.min(365, Math.round(window.days || 90)))
  if (scope === "platform") {
    const p = await platformStrategyStats(svc, [a, b])
    if (!p.ok) return p
    const [sa, sb] = p.stats
    return { ok: true, comparison: {
      scope, windowDays, a: sa, b: sb,
      significance: sa && sb ? strategySignificance(sa, sb) : { verdict: "insufficient_sample", z: null, diff: null, why: "no published network cell for one of the strategies (suppressed below k tenants / n events, or never run)" },
      blindSpots: ["platform scope is conversion only (cells carry rate + rounded sample size)", "the latest published period, not the asked window"],
    } }
  }
  const sinceIso = new Date((window.now ?? new Date()).getTime() - windowDays * 86_400_000).toISOString()
  const t = await tenantStrategyStats(svc, brokerageId, { sinceIso, wanted: [a, b] })
  if (!t.ok) return t
  const [sa, sb] = t.stats
  return { ok: true, comparison: {
    scope, windowDays, a: sa, b: sb, significance: strategySignificance(sa, sb),
    blindSpots: ["a strategy row with no subject is not an exposure", "attribution is last-touch (roi-ledger) — a subject touched by both strategies credits the later one", "complaints read leads.opt_out_reason + suppression reason text; a carrier complaint not written there is invisible"],
  } }
}

/**
 * PURE — the owner's finding. A significant TENANT verdict is a recommendation; when the PLATFORM verdict is
 * significant the other way it carries the divergence sentence.
 * @proofSeam exported so scripts/network-intelligence-guard.ts asserts the divergence sentence directly.
 */
export function strategyFinding(a: string, b: string, tenant: StrategySignificance, platform: StrategySignificance | null): { winner: string; loser: string; divergesFromPlatform: boolean; statement: string } | null {
  if (tenant.verdict !== "a_better" && tenant.verdict !== "b_better") return null
  const winner = tenant.verdict === "a_better" ? a : b
  const loser = winner === a ? b : a
  const platformWinner = platform?.verdict === "a_better" ? a : platform?.verdict === "b_better" ? b : null
  const diverges = platformWinner !== null && platformWinner !== winner
  return {
    winner, loser, divergesFromPlatform: diverges,
    statement: diverges
      ? `Strategy ${loser} works platform-wide, but ${winner} works better for this brokerage (${tenant.why}).`
      : `Strategy ${winner} converts better than ${loser} for this brokerage (${tenant.why})${platformWinner === winner ? " — the network agrees." : "."}`,
  }
}

export interface StrategyLearningRun { strategies: number; pairs: number; proposed: number; existing: number; errors: string[] }

const MAX_STRATEGIES = 6

/**
 * The weekly learner (app/api/cron/network-intelligence/route.ts, per tenant AFTER the benchmark
 * aggregation): every pair of the tenant's most-exposed strategies is compared at tenant and platform scope;
 * a significant tenant verdict becomes ONE improvement proposal (subject strategy_choice:<a>|<b>) a human
 * approves on the Manager Trust page. Idempotent: an open proposal on the same subject is reused.
 */
export async function runStrategyLearning(svc: Svc, brokerageId: string, opts: { windowDays?: number; now?: Date } = {}): Promise<StrategyLearningRun> {
  const run: StrategyLearningRun = { strategies: 0, pairs: 0, proposed: 0, existing: 0, errors: [] }
  const windowDays = opts.windowDays ?? 90
  const sinceIso = new Date((opts.now ?? new Date()).getTime() - windowDays * 86_400_000).toISOString()
  const all = await tenantStrategyStats(svc, brokerageId, { sinceIso })
  if (!all.ok) { run.errors.push(all.error); return run }
  const top = [...all.stats].sort((x, y) => y.exposures - x.exposures).filter((s) => s.exposures > 0).slice(0, MAX_STRATEGIES)
  run.strategies = top.length
  if (top.length < 2) return run
  const platform = await platformStrategyStats(svc, top.map((s) => s.ref))
  const pStats = new Map<string, { exposures: number; conversions: number }>()
  if (platform.ok) platform.stats.forEach((s) => { if (s) pStats.set(s.ref, s) })
  else run.errors.push(`platform cells: ${platform.error}`)
  const { proposeImprovement } = await import("@/lib/kernel/improvement-proposals")
  for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
    const [sa, sb] = [top[i], top[j]].sort((x, y) => x.ref.localeCompare(y.ref))
    run.pairs++
    const tenantSig = strategySignificance(sa, sb)
    const pa = pStats.get(sa.ref), pb = pStats.get(sb.ref)
    const platformSig = pa && pb ? strategySignificance(pa, pb) : null
    const finding = strategyFinding(sa.ref, sb.ref, tenantSig, platformSig)
    if (!finding) continue
    const w = await proposeImprovement(svc, {
      brokerageId, subjectKind: "strategy", subjectKey: `strategy_choice:${sa.ref}|${sb.ref}`, proposer: "strategy_learning",
      proposedChange: { winner: finding.winner, loser: finding.loser, statement: finding.statement, divergesFromPlatform: finding.divergesFromPlatform, windowDays, tenant: { a: sa, b: sb, significance: tenantSig }, platform: platformSig ? { a: pa, b: pb, significance: platformSig } : null },
      evidenceRefs: [{ kind: "agent_action_ledger.detail.strategy", window_days: windowDays }, ...(platformSig ? [{ kind: "network_benchmarks", metric: "strategy_conversion" }] : [])],
    })
    if (!w.ok) { run.errors.push(w.error); continue }
    if (w.existing) run.existing++
    else run.proposed++
  }
  return run
}

/**
 * The strategy engine's LEARNED-PERFORMANCE reader (wave 107 integration — the 107E selection seam's default).
 * Tenant stats come from tenantStrategyStats (the one attribution reader, ledger detail.strategy); the
 * platform benchmark from the published network cells (metric strategy_conversion — k-anonymous, no tenant
 * rows). `score` in [0,1] = the tenant's conversion relative to the network (½ = at benchmark), or the raw
 * rate scaled when no cell is published. A refused read THROWS so the engine reports "refused", never 0.
 */
export async function strategyLearningForSelection(
  brokerageId: string,
  keys: string[],
  client: Svc,
): Promise<{
  performance: Record<string, { score: number; sample: number; benchmarkRate: number | null; tenantRate: number | null; source: string }>
  history: Record<string, { sample: number; conversionRate: number | null; benchmarkRate: number | null }>
  benchmarks: Record<string, { conversionRate: number | null; sample: number }>
}> {
  const since = new Date(Date.now() - 90 * 86_400_000).toISOString()
  const t = await tenantStrategyStats(client, brokerageId, { sinceIso: since, wanted: keys })
  if (!t.ok) throw new Error(t.error)
  const { readNetworkBenchmarks } = await import("@/lib/intelligence/network-benchmarks")
  const nb = await readNetworkBenchmarks(client, { metric: "strategy_conversion" })
  const benchmarks: Record<string, { conversionRate: number | null; sample: number }> = {}
  if (nb.ok) for (const c of nb.cells) if (c.strategy_key && keys.includes(c.strategy_key)) benchmarks[c.strategy_key] = { conversionRate: c.rate ?? null, sample: Number(c.sample_size ?? 0) }
  const performance: Record<string, { score: number; sample: number; benchmarkRate: number | null; tenantRate: number | null; source: string }> = {}
  const history: Record<string, { sample: number; conversionRate: number | null; benchmarkRate: number | null }> = {}
  for (const key of keys) {
    const rows = t.stats.filter((s) => s.ref === key || s.ref.startsWith(`${key}@`))
    const exposures = rows.reduce((n, s) => n + s.exposures, 0)
    const conversions = rows.reduce((n, s) => n + s.conversions, 0)
    const rate = exposures > 0 ? conversions / exposures : null
    const bench = benchmarks[key]?.conversionRate ?? null
    history[key] = { sample: exposures, conversionRate: rate, benchmarkRate: bench }
    if (rate === null) continue
    const score = bench && bench > 0 ? Math.max(0, Math.min(1, rate / bench / 2)) : Math.max(0, Math.min(1, rate * 5))
    performance[key] = { score, sample: exposures, benchmarkRate: bench, tenantRate: rate, source: bench !== null ? "tenant vs network strategy_conversion" : "tenant only (no published network cell)" }
  }
  return { performance, history, benchmarks }
}
