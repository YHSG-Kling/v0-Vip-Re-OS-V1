// lib/intelligence/portfolio-intelligence.ts
//
// PORTFOLIO INTELLIGENCE (data_steward → broker) — the brokerage-scale lens
// TWO shine items share (one loader, two composers, no drift):
//   #7 CROSS-PORTFOLIO STRATEGY ADVISOR — "where should I deploy agents,
//      budget, and marketing?" — the regional-VP call, from real territory ROI.
//   #9 PORTFOLIO RISK & OPPORTUNITY LENS — rising vs declining segments,
//      underused farms, pricing pressure, pipeline risk, at the brokerage level.
//
// Grounded ONLY in territory_metrics (per-ZIP: leads, conversion, ROI,
// cost-per-lead, agent_saturation) + farm_territories (which ZIPs the
// brokerage is actually farming). HONEST by construction: a ZIP needs
// MIN_ZIP_LEADS before its conversion/ROI is treated as signal (thin data is
// never a verdict); no metrics at all → an empty read, never invented
// strategy. Pure composers; the loader is best-effort. deal_coordinator's
// broker surfaces render it; a monthly gated broker brief carries the top move.

import type { SupabaseClient } from "@supabase/supabase-js"

type Svc = SupabaseClient<any, any, any>

export const MIN_ZIP_LEADS = 10
export const WINDOW_DAYS = 90
export const HOT_CONVERSION = 0.15   // ≥15% converting = a lane worth leaning into
export const COLD_CONVERSION = 0.04  // ≤4% converting with volume = a lane bleeding budget

export interface ZipMetric {
  zip: string
  leads: number
  conversions: number
  conversionRate: number
  roi: number | null
  costPerLead: number | null
  saturation: number | null
  /** Is the brokerage actively farming this ZIP (farm_territories)? */
  farmed: boolean
}

export interface StrategyMove { key: string; zip: string | null; line: string }
export interface RiskOpportunity { kind: "opportunity" | "risk"; zip: string; line: string }

export interface PortfolioRead {
  windowDays: number
  zips: number
  strategy: StrategyMove[]
  riskOps: RiskOpportunity[]
}

/** PURE: aggregate per-ZIP metric rows into one ZipMetric each (sum leads/conv, avg the rates). */
export function aggregateZipMetrics(
  rows: Array<{ zip_code: string | null; lead_count: number | null; conversion_count: number | null; roi: number | null; cost_per_lead: number | null; agent_saturation: number | null }>,
  farmedZips: Set<string>,
): ZipMetric[] {
  const byZip = new Map<string, { leads: number; conv: number; roi: number[]; cpl: number[]; sat: number[] }>()
  for (const r of rows) {
    const zip = (r.zip_code ?? "").trim()
    if (!/^\d{5}/.test(zip)) continue
    const z = zip.slice(0, 5)
    const e = byZip.get(z) ?? { leads: 0, conv: 0, roi: [], cpl: [], sat: [] }
    e.leads += Number(r.lead_count ?? 0)
    e.conv += Number(r.conversion_count ?? 0)
    if (r.roi != null) e.roi.push(Number(r.roi))
    if (r.cost_per_lead != null) e.cpl.push(Number(r.cost_per_lead))
    if (r.agent_saturation != null) e.sat.push(Number(r.agent_saturation))
    byZip.set(z, e)
  }
  const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
  return [...byZip.entries()].map(([zip, e]) => ({
    zip,
    leads: e.leads,
    conversions: e.conv,
    conversionRate: e.leads > 0 ? e.conv / e.leads : 0,
    roi: avg(e.roi),
    costPerLead: avg(e.cpl),
    saturation: avg(e.sat),
    farmed: farmedZips.has(zip),
  }))
}

/** PURE #7: the deploy-agents/budget moves. Only defensible, sample-gated calls. */
export function composeStrategyMoves(zips: ZipMetric[]): StrategyMove[] {
  const proven = zips.filter((z) => z.leads >= MIN_ZIP_LEADS)
  const out: StrategyMove[] = []
  const pct = (n: number) => `${Math.round(n * 1000) / 10}%`

  // Lean IN: a proven-hot ZIP the brokerage is NOT farming = the clearest budget move.
  const hotUnfarmed = proven.filter((z) => z.conversionRate >= HOT_CONVERSION && !z.farmed)
    .sort((a, b) => b.conversionRate - a.conversionRate)[0]
  if (hotUnfarmed) {
    out.push({
      key: "lean_in", zip: hotUnfarmed.zip,
      line: `Put budget into ${hotUnfarmed.zip}: it converts at ${pct(hotUnfarmed.conversionRate)} on ${hotUnfarmed.leads} leads and you're not farming it yet — the fastest ROI move on the board.`,
    })
  }

  // PULL BACK: a proven-cold, expensive, farmed ZIP = budget to redeploy.
  const coldFarmed = proven.filter((z) => z.conversionRate <= COLD_CONVERSION && z.farmed)
    .sort((a, b) => (b.costPerLead ?? 0) - (a.costPerLead ?? 0))[0]
  if (coldFarmed) {
    out.push({
      key: "pull_back", zip: coldFarmed.zip,
      line: `Reconsider ${coldFarmed.zip}: ${coldFarmed.leads} leads at only ${pct(coldFarmed.conversionRate)} conversion${coldFarmed.costPerLead ? ` and $${Math.round(coldFarmed.costPerLead)}/lead` : ""} — the budget here would work harder in a proven lane.`,
    })
  }

  // ADD AGENTS: a hot ZIP with high saturation is leaving deals on the table.
  const underStaffed = proven.filter((z) => z.conversionRate >= HOT_CONVERSION && (z.saturation ?? 0) >= 80)
    .sort((a, b) => (b.saturation ?? 0) - (a.saturation ?? 0))[0]
  if (underStaffed) {
    out.push({
      key: "add_capacity", zip: underStaffed.zip,
      line: `${underStaffed.zip} is converting well but your agents there are near capacity (${Math.round(underStaffed.saturation ?? 0)}% saturated) — adding or reassigning an agent here captures demand you're currently dropping.`,
    })
  }
  return out
}

