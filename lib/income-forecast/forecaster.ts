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
  /** The USERS id the caller passed (transport only). The persisted row's
   *  agent_id is the resolved agents(id) — see computeIncomeForecastForAgent. */
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

  // IDENTITY CLASS. input.agentId is a USERS id — the rollup cron
  // (app/api/cron/lifetime-npv-forecast-rollup/route.ts) reads it from `users`.
  // EVERY agent_id this function touches FKs agents(id): transactions, listings,
  // lifetime_customer_npv_scores (read through projectAgentSphereReferralValue)
  // AND income_forecast_snapshots (scripts/schema-fk-map.ts:408 — m366). So the
  // users id is resolved ONCE here and is never used as an identity below; it
  // survives only as the transport field `result.agentId`.
  //
  // The previous comment at this spot claimed income_forecast_snapshots was
  // users-class and the NPV ledger too, and scripts/identity-class-guard.ts
  // pinned that as "still writes income_forecast_snapshots with the users id".
  // Both were false after m366: the snapshot insert was a 23503 nobody read
  // (0 rows, cron counting forecast_snapshots all the while), the previous-
  // snapshot delta lookup matched nothing, and the sphere-referral term read an
  // empty set — so the "plausible" forecast was zero on BOTH halves.
  const agentRecordId = input.agentId
    ? await resolveUserIdToAgentRecord(input.agentId, input.brokerageId)
    : null
  // REFUSE rather than write a broken row: a per-agent snapshot with no agents
  // row can carry neither the users id (FK refusal) nor NULL (a row no reader
  // keyed on agent_id would ever find). The cron's per-agent try/catch counts
  // this as an error instead of a snapshot.
  if (!agentRecordId) {
    throw new Error(
      `[income-forecast] users id ${input.agentId} has no agents row in brokerage ${input.brokerageId}; refusing to forecast`,
    )
  }

  // Pull open transactions for this agent (mirrors revenue-pipeline.ts
  // but service-role here so the cron can roll for everyone).
  const { data: transactions, error: transactionsError } = await supabase
    .from("transactions")
    .select("id, agent_id, stage, status, close_date, contract_date, purchase_price, commission_amount, estimated_commission, listing_id")
    .eq("agent_id", agentRecordId)
    .eq("brokerage_id", input.brokerageId)
    .not("status", "in", "(closed,cancelled,failed,withdrawn,expired)")
  // A refused pipeline read must not forecast as "no deals".
  if (transactionsError) {
    throw new Error(`[income-forecast] transactions read refused for agent ${agentRecordId}: ${transactionsError.message}`)
  }

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
  const { count: activeListingCount, error: listingsError } = await supabase
    .from("listings")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", agentRecordId)
    .eq("brokerage_id", input.brokerageId)
    .in("status", ["active", "coming_soon"])
  if (listingsError) {
    throw new Error(`[income-forecast] listings count refused for agent ${agentRecordId}: ${listingsError.message}`)
  }

  // Sphere referral expected value over 90-day horizon.
  // lifetime_customer_npv_scores.agent_id FKs agents(id) (schema-fk-map.ts:455),
  // and projectAgentSphereReferralValue filters on it — so it takes the AGENTS
  // id. Passing the users id here matched nothing and read as $0 of sphere value.
  const sphereReferralExpected = await projectAgentSphereReferralValue({
    agentId:     agentRecordId,
    brokerageId: input.brokerageId,
    horizonDays: 90,
  })

  // Previous snapshot for delta — same agents-class key the insert below writes.
  const { data: prev, error: prevError } = await supabase
    .from("income_forecast_snapshots")
    .select("id, weighted_90")
    .eq("agent_id", agentRecordId)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle()
  // A refused read is not "no previous snapshot". Say so; the delta stays null.
  if (prevError) {
    console.error(`[income-forecast] previous-snapshot lookup refused for agent ${agentRecordId}:`, prevError.message)
  }
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
    // income_forecast_snapshots.agent_id FKs agents(id): the RESOLVED id, not
    // `result.agentId` (the users id kept on the result as transport). The error
    // is READ — a swallowed 23503 here is why this table held 0 rows.
    const { error: insertError } = await supabase.from("income_forecast_snapshots").insert({
      agent_id:                 agentRecordId,
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
    if (insertError) {
      throw new Error(
        `[income-forecast] snapshot insert refused for brokerage ${input.brokerageId}, agent ${agentRecordId}: ${insertError.message}`,
      )
    }
  }

  return result
}
