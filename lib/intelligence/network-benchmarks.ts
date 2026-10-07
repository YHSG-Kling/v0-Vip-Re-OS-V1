// lib/intelligence/network-benchmarks.ts
// ─────────────────────────────────────────────────────────────────────────────
// PRIVACY-SAFE NETWORK INTELLIGENCE (wave 107, lane 107F; m726). Owner: "Do not mix tenants' private
// records … anonymized/aggregated benchmarks (regional seller campaigns, brokerage conversion, provider
// reliability, channel response, content performance, education effectiveness) … without seeing another
// brokerage's data."
//
// THE RULES (deterministic, no model):
//   · CONTRIBUTE only with consent — brokerage_settings.settings.network_benchmarks_opt_in.opted_in === true
//     (a versioned tenant policy key). Absent / unreadable = NOT contributing (fail closed). Default OFF: no
//     owner ruling makes contribution default-on.
//   · WRITE only from the platform cron (app/api/cron/network-intelligence/route.ts) through the service
//     client: each opted-in tenant's aggregates are read pinned to that tenant, held in memory, and only the
//     PUBLISHABLE cells are written. The tenant id never leaves this process (the table has no tenant column).
//   · PUBLISH a cell only when ≥ k distinct tenants AND ≥ n events contribute, and no single tenant holds more
//     than NETWORK_BENCHMARK_POLICY.maxTenantShare of the events (dominance). k / n / share are platform
//     policy (below) with hard floors a policy edit cannot go under.
//   · NO free text, no tenant id, no person id: every segment value must match SAFE_SEGMENT and must not look
//     like a uuid / long digit run — anything else is dropped (counted, never published).
//   · READ by every tenant beside its OWN numbers (benchmarksBeside); nothing names another brokerage.
//
// SURVIVORS READ (per tenant, all pinned to brokerage_id): leads (conversion; seller-campaign conversion by
// market band), agent_action_ledger.provider/status/settled_at (provider fabric reliability + latency),
// isa_outreach_log (channel response), marketing_assets.performance (106C content performance),
// learning_assignments × learning_modules.gap_tags ∩ COMPETENCY_SKILLS (106D education effectiveness),
// lib/intelligence/strategy-learning.ts tenantStrategyStats (strategy conversion).

import { COMPETENCY_SKILLS } from "@/lib/education/skill-freshness"

type Svc = { from: (t: string) => any }

const NETWORK_BENCHMARK_METRICS = [
  "seller_campaign_conversion", "brokerage_conversion", "strategy_conversion", "provider_reliability",
  "channel_response", "content_performance", "education_effectiveness",
] as const
export type NetworkBenchmarkMetric = (typeof NETWORK_BENCHMARK_METRICS)[number]

/** Platform policy. Raising k / n is a code review; lowering below the floors is impossible (clamped). */
export const NETWORK_BENCHMARK_POLICY = Object.freeze({ version: "nb-2", minTenants: 5, minEvents: 30, maxTenantShare: 0.6, windowDays: 90 })
const POLICY_FLOOR = Object.freeze({ minTenants: 3, minEvents: 10, maxTenantShare: 0.8 })
type BenchmarkPolicy = { version: string; minTenants: number; minEvents: number; maxTenantShare: number; windowDays: number }

const SEGMENT_DIMS = ["market_band", "strategy_key", "channel", "provider", "content_kind", "competency"] as const
type SegmentDim = (typeof SEGMENT_DIMS)[number]
type Segment = Partial<Record<SegmentDim, string | null>>

const SAFE_SEGMENT = /^[a-z0-9][a-z0-9_.@-]{0,63}$/
const IDENTIFYING = /[0-9a-f]{8}-?[0-9a-f]{4}|[0-9]{7,}|@[a-z0-9-]+\.[a-z]/

/** PURE — a segment value is publishable only when it is a short vocabulary token, never an id or free text. */
function safeSegmentValue(v: unknown): v is string {
  return typeof v === "string" && SAFE_SEGMENT.test(v) && !IDENTIFYING.test(v)
}