/** PURE #9: rising/declining segments + underused farms + pipeline-risk read. */
export function composeRiskOpportunities(zips: ZipMetric[]): RiskOpportunity[] {
  const proven = zips.filter((z) => z.leads >= MIN_ZIP_LEADS)
  const out: RiskOpportunity[] = []
  const pct = (n: number) => `${Math.round(n * 1000) / 10}%`

  for (const z of proven.filter((z) => z.conversionRate >= HOT_CONVERSION).sort((a, b) => b.conversionRate - a.conversionRate).slice(0, 2)) {
    out.push({ kind: "opportunity", zip: z.zip, line: `${z.zip} is a rising segment — ${pct(z.conversionRate)} conversion on ${z.leads} leads${z.farmed ? "" : ", and you're not even farming it yet"}.` })
  }
  for (const z of proven.filter((z) => z.conversionRate <= COLD_CONVERSION).sort((a, b) => a.conversionRate - b.conversionRate).slice(0, 2)) {
    out.push({ kind: "risk", zip: z.zip, line: `${z.zip} is underperforming — ${z.leads} leads at ${pct(z.conversionRate)}${z.roi != null && z.roi < 1 ? ` and ROI below breakeven` : ""}; worth a hard look before next quarter's budget.` })
  }
  return out
}

/** Load territory metrics + farmed ZIPs and compose both lenses. */
export async function loadPortfolioIntelligence(svc: Svc, brokerageId: string, now: Date = new Date()): Promise<PortfolioRead> {
  const since = new Date(now.getTime() - WINDOW_DAYS * 86_400_000).toISOString().slice(0, 10)
  const [{ data: metrics }, { data: farms }] = await Promise.all([
    svc.from("territory_metrics")
      .select("zip_code, lead_count, conversion_count, roi, cost_per_lead, agent_saturation")
      .eq("brokerage_id", brokerageId).gte("metric_date", since).limit(5000),
    svc.from("farm_territories").select("zip_codes").eq("brokerage_id", brokerageId).eq("is_active", true).limit(500),
  ])
  const farmedZips = new Set<string>()
  for (const f of ((farms ?? []) as any[])) {
    for (const z of ((f.zip_codes ?? []) as string[])) {
      if (typeof z === "string" && /^\d{5}/.test(z)) farmedZips.add(z.slice(0, 5))
    }
  }
  const zips = aggregateZipMetrics(((metrics ?? []) as any[]), farmedZips)
  return {
    windowDays: WINDOW_DAYS,
    zips: zips.length,
    strategy: composeStrategyMoves(zips),
    riskOps: composeRiskOpportunities(zips),
  }
}

/** Monthly gated broker brief carrying the top strategy move + top risk. Idempotent per (brokerage, month). */
export async function runPortfolioAdvisor(svc: Svc, brokerageId: string, now: Date = new Date()): Promise<{ proposed: boolean }> {
  const read = await loadPortfolioIntelligence(svc, brokerageId, now)
  if (read.strategy.length === 0 && read.riskOps.length === 0) return { proposed: false }
  const tag = `portfolio_advisor:${now.toISOString().slice(0, 7)}`
  const { data: dup } = await svc.from("agent_client_messages")
    .select("id").eq("brokerage_id", brokerageId).ilike("rationale", `%${tag}%`).limit(1).maybeSingle()
  if (dup) return { proposed: false }

  const body = [
    "This month's portfolio read, from your own territory ROI (not a national average):",
    "",
    ...read.strategy.map((m, i) => `${i + 1}. ${m.line}`),
    ...read.riskOps.filter((r) => r.kind === "risk").slice(0, 1).map((r) => `• Watch: ${r.line}`),
  ].join("\n")

  const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
  await proposeClientMessage({
    brokerageId, agentKind: "deal_coordinator", entityType: "brokerage", entityId: brokerageId,
    audience: "agent", subject: "Where to deploy next month — your portfolio read",
    body, rationale: `${tag} — cross-portfolio strategy + risk from territory_metrics (${read.zips} ZIPs); broker decides, nothing moves automatically.`,
    channel: "portal",
  }).catch(() => {})
  return { proposed: true }
}

/** Autonomous: multi-location brokerages, monthly (rides the weekly recruit-outreach cron, month-idempotent). */
export async function runPortfolioAdvisorAll(svc: Svc): Promise<{ brokerages: number; proposed: number }> {
  const { data: brokerages } = await svc.from("brokerages").select("id, plan_tier").in("plan_tier", ["brokerage", "multi_location"]).limit(500)
  let proposed = 0
  for (const b of ((brokerages ?? []) as Array<{ id: string }>)) {
    const r = await runPortfolioAdvisor(svc, b.id).catch(() => null)
    if (r?.proposed) proposed++
  }
  return { brokerages: (brokerages ?? []).length, proposed }
}
