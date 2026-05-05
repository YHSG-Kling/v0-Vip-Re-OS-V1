"use server"

/**
 * app/actions/revenue-pipeline.ts
 *
 * Revenue pipeline projection — 30 / 60 / 90 day GCI forecast for the
 * brokerage (and per agent), weighted by deal stage probability and
 * estimated close date. Used on the broker dashboard.
 *
 * Inputs are the existing `transactions` rows + agent commission split
 * configuration. No new tables — this is a derived view on top of data
 * the brokerage already maintains.
 */

import { createClient } from "@/lib/supabase/server"
import { requireAuth } from "@/lib/kernel/api-auth"

/**
 * Stage → probability of close. Tuned to typical residential US flow;
 * the broker dashboard exposes these as overridable in a follow-up.
 */
const STAGE_PROBABILITY: Record<string, number> = {
  // Pre-contract
  lead: 0.05,
  prospect: 0.08,
  consultation_scheduled: 0.12,
  consultation_completed: 0.18,

  // Listing-side pre-MLS
  listing_appointment_set: 0.25,
  listing_appointment_completed: 0.35,
  listing_agreement_signed: 0.55,
  coming_soon: 0.65,
  active: 0.55,

  // Buyer-side pre-offer
  search_configured: 0.20,
  searching: 0.25,
  tour_eligible: 0.30,
  touring: 0.40,
  offer_eligible: 0.55,
  offer_submitted: 0.55,

  // Under-contract path
  pending: 0.85,
  under_contract: 0.85,
  inspection: 0.85,
  appraisal: 0.88,
  financing: 0.90,
  clear_to_close: 0.97,
  closing_prep: 0.97,

  // Terminal
  closed: 1.00,
  cancelled: 0.0,
  withdrawn: 0.0,
  expired: 0.0,
  failed: 0.0,
}

interface ProjectionWindow {
  windowDays: 30 | 60 | 90
  weightedGci: number
  rawGci: number
  dealCount: number
  byStage: Array<{ stage: string; count: number; weightedGci: number }>
}

export interface RevenuePipelineProjection {
  asOf: string
  brokerageId: string
  windows: ProjectionWindow[]
  perAgent: Array<{
    agentId: string
    agentName: string
    weighted30: number
    weighted60: number
    weighted90: number
    pendingCount: number
    activeListingCount: number
    activeBuyerCount: number
  }>
}

function toMid(stage: string | null): number {
  if (!stage) return 0
  return STAGE_PROBABILITY[stage] ?? 0
}