export interface TenantContribution {
  /** In-memory only — the contributing tenant. NEVER written. */
  tenant: string
  metric: NetworkBenchmarkMetric
  segment: Segment
  numerator: number
  denominator: number
  /** Events this tenant contributes to the cell (the n of k-anonymity). */
  events: number
  meanSum?: number
  meanCount?: number
}

export interface PublishedCell {
  period_start: string
  period_end: string
  metric: NetworkBenchmarkMetric
  market_band: string | null
  strategy_key: string | null
  channel: string | null
  provider: string | null
  content_kind: string | null
  competency: string | null
  cell_key: string
  rate: number | null
  /** The pooled denominator rounded DOWN to a multiple of 10 (differencing resistance). */
  sample_size: number
  mean: number | null
  tenant_count: number
  event_count: number
  k_min: number
  n_min: number
  policy_version: string
}

export interface PublishReport {
  cells: PublishedCell[]
  suppressed: { belowTenants: number; belowEvents: number; dominance: number; unsafeSegment: number }
  policy: BenchmarkPolicy
}

/**
 * ROUNDING — closes the JOIN / LEAVE leak (wave 108 owner ruling: "ROUND benchmark rates").
 *
 * k-anonymity stops a cell naming one tenant, but not DIFFERENCING: when one tenant joins (or leaves)
 * between two periods, an observer holding both cells recovers that tenant's own numbers exactly —
 * numerator_t = R1·D1 − R0·D0 and denominator_t = D1 − D0, so rate_t = Δnum / Δden. Exact rates, exact
 * pooled denominators and exact tenant / event counts make that subtraction exact.
 *
 * The publish path therefore rounds EVERYTHING a subtraction could use:
 *   · rate to a step g (below); sample_size + event_count DOWN to multiples of COUNT_STEP; tenant_count
 *     DOWN to multiples of TENANT_STEP (never below k); mean to two significant figures.
 *   · With rates rounded to g (each published rate off by up to g/2) the recovered numerator is off by up
 *     to (g/2)(D0 + D1), so the recovered rate_t carries a half-width of (g/2)(D0 + D1)/d_t. The dominance
 *     rule caps one tenant at s = maxTenantShare of the events (d_t ≤ s·D1, D0 ≥ (1−s)·D1), so EVEN THE
 *     LARGEST PERMITTED TENANT is blurred by at least (g/2)(2 − s)/s; a smaller tenant is blurred more.
 *   · g is DERIVED, never hand-picked: the smallest step in RATE_STEPS whose worst-case blur reaches
 *     MIN_RECOVERY_HALF_WIDTH (±5 percentage points — wider than the spread between typical brokerage
 *     conversion rates, so the subtraction cannot rank the joiner against its peers). At the platform
 *     policy (s = 0.6) that is 0.05; at the policy floor (s = 0.8) 0.10. A policy edit cannot make the
 *     step finer — it is a function of the dominance cap.
 * @proofSeam exported so scripts/network-intelligence-guard.ts proves the leak (positive control) and the blur.
 */
export const MIN_RECOVERY_HALF_WIDTH = 0.05
const RATE_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.25, 0.5] as const
const COUNT_STEP = 10
const TENANT_STEP = 5
/** PURE — the derived rate step for a dominance cap (the rounding rule above).
 *  @proofSeam scripts/network-intelligence-guard.ts asserts the step is derived (0.05 at s = 0.6, 0.1 at the floor). */
export function benchmarkRateStep(maxTenantShare: number): number {
  const s = Math.min(1, Math.max(0.01, maxTenantShare))
  for (const g of RATE_STEPS) if ((g / 2) * ((2 - s) / s) >= MIN_RECOVERY_HALF_WIDTH - 1e-12) return g
  return RATE_STEPS[RATE_STEPS.length - 1]
}
const roundTo = (x: number, step: number) => +(Math.round(x / step) * step).toFixed(4)
const floorTo = (x: number, step: number) => Math.floor(x / step) * step
const roundSig2 = (x: number) => (x === 0 ? 0 : +x.toPrecision(2))

