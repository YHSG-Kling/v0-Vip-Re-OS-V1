/**
 * Income Forecast — composes the existing revenue-pipeline projection
 * with the Lifetime Customer NPV sphere-referral expected value.
 *
 *   Pipeline (open deals × stage probability) + sphere referral expected
 *   = full per-agent income forecast.
 *
 * Persists a snapshot per agent per run so the dashboard can chart trend.
 */

import "server-only"
import { resolveUserIdToAgentRecord } from "@/lib/kernel/agent-identity-resolver"
import { createServiceClient } from "@/lib/supabase/service"
import { projectAgentSphereReferralValue } from "@/lib/lifetime-customer-npv/scorer"

// Live transactions.stage CHECK constraint allows UPPERCASE values only
// (UNDER_CONTRACT / INSPECTION / APPRAISAL / FINANCING_PENDING /
// CLOSING_PREP / CLOSED / LOST). Earlier versions of this map used
// lowercase keys → returned 0 probability for every real transaction,
// silently zeroing every forecast. Normalize at the lookup site to
// match the schema while staying tolerant of legacy lowercase callers.
const STAGE_PROBABILITY: Record<string, number> = {
  // Schema-canonical UPPERCASE (transactions.stage CHECK)
  UNDER_CONTRACT:    0.70,
  INSPECTION:        0.75,
  APPRAISAL:         0.80,
  FINANCING_PENDING: 0.85,
  CLOSING_PREP:      0.92,
  CLEAR_TO_CLOSE:    0.97,
  PENDING:           0.85,
  CLOSED:            1.00,
  LOST:              0.00,
}

function probabilityForStage(stage: string | null): number {
  if (!stage) return 0
  const key = stage.toUpperCase()
  return STAGE_PROBABILITY[key] ?? 0
}

// ─── Types ────────────────────────────────────────────────────────────────

export interface IncomeForecastSnapshot {
  agentId:                 string
  brokerageId:             string
  computedAt:              string
  weighted30:              number
  weighted60:              number
  weighted90:              number
  raw30:                   number
  raw60:                   number
  raw90:                   number
  sphereReferralExpected:  number
  /** weighted90 + sphereReferralExpected — the headline single number */
  totalForecast90:         number
  /** Confidence bands as adjustment percentages */
  lowBandPct:              number
  highBandPct:             number
  dealCount:               number
  activeListingCount:      number
  byStage:                 Array<{ stage: string; count: number; weightedGci: number }>
  weighted90Delta:         number | null
}

// ─── Compute one snapshot for one agent ───────────────────────────────────

