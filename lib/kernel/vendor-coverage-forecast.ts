// lib/kernel/vendor-coverage-forecast.ts
//
// VENDOR COVERAGE FORECAST + GAP RADAR (deal_coordinator) — the FORWARD-LOOKING half of the vendor bench.
// The orchestration cron reacts to a stage that needs a vendor NOW; the no-show autopilot reacts to a
// ghosted booking. This looks AHEAD: it reads the live pipeline, forecasts which vendor categories the
// deals moving through it will need over the next couple of weeks, and checks whether the bench can
// actually cover that demand with RELIABLE vendors (not proven SLA-breachers). When a category has real
// upcoming demand but zero reliable vendors — a COVERAGE GAP — it proposes a gated broker brief to shore
// up the bench BEFORE a deal stalls waiting on a vendor that doesn't exist. Pure forecast + assessment;
// honest (a category with no demand is never a gap; a vendor with too little history is presumed reliable,
// never fabricated into a breacher).

import { createServiceClient } from "@/lib/supabase/service"
import { computeVendorSla, slaTier } from "@/lib/kernel/vendor-sla"
import type { BenchVendorCategory } from "@/lib/kernel/vendor-categories"

type Svc = ReturnType<typeof createServiceClient>

/** A vendor needs at least this many rated bookings before a low SLA counts against coverage (honest on
 *  thin data — an unproven vendor is presumed reliable, not a breacher). */
export const COVERAGE_MIN_SAMPLE = 3

export type VendorCategory = BenchVendorCategory

/** Which vendor categories each live pipeline stage implies over the near term. Aligned with the
 *  orchestration stage→gap logic, but forward-looking (ALL categories the stage will need, not just the
 *  first uncovered one). Stager is settings-gated elsewhere and deliberately omitted from the forecast. */
export const STAGE_VENDOR_NEEDS: Record<string, VendorCategory[]> = {
  UNDER_CONTRACT: ["inspector"],
  INSPECTION: ["inspector", "contractor"],
  APPRAISAL: ["lender"],
  FINANCING_PENDING: ["lender"],
  CLOSING_PREP: ["title"],
}

/** PURE: forecast upcoming vendor demand per category from the deals in the pipeline. */
export function forecastVendorDemand(deals: Array<{ stage: string | null }>): Map<VendorCategory, number> {
  const demand = new Map<VendorCategory, number>()
  for (const d of deals) {
    const needs = STAGE_VENDOR_NEEDS[(d.stage ?? "").toUpperCase()] ?? []
    for (const cat of needs) demand.set(cat, (demand.get(cat) ?? 0) + 1)
  }
  return demand
}

export type CoverageStatus = "covered" | "thin" | "gap"

export interface CoverageAssessment {
  category: VendorCategory
  demand: number
  reliableVendors: number
  status: CoverageStatus
}

/**
 * PURE: assess coverage per category. A category with upcoming demand and ZERO reliable vendors is a GAP;
 * exactly one reliable vendor is THIN (single point of failure); otherwise COVERED. Categories with no
 * demand are omitted (never a gap).
 */
export function assessCoverage(
  demand: Map<VendorCategory, number>, reliableByCategory: Map<VendorCategory, number>,
): CoverageAssessment[] {
  const out: CoverageAssessment[] = []
  for (const [category, dmd] of demand) {
    if (dmd <= 0) continue
    const reliable = reliableByCategory.get(category) ?? 0
    const status: CoverageStatus = reliable === 0 ? "gap" : reliable === 1 ? "thin" : "covered"
    out.push({ category, demand: dmd, reliableVendors: reliable, status })
  }
  // Gaps first, then thin, then by demand desc.
  const rank: Record<CoverageStatus, number> = { gap: 0, thin: 1, covered: 2 }
  return out.sort((a, b) => rank[a.status] - rank[b.status] || b.demand - a.demand)
}

/** The active (non-terminal) pipeline stages we forecast over. */
const FORECAST_STAGES = Object.keys(STAGE_VENDOR_NEEDS)

export interface CoverageForecastResult { deals: number; gaps: number; thin: number; briefProposed: boolean }