function effectivePolicy(p: Partial<BenchmarkPolicy> = {}): BenchmarkPolicy {
  const base = { ...NETWORK_BENCHMARK_POLICY, ...p }
  return {
    version: String(base.version), windowDays: Math.max(7, Math.round(base.windowDays)),
    minTenants: Math.max(POLICY_FLOOR.minTenants, Math.round(base.minTenants)),
    minEvents: Math.max(POLICY_FLOOR.minEvents, Math.round(base.minEvents)),
    maxTenantShare: Math.min(POLICY_FLOOR.maxTenantShare, base.maxTenantShare),
  }
}

/**
 * PURE — k-anonymous publication. Groups contributions into cells (metric × segment), drops any cell with an
 * unsafe segment value, fewer than k tenants, fewer than n events, or one tenant holding more than the
 * dominance share; pools the rest. The output carries NO tenant identifier.
 * @proofSeam exported so scripts/network-intelligence-guard.ts asserts suppression + anonymity on the pure function directly.
 */
export function publishBenchmarkCells(contribs: TenantContribution[], period: { start: string; end: string }, policyIn: Partial<BenchmarkPolicy> = {}): PublishReport {
  const policy = effectivePolicy(policyIn)
  const rateStep = benchmarkRateStep(policy.maxTenantShare)
  const suppressed = { belowTenants: 0, belowEvents: 0, dominance: 0, unsafeSegment: 0 }
  const groups = new Map<string, { metric: NetworkBenchmarkMetric; seg: Record<SegmentDim, string | null>; byTenant: Map<string, { num: number; den: number; ev: number; ms: number; mc: number }> }>()
  const unsafeKeys = new Set<string>()
  for (const c of contribs) {
    if (!(NETWORK_BENCHMARK_METRICS as readonly string[]).includes(c.metric)) continue
    const seg = Object.fromEntries(SEGMENT_DIMS.map((d) => [d, c.segment[d] ?? null])) as Record<SegmentDim, string | null>
    const key = `${c.metric}|${SEGMENT_DIMS.map((d) => seg[d] ?? "*").join("|")}`
    if (SEGMENT_DIMS.some((d) => seg[d] !== null && !safeSegmentValue(seg[d]))) { unsafeKeys.add(key); continue }
    const g = groups.get(key) ?? { metric: c.metric, seg, byTenant: new Map() }
    const t = g.byTenant.get(c.tenant) ?? { num: 0, den: 0, ev: 0, ms: 0, mc: 0 }
    t.num += Math.max(0, Number(c.numerator) || 0); t.den += Math.max(0, Number(c.denominator) || 0); t.ev += Math.max(0, Number(c.events) || 0)
    t.ms += Number(c.meanSum ?? 0) || 0; t.mc += Math.max(0, Number(c.meanCount ?? 0) || 0)
    g.byTenant.set(c.tenant, t)
    groups.set(key, g)
  }
  suppressed.unsafeSegment = unsafeKeys.size
  const cells: PublishedCell[] = []
  for (const [key, g] of [...groups.entries()].sort((x, y) => x[0].localeCompare(y[0]))) {
    const tenants = [...g.byTenant.values()].filter((t) => t.ev > 0)
    const events = tenants.reduce((s, t) => s + t.ev, 0)
    if (tenants.length < policy.minTenants) { suppressed.belowTenants++; continue }
    if (events < policy.minEvents) { suppressed.belowEvents++; continue }
    if (Math.max(...tenants.map((t) => t.ev)) / events > policy.maxTenantShare) { suppressed.dominance++; continue }
    const num = tenants.reduce((s, t) => s + t.num, 0), den = tenants.reduce((s, t) => s + t.den, 0)
    const ms = tenants.reduce((s, t) => s + t.ms, 0), mc = tenants.reduce((s, t) => s + t.mc, 0)
    cells.push({
      period_start: period.start, period_end: period.end, metric: g.metric, ...g.seg, cell_key: key,
      rate: den > 0 ? roundTo(num / den, rateStep) : null, sample_size: floorTo(den, COUNT_STEP),
      mean: mc > 0 ? roundSig2(ms / mc) : null, tenant_count: Math.max(policy.minTenants, floorTo(tenants.length, TENANT_STEP)), event_count: floorTo(events, COUNT_STEP),
      k_min: policy.minTenants, n_min: policy.minEvents, policy_version: policy.version,
    })
  }
  return { cells, suppressed, policy }
}

