// lib/financials/revenue-projection.ts
// PURE revenue-pipeline math (no DB): probability-weighted 30/60/90-day GCI forecast
// from transaction rows. Extracted from app/actions/revenue-pipeline.ts so the
// weighting/windowing is unit-testable — the action is now a thin DB wrapper around
// projectPipeline(). The action and the simulator compute identical numbers.

/** Stage → probability of close. Tuned to typical residential US flow. */
export const STAGE_PROBABILITY: Record<string, number> = {
  lead: 0.05, prospect: 0.08, consultation_scheduled: 0.12, consultation_completed: 0.18,
  listing_appointment_set: 0.25, listing_appointment_completed: 0.35, listing_agreement_signed: 0.55,
  coming_soon: 0.65, active: 0.55,
  search_configured: 0.20, searching: 0.25, tour_eligible: 0.30, touring: 0.40,
  offer_eligible: 0.55, offer_submitted: 0.55,
  pending: 0.85, under_contract: 0.85, inspection: 0.85, appraisal: 0.88, financing: 0.90,
  clear_to_close: 0.97, closing_prep: 0.97,
  closed: 1.0, cancelled: 0.0, withdrawn: 0.0, expired: 0.0, failed: 0.0,
  // Schema-canonical UPPERCASE aliases (transactions.stage CHECK stores UPPERCASE).
  UNDER_CONTRACT: 0.85, INSPECTION: 0.85, APPRAISAL: 0.88, FINANCING_PENDING: 0.90,
  CLOSING_PREP: 0.97, CLEAR_TO_CLOSE: 0.97, PENDING: 0.85, CLOSED: 1.0, LOST: 0.0,
}

export function stageProbability(stage: string | null): number {
  if (!stage) return 0
  return STAGE_PROBABILITY[stage] ?? STAGE_PROBABILITY[stage.toLowerCase()] ?? STAGE_PROBABILITY[stage.toUpperCase()] ?? 0
}

export interface ProjectionTxnRow {
  agent_id?: string | null
  stage?: string | null
  status?: string | null
  close_date?: string | null
  purchase_price?: number | string | null
  commission_amount?: number | string | null
  estimated_commission?: number | string | null
  commission_percentage?: number | string | null
  agent?: { id: string; first_name: string | null; last_name: string | null } | null
}

export interface ProjectionWindow {
  windowDays: 30 | 60 | 90
  weightedGci: number
  rawGci: number
  dealCount: number
  byStage: Array<{ stage: string; count: number; weightedGci: number }>
}

export interface PerAgentProjection {
  agentId: string
  agentName: string
  weighted30: number
  weighted60: number
  weighted90: number
  pendingCount: number
  activeListingCount: number
  activeBuyerCount: number
}

/** Estimated GCI for a deal, in priority order. */
export function estimateGci(txn: ProjectionTxnRow): number {
  const pct = txn.commission_percentage != null ? Number(txn.commission_percentage) / 100 : null
  return Number(
    txn.commission_amount ??
      txn.estimated_commission ??
      (txn.purchase_price && pct ? Number(txn.purchase_price) * pct : null) ??
      (txn.purchase_price ? Number(txn.purchase_price) * 0.025 : 0),
  )
}

/** PURE: project a set of open transactions into weighted 30/60/90-day GCI windows + per-agent rollup. */
export function projectPipeline(
  rows: ProjectionTxnRow[],
  now: Date = new Date(),
): { windows: ProjectionWindow[]; perAgent: PerAgentProjection[] } {
  const horizon = new Date(now.getTime() + 95 * 86_400_000)
  const windows: Record<30 | 60 | 90, ProjectionWindow> = {
    30: { windowDays: 30, weightedGci: 0, rawGci: 0, dealCount: 0, byStage: [] },
    60: { windowDays: 60, weightedGci: 0, rawGci: 0, dealCount: 0, byStage: [] },
    90: { windowDays: 90, weightedGci: 0, rawGci: 0, dealCount: 0, byStage: [] },
  }
  const stageBuckets: Record<30 | 60 | 90, Map<string, { count: number; weightedGci: number }>> = {
    30: new Map(), 60: new Map(), 90: new Map(),
  }
  const perAgent = new Map<string, PerAgentProjection>()

  for (const txn of rows) {
    const stage = (txn.stage ?? txn.status) ?? null
    const probability = stageProbability(stage)
    if (probability === 0) continue

    let estClose: Date
    if (txn.close_date) estClose = new Date(txn.close_date)
    else if (stage && /under_contract|pending|inspection|appraisal|financing|clear_to_close|closing_prep/i.test(stage))
      estClose = new Date(now.getTime() + 35 * 86_400_000)
    else if (stage === "active" || stage === "coming_soon")
      estClose = new Date(now.getTime() + 60 * 86_400_000)
    else estClose = new Date(now.getTime() + 90 * 86_400_000)

    const daysToClose = Math.max(0, Math.ceil((estClose.getTime() - now.getTime()) / 86_400_000))
    if (daysToClose > 90 || estClose > horizon) continue

    const rawGci = estimateGci(txn)
    if (!rawGci) continue
    const weighted = rawGci * probability
    const targetWindows: Array<30 | 60 | 90> =
      daysToClose <= 30 ? [30, 60, 90] : daysToClose <= 60 ? [60, 90] : [90]

    for (const w of targetWindows) {
      windows[w].weightedGci += weighted
      windows[w].rawGci += rawGci
      windows[w].dealCount += 1
      const key = stage ?? "unknown"
      const bucket = stageBuckets[w].get(key) ?? { count: 0, weightedGci: 0 }
      bucket.count += 1
      bucket.weightedGci += weighted
      stageBuckets[w].set(key, bucket)
    }

    if (txn.agent?.id) {
      const a = txn.agent
      const existing = perAgent.get(a.id) ?? {
        agentId: a.id,
        agentName: `${a.first_name ?? ""} ${a.last_name ?? ""}`.trim() || "Unknown",
        weighted30: 0, weighted60: 0, weighted90: 0,
        pendingCount: 0, activeListingCount: 0, activeBuyerCount: 0,
      }
      if (targetWindows.includes(30)) existing.weighted30 += weighted
      if (targetWindows.includes(60)) existing.weighted60 += weighted
      existing.weighted90 += weighted
      if (stage && /under_contract|pending|inspection|appraisal|financing|clear_to_close/i.test(stage)) existing.pendingCount += 1
      else if (stage === "active" || stage === "coming_soon") existing.activeListingCount += 1
      else if (stage && /searching|touring|offer/i.test(stage)) existing.activeBuyerCount += 1
      perAgent.set(a.id, existing)
    }
  }

  for (const w of [30, 60, 90] as const) {
    windows[w].byStage = Array.from(stageBuckets[w].entries())
      .map(([stage, v]) => ({ stage, ...v }))
      .sort((a, b) => b.weightedGci - a.weightedGci)
      .map((s) => ({ ...s, weightedGci: Math.round(s.weightedGci) }))
    windows[w].weightedGci = Math.round(windows[w].weightedGci)
    windows[w].rawGci = Math.round(windows[w].rawGci)
  }

  return {
    windows: [windows[30], windows[60], windows[90]],
    perAgent: Array.from(perAgent.values())
      .map((a) => ({ ...a, weighted30: Math.round(a.weighted30), weighted60: Math.round(a.weighted60), weighted90: Math.round(a.weighted90) }))
      .sort((a, b) => b.weighted90 - a.weighted90),
  }
}