/** Forecast a brokerage's vendor coverage and propose a gated brief on any gaps. Best-effort. */
export async function runVendorCoverageForecast(svc: Svc, params: { brokerageId: string; now?: Date }): Promise<CoverageForecastResult> {
  const out: CoverageForecastResult = { deals: 0, gaps: 0, thin: 0, briefProposed: false }
  const now = params.now ?? new Date()

  const { data: deals } = await svc.from("transactions")
    .select("id, stage").eq("brokerage_id", params.brokerageId).in("stage", FORECAST_STAGES).limit(5000)
  const pipeline = (deals ?? []) as Array<{ stage: string | null }>
  out.deals = pipeline.length
  const demand = forecastVendorDemand(pipeline)
  if (demand.size === 0) return out

  // Bench reliability: for each category, count vendors that are NOT proven SLA-breachers.
  const { data: vendors } = await svc.from("vendors").select("id, category").eq("brokerage_id", params.brokerageId).eq("status", "active").limit(2000)
  const reliableByCategory = new Map<VendorCategory, number>()
  for (const v of (vendors ?? []) as Array<{ id: string; category: string | null }>) {
    const cat = v.category as VendorCategory
    if (!cat) continue
    const { data: bookings } = await svc.from("vendor_bookings").select("status, scheduled_date, completed_at").eq("vendor_id", v.id).limit(500)
    const rows = ((bookings ?? []) as any[]).map((b) => ({ vendor_id: v.id, status: b.status, scheduled_date: b.scheduled_date, completed_at: b.completed_at }))
    const sla = computeVendorSla(rows, {})[v.id]
    // Presumed reliable unless there's ENOUGH history to prove a breach (honest on thin data).
    const reliable = !sla || sla.total < COVERAGE_MIN_SAMPLE || slaTier(sla.slaPct) !== "breach"
    if (reliable) reliableByCategory.set(cat, (reliableByCategory.get(cat) ?? 0) + 1)
  }

  const assessment = assessCoverage(demand, reliableByCategory)
  const gaps = assessment.filter((a) => a.status === "gap")
  const thin = assessment.filter((a) => a.status === "thin")
  out.gaps = gaps.length
  out.thin = thin.length
  if (gaps.length === 0) return out

  // ONE gated weekly brief on the coverage gaps (deduped per brokerage + ISO week).
  const { isoWeekKey } = await import("@/lib/recruiting/switch-propensity-scout")
  const dedupeTag = `VENDOR COVERAGE GAP — ${isoWeekKey(now)}`
  const { data: prior } = await svc.from("agent_client_messages").select("id")
    .eq("brokerage_id", params.brokerageId).eq("entity_type", "brokerage").eq("entity_id", params.brokerageId)
    .eq("agent_kind", "deal_coordinator").ilike("rationale", `${dedupeTag}%`).limit(1).maybeSingle()
  if (prior) return out

  const lines = [
    `Your vendor bench won't cover what's coming. Deals moving through the pipeline will need these categories, and you have no reliable vendor on the bench for them:`,
    ...gaps.map((g) => `• ${g.category} — ${g.demand} deal${g.demand === 1 ? "" : "s"} approaching, 0 reliable vendors.`),
    ...(thin.length ? [`Also thin (a single point of failure): ${thin.map((t) => `${t.category} (${t.demand} coming, 1 vendor)`).join("; ")}.`] : []),
    `Recruit or assign coverage now — before a deal stalls waiting on a vendor you don't have.`,
  ]
  try {
    const { proposeClientMessage } = await import("@/lib/agents/agent-client-messages")
    const res = await proposeClientMessage({
      brokerageId: params.brokerageId, agentKind: "deal_coordinator", entityType: "brokerage", entityId: params.brokerageId,
      recipientContactId: null, audience: "agent",
      subject: `Vendor coverage gap: ${gaps.map((g) => g.category).join(", ")}`,
      body: lines.join("\n\n"),
      rationale: `${dedupeTag} — ${gaps.length} gap(s); review before it reaches the broker.`,
      channel: "portal",
    }, svc)
    out.briefProposed = res.ok
  } catch { /* best-effort */ }
  return out
}

/** Autonomous: forecast coverage for every brokerage (rides the daily vendor-orchestration cron). */
export async function runVendorCoverageForecastAll(svc: Svc, now?: Date): Promise<{ brokerages: number; gaps: number; briefs: number }> {
  const out = { brokerages: 0, gaps: 0, briefs: 0 }
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try { const r = await runVendorCoverageForecast(svc, { brokerageId: b.id, now }); out.gaps += r.gaps; if (r.briefProposed) out.briefs++ } catch { /* keep going */ }
  }
  return out
}