// ── market band — DERIVED from tenant data, never a hard-coded region ──────────────────────
// Wave 108 owner ruling: territories are anywhere in the US, so no module names a region or a state.
// TOMBSTONE (§1): a hand-written region table (seven named bands mapping state codes) stood here — a
// literal geography no tenant chose. SURVIVOR: this function, which reads the brokerage's OWN stored
// brokerages.state and lower-cases it into a vocabulary token. k-anonymity still holds per band: a
// band with fewer than k opted-in tenants publishes nothing (suppressed.belowTenants).
/** PURE — the market band of a stored state code ("unknown_market" when absent / not a 2-letter code).
 *  @proofSeam scripts/network-intelligence-guard.ts drives it directly (derived, never a literal). */
export function marketBandForState(state: string | null | undefined): string {
  const s = String(state ?? "").trim().toLowerCase()
  return /^[a-z]{2}$/.test(s) ? s : "unknown_market"
}

// ── consent ─────────────────────────────────────────────────────────────────────────────────
/** The contractual gate. true ONLY on an explicit opted_in === true; any refusal / absence = false. */
export async function readNetworkOptIn(svc: Svc, brokerageId: string): Promise<boolean> {
  const { data, error } = await svc.from("brokerage_settings").select("settings").eq("brokerage_id", brokerageId).maybeSingle()
  if (error || !data) return false
  const v = (data.settings ?? {}).network_benchmarks_opt_in
  return !!v && typeof v === "object" && (v as Record<string, unknown>).opted_in === true
}

// ── per-tenant collection (pinned; refusals recorded, never zeros) ──────────────────────────
const ROW_LIMIT = 10000