export async function computeIncomeForecastForAgent(input: {
  agentId:     string
  brokerageId: string
  persist?:    boolean
}): Promise<IncomeForecastSnapshot> {
  const supabase = createServiceClient()
  const now = new Date()

  // IDENTITY CLASS (m338). input.agentId is a USERS id — the rollup cron reads it
  // from `users` — and income_forecast_snapshots.agent_id is users-class, so that
  // write is correct. But transactions.agent_id and listings.agent_id FK AGENTS,
  // so filtering them by the users id matched NOTHING: every per-agent income
  // forecast projected from an empty pipeline and reported the result as a real
  // number. The sphere-referral term was already right (it reads the users-class
  // NPV ledger), which is why the forecast looked plausible while the pipeline
  // half was silently zero.
  const agentRecordId = input.agentId
    ? await resolveUserIdToAgentRecord(input.agentId, input.brokerageId)
    : null

  // Pull open transactions for this agent (mirrors revenue-pipeline.ts
  // but service-role here so the cron can roll for everyone).
  const { data: transactions } = await supabase
    .from("transactions")
    .select("id, agent_id, stage, status, close_date, contract_date, purchase_price, commission_amount, estimated_commission, listing_id")
    .eq("agent_id", agentRecordId ?? "00000000-0000-0000-0000-000000000000")
    .eq("brokerage_id", input.brokerageId)
    .not("status", "in", "(closed,cancelled,failed,withdrawn,expired)")

  let weighted30 = 0, weighted60 = 0, weighted90 = 0
  let raw30 = 0, raw60 = 0, raw90 = 0
  let dealCount30 = 0
  const stageBuckets = new Map<string, { count: number; weightedGci: number }>()

  for (const t of (transactions ?? []) as Array<{
    stage: string | null; status: string | null; close_date: string | null;
    commission_amount: number | null; estimated_commission: number | null;
    purchase_price: number | null
  }>) {
    const stage = t.stage ?? t.status
    const probability = probabilityForStage(stage)
    const gci = Number(t.commission_amount ?? t.estimated_commission ?? 0)
    const closeDate = t.close_date ? new Date(t.close_date).getTime() : null

    let windowDays: 30 | 60 | 90 | null = null
    if (closeDate != null) {
      const daysOut = Math.floor((closeDate - now.getTime()) / 86_400_000)
      if (daysOut <= 30)      windowDays = 30
      else if (daysOut <= 60) windowDays = 60
      else if (daysOut <= 90) windowDays = 90
    } else {
      // No close date — assume long-window only
      windowDays = 90
    }

    if (windowDays === 30) { weighted30 += gci * probability; raw30 += gci; dealCount30++ }
    if (windowDays === 30 || windowDays === 60) { weighted60 += gci * probability; raw60 += gci }
    if (windowDays != null) { weighted90 += gci * probability; raw90 += gci }

    const key = stage ?? "unknown"
    const bucket = stageBuckets.get(key) ?? { count: 0, weightedGci: 0 }
    bucket.count += 1
    bucket.weightedGci += gci * probability
    stageBuckets.set(key, bucket)
  }

  // Active listings count
  const { count: activeListingCount } = await supabase
    .from("listings")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agentRecordId ?? "00000000-0000-0000-0000-000000000000")
    .eq("brokerage_id", input.brokerageId)
    .in("status", ["active", "coming_soon"])

  // Sphere referral expected value over 90-day horizon
  const sphereReferralExpected = await projectAgentSphereReferralValue({
    agentId:     input.agentId,
    brokerageId: input.brokerageId,
    horizonDays: 90,
  })

  // Previous snapshot for delta
  const { data: prev } = await supabase
    .from("income_forecast_snapshots")
    .select("id, weighted_90")
    .eq("agent_id", input.agentId)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  const weighted90Delta = prev?.weighted_90 != null ? Math.round(weighted90 - Number(prev.weighted_90)) : null
  const previousSnapshotId = (prev?.id as string | null) ?? null

  const result: IncomeForecastSnapshot = {
    agentId:                input.agentId,
    brokerageId:            input.brokerageId,
    computedAt:             now.toISOString(),
    weighted30:             Math.round(weighted30),
    weighted60:             Math.round(weighted60),
    weighted90:             Math.round(weighted90),
    raw30:                  Math.round(raw30),
    raw60:                  Math.round(raw60),
    raw90:                  Math.round(raw90),
    sphereReferralExpected,
    totalForecast90:        Math.round(weighted90) + sphereReferralExpected,
    lowBandPct:             25,   // ±25% lower bound by default
    highBandPct:            15,   // ±15% upper bound by default
    dealCount:              transactions?.length ?? 0,
    activeListingCount:     activeListingCount ?? 0,
    byStage:                Array.from(stageBuckets.entries()).map(([stage, v]) => ({
      stage,
      count: v.count,
      weightedGci: Math.round(v.weightedGci),
    })),
    weighted90Delta,
  }

  if (input.persist !== false) {
    await supabase.from("income_forecast_snapshots").insert({
      agent_id:                 result.agentId,
      brokerage_id:             result.brokerageId,
      weighted_30:              result.weighted30,
      weighted_60:              result.weighted60,
      weighted_90:              result.weighted90,
      raw_30:                   result.raw30,
      raw_60:                   result.raw60,
      raw_90:                   result.raw90,
      sphere_referral_expected: result.sphereReferralExpected,
      low_band_pct:             result.lowBandPct,
      high_band_pct:            result.highBandPct,
      deal_count:               result.dealCount,
      active_listing_count:     result.activeListingCount,
      by_stage:                 result.byStage,
      previous_snapshot_id:     previousSnapshotId,
      weighted_90_delta:        result.weighted90Delta,
    })
  }

  return result
}