export async function getRevenuePipelineProjectionAction(input?: {
  agentId?: string // optionally scope to one agent
}): Promise<{ success: true; projection: RevenuePipelineProjection } | { success: false; error: string }> {
  const supabase = await createClient()
  const auth = await requireAuth(supabase)
  if (!auth.ok) return { success: false, error: "unauthenticated" }

  const now = new Date()
  const horizon = new Date(now.getTime() + 95 * 86_400_000)

  // transactions live schema: uses `stage` (not lifecycle_stage),
  // `commission_amount` (the negotiated GCI on the deal),
  // `estimated_commission` (the forecast at intake), and
  // `commission_percentage` (the rate).
  let q = supabase
    .from("transactions")
    .select(
      `id, agent_id, stage, status, close_date, contract_date,
       purchase_price, commission_amount, estimated_commission, commission_percentage,
       agent:agent_id (id, first_name, last_name)`,
    )
    .eq("brokerage_id", auth.brokerageId)
    .not("status", "in", "(closed,cancelled,failed,withdrawn,expired)")

  if (input?.agentId) q = q.eq("agent_id", input.agentId)

  const { data: transactions, error } = await q
  if (error) return { success: false, error: error.message }

  const windows: Record<30 | 60 | 90, ProjectionWindow> = {
    30: { windowDays: 30, weightedGci: 0, rawGci: 0, dealCount: 0, byStage: [] },
    60: { windowDays: 60, weightedGci: 0, rawGci: 0, dealCount: 0, byStage: [] },
    90: { windowDays: 90, weightedGci: 0, rawGci: 0, dealCount: 0, byStage: [] },
  }

  const stageBuckets: Record<30 | 60 | 90, Map<string, { count: number; weightedGci: number }>> = {
    30: new Map(),
    60: new Map(),
    90: new Map(),
  }

  const perAgent = new Map<string, RevenuePipelineProjection["perAgent"][number]>()

  for (const txn of transactions ?? []) {
    const stage = (txn.stage as string | null) ?? (txn.status as string | null)
    const probability = toMid(stage)
    if (probability === 0) continue

    // Estimated close date: contract close_date if set, else fall back to a
    // stage-default lookahead (active listing → 60d, under contract → 35d).
    let estClose: Date | null = null
    if (txn.close_date) estClose = new Date(txn.close_date as string)
    else if (stage && /under_contract|pending|inspection|appraisal|financing|clear_to_close|closing_prep/.test(stage))
      estClose = new Date(now.getTime() + 35 * 86_400_000)
    else if (stage === "active" || stage === "coming_soon")
      estClose = new Date(now.getTime() + 60 * 86_400_000)
    else estClose = new Date(now.getTime() + 90 * 86_400_000)

    const daysToClose = Math.max(0, Math.ceil((estClose.getTime() - now.getTime()) / 86_400_000))
    if (daysToClose > 90 || estClose > horizon) continue

    // GCI estimate priority: negotiated commission_amount → estimated_commission
    // → percentage × price → 2.5% default.
    const pct = txn.commission_percentage != null ? Number(txn.commission_percentage) / 100 : null
    const rawGci = Number(
      txn.commission_amount ??
        txn.estimated_commission ??
        (txn.purchase_price && pct ? Number(txn.purchase_price) * pct : null) ??
        (txn.purchase_price ? Number(txn.purchase_price) * 0.025 : 0),
    )
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

    // per-agent rollup
    const agent = (txn as any).agent as { id: string; first_name: string | null; last_name: string | null } | null
    if (agent?.id) {
      const existing = perAgent.get(agent.id) ?? {
        agentId: agent.id,
        agentName: `${agent.first_name ?? ""} ${agent.last_name ?? ""}`.trim() || "Unknown",
        weighted30: 0,
        weighted60: 0,
        weighted90: 0,
        pendingCount: 0,
        activeListingCount: 0,
        activeBuyerCount: 0,
      }
      if (targetWindows.includes(30)) existing.weighted30 += weighted
      if (targetWindows.includes(60)) existing.weighted60 += weighted
      existing.weighted90 += weighted
      if (stage && /under_contract|pending|inspection|appraisal|financing|clear_to_close/.test(stage))
        existing.pendingCount += 1
      else if (stage === "active" || stage === "coming_soon") existing.activeListingCount += 1
      else if (stage && /searching|touring|offer/.test(stage)) existing.activeBuyerCount += 1
      perAgent.set(agent.id, existing)
    }
  }

  for (const w of [30, 60, 90] as const) {
    windows[w].byStage = Array.from(stageBuckets[w].entries())
      .map(([stage, v]) => ({ stage, ...v }))
      .sort((a, b) => b.weightedGci - a.weightedGci)
    // Round for display
    windows[w].weightedGci = Math.round(windows[w].weightedGci)
    windows[w].rawGci = Math.round(windows[w].rawGci)
    windows[w].byStage.forEach((s) => (s.weightedGci = Math.round(s.weightedGci)))
  }

  return {
    success: true,
    projection: {
      asOf: now.toISOString(),
      brokerageId: auth.brokerageId,
      windows: [windows[30], windows[60], windows[90]],
      perAgent: Array.from(perAgent.values())
        .map((a) => ({
          ...a,
          weighted30: Math.round(a.weighted30),
          weighted60: Math.round(a.weighted60),
          weighted90: Math.round(a.weighted90),
        }))
        .sort((a, b) => b.weighted90 - a.weighted90),
    },
  }
}