/** Read ONE tenant's aggregates for every metric. `tenant` on each contribution is this brokerageId (memory only). */
async function collectTenantContributions(svc: Svc, brokerageId: string, opts: { sinceIso: string; marketBand: string }): Promise<{ contributions: TenantContribution[]; errors: string[] }> {
  const out: TenantContribution[] = []
  const errors: string[] = []
  const add = (metric: NetworkBenchmarkMetric, segment: Segment, numerator: number, denominator: number, events: number, meanSum?: number, meanCount?: number) => {
    if (events > 0) out.push({ tenant: brokerageId, metric, segment, numerator, denominator, events, meanSum, meanCount })
  }
  const band = opts.marketBand

  // 1 + 2. Brokerage conversion and seller-campaign conversion by market band.
  const leads = await svc.from("leads").select("id, lead_type, converted_at, campaign_attribution_id, utm_campaign").eq("brokerage_id", brokerageId).gte("created_at", opts.sinceIso).limit(ROW_LIMIT)
  if (leads.error) errors.push(`leads: ${leads.error.message}`)
  else {
    const rows = (leads.data ?? []) as Array<{ lead_type: string | null; converted_at: string | null; campaign_attribution_id: string | null; utm_campaign: string | null }>
    add("brokerage_conversion", { market_band: band }, rows.filter((r) => r.converted_at).length, rows.length, rows.length)
    const seller = rows.filter((r) => r.lead_type === "seller" && (r.campaign_attribution_id || r.utm_campaign))
    add("seller_campaign_conversion", { market_band: band }, seller.filter((r) => r.converted_at).length, seller.length, seller.length)
  }

  // 3. Provider fabric reliability (success rate) + latency (mean ms to settle).
  const prov = await svc.from("agent_action_ledger").select("provider, status, created_at, settled_at").eq("brokerage_id", brokerageId).gte("created_at", opts.sinceIso).not("provider", "is", null).in("status", ["executed", "failed"]).limit(ROW_LIMIT)
  if (prov.error) errors.push(`agent_action_ledger: ${prov.error.message}`)
  else {
    const by = new Map<string, { ok: number; n: number; ms: number; mc: number }>()
    for (const r of (prov.data ?? []) as Array<{ provider: string; status: string; created_at: string; settled_at: string | null }>) {
      const k = String(r.provider).toLowerCase()
      const b = by.get(k) ?? { ok: 0, n: 0, ms: 0, mc: 0 }
      b.n++; if (r.status === "executed") b.ok++
      const lat = r.settled_at ? Date.parse(r.settled_at) - Date.parse(r.created_at) : NaN
      if (Number.isFinite(lat) && lat >= 0) { b.ms += lat; b.mc++ }
      by.set(k, b)
    }
    for (const [provider, b] of by) add("provider_reliability", { provider }, b.ok, b.n, b.n, b.ms, b.mc)
  }

  // 4. Channel response (reply rate per channel).
  const outreach = await svc.from("isa_outreach_log").select("channel, sent_at, replied_at").eq("brokerage_id", brokerageId).gte("sent_at", opts.sinceIso).limit(ROW_LIMIT)
  if (outreach.error) errors.push(`isa_outreach_log: ${outreach.error.message}`)
  else {
    const by = new Map<string, { r: number; n: number }>()
    for (const o of (outreach.data ?? []) as Array<{ channel: string | null; replied_at: string | null }>) {
      if (!o.channel) continue
      const b = by.get(o.channel) ?? { r: 0, n: 0 }
      b.n++; if (o.replied_at) b.r++
      by.set(o.channel, b)
    }
    for (const [channel, b] of by) add("channel_response", { channel }, b.r, b.n, b.n)
  }

  // 5. Content performance (106C marketing_assets.performance — leads per impression by asset type).
  const assets = await svc.from("marketing_assets").select("asset_type, performance").eq("brokerage_id", brokerageId).not("performance", "is", null).limit(ROW_LIMIT)
  if (assets.error) errors.push(`marketing_assets: ${assets.error.message}`)
  else {
    const by = new Map<string, { leads: number; imp: number }>()
    for (const a of (assets.data ?? []) as Array<{ asset_type: string | null; performance: Record<string, unknown> | null }>) {
      const p = a.performance ?? {}
      const updated = typeof p.updated_at === "string" ? p.updated_at : null
      if (!a.asset_type || (updated && updated < opts.sinceIso)) continue
      const b = by.get(a.asset_type) ?? { leads: 0, imp: 0 }
      b.leads += Math.max(0, Number(p.leads ?? 0) || 0); b.imp += Math.max(0, Number(p.impressions ?? 0) || 0)
      by.set(a.asset_type, b)
    }
    for (const [content_kind, b] of by) add("content_performance", { content_kind }, b.leads, b.imp, b.imp)
  }

  // 6. Education effectiveness (106D) — completion rate + mean quiz score per COMPETENCY (never a module id).
  const asg = await svc.from("learning_assignments").select("module_id, status, completed_at, quiz_score").eq("brokerage_id", brokerageId).gte("created_at", opts.sinceIso).limit(ROW_LIMIT)
  if (asg.error) errors.push(`learning_assignments: ${asg.error.message}`)
  else {
    const rows = (asg.data ?? []) as Array<{ module_id: string | null; completed_at: string | null; quiz_score: number | null }>
    const moduleIds = [...new Set(rows.map((r) => r.module_id).filter((x): x is string => !!x))]
    const tags = new Map<string, string[]>()
    for (let i = 0; i < moduleIds.length; i += 200) {
      const m = await svc.from("learning_modules").select("id, gap_tags").in("id", moduleIds.slice(i, i + 200))
      if (m.error) { errors.push(`learning_modules: ${m.error.message}`); break }
      for (const r of (m.data ?? []) as Array<{ id: string; gap_tags: string[] | null }>) tags.set(r.id, (r.gap_tags ?? []).filter((t) => (COMPETENCY_SKILLS as readonly string[]).includes(t)))
    }
    const by = new Map<string, { done: number; n: number; qs: number; qc: number }>()
    for (const r of rows) for (const competency of tags.get(r.module_id ?? "") ?? []) {
      const b = by.get(competency) ?? { done: 0, n: 0, qs: 0, qc: 0 }
      b.n++; if (r.completed_at) b.done++
      if (r.quiz_score !== null && r.quiz_score !== undefined && Number.isFinite(Number(r.quiz_score))) { b.qs += Number(r.quiz_score); b.qc++ }
      by.set(competency, b)
    }
    for (const [competency, b] of by) add("education_effectiveness", { competency }, b.done, b.n, b.n, b.qs, b.qc)
  }

  // 7. Strategy conversion (107F strategy learning, tenant scope).
  const { tenantStrategyStats } = await import("@/lib/intelligence/strategy-learning")
  const st = await tenantStrategyStats(svc, brokerageId, { sinceIso: opts.sinceIso })
  if (!st.ok) errors.push(`strategy: ${st.error}`)
  else for (const s of st.stats) add("strategy_conversion", { strategy_key: s.ref }, s.conversions, s.exposures, s.exposures)

  return { contributions: out, errors }
}

export interface AggregationRun {
  periodEnd: string
  brokerages: number
  contributing: number
  optedOut: number
  cells: number
  written: number
  suppressed: PublishReport["suppressed"]
  errors: string[]
}

/**
 * THE PLATFORM CRON'S JOB (app/api/cron/network-intelligence/route.ts) — the ONLY writer of network_benchmarks.
 * Reads each OPTED-IN tenant through the service client (pinned per tenant), publishes the k-anonymous cells
 * for the period and upserts them on (period_end, cell_key), counting what came back (CLAUDE.md §3).
 */
export async function runNetworkBenchmarkAggregation(svc: Svc, opts: { now?: Date; policy?: Partial<BenchmarkPolicy> } = {}): Promise<AggregationRun> {
  const policy = effectivePolicy(opts.policy)
  const now = opts.now ?? new Date()
  const periodEnd = now.toISOString().slice(0, 10)
  const since = new Date(now.getTime() - policy.windowDays * 86_400_000)
  const run: AggregationRun = { periodEnd, brokerages: 0, contributing: 0, optedOut: 0, cells: 0, written: 0, suppressed: { belowTenants: 0, belowEvents: 0, dominance: 0, unsafeSegment: 0 }, errors: [] }
  const { data, error } = await svc.from("brokerages").select("id, state").is("deleted_at", null).limit(1000)
  if (error) { run.errors.push(`brokerages: ${error.message}`); return run }
  const contribs: TenantContribution[] = []
  for (const b of (data ?? []) as Array<{ id: string; state: string | null }>) {
    run.brokerages++
    if (!(await readNetworkOptIn(svc, b.id))) { run.optedOut++; continue }
    const c = await collectTenantContributions(svc, b.id, { sinceIso: since.toISOString(), marketBand: marketBandForState(b.state) })
    run.contributing++
    contribs.push(...c.contributions)
    // A refusal names the TABLE, never the tenant (the cron log is platform staff-only, still: no id).
    run.errors.push(...c.errors.map((e) => `contributor read refused: ${e.split(":")[0]}`))
  }
  const pub = publishBenchmarkCells(contribs, { start: since.toISOString().slice(0, 10), end: periodEnd }, policy)
  run.cells = pub.cells.length
  run.suppressed = pub.suppressed
  for (let i = 0; i < pub.cells.length; i += 200) {
    const { data: up, error: upErr } = await svc.from("network_benchmarks").upsert(pub.cells.slice(i, i + 200), { onConflict: "period_end,cell_key" }).select("id")
    if (upErr) { run.errors.push(`network_benchmarks: ${upErr.message}`); break }
    run.written += (up ?? []).length
  }
  return run
}

export type NetworkCellRow = Pick<PublishedCell, "metric" | "market_band" | "strategy_key" | "channel" | "provider" | "content_kind" | "competency" | "cell_key" | "rate" | "sample_size" | "mean" | "tenant_count" | "period_end">

/** Every tenant may read the published cells (the latest period). No tenant column exists to leak. */
export async function readNetworkBenchmarks(svc: Svc, filter: { metric?: NetworkBenchmarkMetric } = {}): Promise<{ ok: true; cells: NetworkCellRow[]; periodEnd: string | null } | { ok: false; error: string }> {
  const latest = await svc.from("network_benchmarks").select("period_end").order("period_end", { ascending: false }).limit(1)
  if (latest.error) return { ok: false, error: `network_benchmarks: ${latest.error.message}` }
  const periodEnd = ((latest.data ?? [])[0] as { period_end?: string } | undefined)?.period_end ?? null
  if (!periodEnd) return { ok: true, cells: [], periodEnd: null }
  let q = svc.from("network_benchmarks").select("metric, market_band, strategy_key, channel, provider, content_kind, competency, cell_key, rate, sample_size, mean, tenant_count, period_end").eq("period_end", periodEnd)
  if (filter.metric) q = q.eq("metric", filter.metric)
  const r = await q.limit(2000)
  if (r.error) return { ok: false, error: `network_benchmarks: ${r.error.message}` }
  return { ok: true, cells: (r.data ?? []) as NetworkCellRow[], periodEnd }
}

export interface BenchmarkBesideRow {
  metric: NetworkBenchmarkMetric
  segment: string
  own: { rate: number | null; sample: number; mean: number | null } | null
  network: { rate: number | null; sampleSize: number; mean: number | null; tenantCount: number } | null
}

/**
 * THE TENANT'S VIEW — its OWN numbers (read live, pinned to its session brokerageId) beside the network cell of
 * the same metric × segment. Cells of another market band are not shown; nothing names another brokerage.
 */
export async function benchmarksBeside(svc: Svc, brokerageId: string, opts: { now?: Date } = {}): Promise<{ ok: true; rows: BenchmarkBesideRow[]; periodEnd: string | null; marketBand: string; ownErrors: string[] } | { ok: false; error: string }> {
  const b = await svc.from("brokerages").select("state").eq("id", brokerageId).maybeSingle()
  if (b.error) return { ok: false, error: `brokerages: ${b.error.message}` }
  const marketBand = marketBandForState(b.data?.state)
  const since = new Date((opts.now ?? new Date()).getTime() - NETWORK_BENCHMARK_POLICY.windowDays * 86_400_000).toISOString()
  const [own, net] = await Promise.all([collectTenantContributions(svc, brokerageId, { sinceIso: since, marketBand }), readNetworkBenchmarks(svc)])
  if (!net.ok) return net
  const ownCells = new Map<string, TenantContribution>()
  for (const c of own.contributions) ownCells.set(`${c.metric}|${SEGMENT_DIMS.map((d) => c.segment[d] ?? "*").join("|")}`, c)
  const keys = new Set<string>([...ownCells.keys(), ...net.cells.filter((c) => !c.market_band || c.market_band === marketBand).map((c) => c.cell_key)])
  const rows: BenchmarkBesideRow[] = [...keys].sort().map((k) => {
    const o = ownCells.get(k)
    const n = net.cells.find((c) => c.cell_key === k)
    const metric = (o?.metric ?? n?.metric) as NetworkBenchmarkMetric
    return {
      metric, segment: k.split("|").slice(1).filter((x) => x !== "*").join(" · ") || "all",
      own: o ? { rate: o.denominator > 0 ? +(o.numerator / o.denominator).toFixed(4) : null, sample: o.denominator, mean: o.meanCount ? +((o.meanSum ?? 0) / o.meanCount).toFixed(2) : null } : null,
      network: n ? { rate: n.rate, sampleSize: n.sample_size, mean: n.mean, tenantCount: n.tenant_count } : null,
    }
  })
  return { ok: true, rows, periodEnd: net.periodEnd, marketBand, ownErrors: own.errors }
}
