/**
 * Income Truth — gap analyzer.
 *
 * Composes existing infrastructure (no schema duplication):
 *   - income_forecast_snapshots (1036): weighted_30/60/90 from the live pipeline
 *   - agent_goals (335):                target_value per year per goal_type
 *   - agent_pl_snapshot (1053):         ytd actuals (gci_gross)
 *
 * Produces a single answer: "Behind by $X / Y% — based on current pipeline +
 * sphere expected value + YTD progress, projected year-end is $Z."
 *
 * Pure compute — no side effects. Caller persists the result via
 * persistGapAnalysisAction in app/actions/income-engine.ts.
 */

import "server-only"
import { createServiceClient } from "@/lib/supabase/service"

export interface GapAnalysisInput {
  /** agents.id — the single identity every table below keys off, including
   *  income_forecast_snapshots now that its agent_id points at agents(id). */
  agentId:      string
  /** users.id of the same agent. Nothing in here keys off it any more; kept
   *  because callers hold it and pass it as part of their actor context. */
  userId?:      string
  brokerageId:  string
  /** Override CURRENT_DATE for testing. */
  asOf?:        Date
}

export interface GapAnalysisResult {
  forecast_snapshot_id:     string | null
  weighted_30_cents:        number
  weighted_90_cents:        number
  weighted_180_cents:       number
  ytd_gci_cents:            number
  annual_goal_cents:        number | null
  remaining_year_cents:     number | null
  projected_year_end_cents: number
  /** Positive = behind, negative = ahead. Null when no annual goal set. */
  gap_to_goal_cents:        number | null
  gap_to_goal_pct:          number | null
  low_band_pct:             number | null
  high_band_pct:            number | null
  diagnostics:              Record<string, unknown>
}

function daysRemainingInYear(asOf: Date): number {
  const yearEnd = new Date(Date.UTC(asOf.getUTCFullYear(), 11, 31))
  const ms = yearEnd.getTime() - asOf.getTime()
  return Math.max(0, Math.ceil(ms / 86_400_000))
}

export async function analyzeIncomeGap(
  input: GapAnalysisInput,
): Promise<GapAnalysisResult> {
  const svc   = createServiceClient()
  const asOf  = input.asOf ?? new Date()
  const year  = asOf.getUTCFullYear()

  // 1. Latest forecast snapshot.
  const { data: snap } = await svc
    .from("income_forecast_snapshots")
    .select("id, weighted_30, weighted_60, weighted_90, sphere_referral_expected, low_band_pct, high_band_pct, deal_count, active_listing_count")
    .eq("agent_id", input.agentId)
    .order("computed_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  const w30  = Number(snap?.weighted_30  ?? 0)
  const w60  = Number(snap?.weighted_60  ?? 0)
  const w90  = Number(snap?.weighted_90  ?? 0)
  const sphere = Number(snap?.sphere_referral_expected ?? 0)

  // 180-day forecast: project beyond the 90-day window using sphere expected
  // value (already a forward expected GCI from lifetime_customer_npv_scores)
  // plus a linear extrapolation of weighted_90's run-rate over the next 90d.
  const w180 = w90 + sphere

  // 2. Annual goal (agent_goals). Schema CHECK uses 'gross_commission' as
  // the canonical GCI goal type (not 'gci').
  const { data: goal } = await svc
    .from("agent_goals")
    .select("target_value, current_value")
    .eq("agent_id", input.agentId)
    .eq("goal_type", "gross_commission")
    .eq("year", year)
    .maybeSingle()

  const annualGoal     = goal?.target_value ? Number(goal.target_value) : null
  const goalCurrentVal = goal?.current_value ? Number(goal.current_value) : null

  // 3. YTD actuals from agent_pl_snapshot (sum of all monthly snapshots this year)
  const { data: plRows } = await svc
    .from("agent_pl_snapshot")
    .select("month_year, gci_gross")
    .eq("agent_id", input.agentId)
    .like("month_year", `${year}-%`)

  const ytdGCI = (plRows ?? []).reduce((sum, r) => sum + Number(r.gci_gross ?? 0), 0)

  // 4. Projected year-end = YTD + pro-rated remaining-year forecast.
  // We have weighted_90 ($) and weighted_180 ($); extrapolate to daysRemaining.
  // Use the 90-day weighted run-rate as the steady-state monthly rate.
  const daysRem      = daysRemainingInYear(asOf)
  const dailyRunRate = w90 / 90
  const remainingForecast = dailyRunRate * daysRem + (daysRem >= 180 ? sphere : (sphere * (daysRem / 180)))
  const projectedYearEnd = ytdGCI + Math.max(0, remainingForecast)

  // 5. Gap math
  let gapToGoal: number | null = null
  let gapPct:    number | null = null
  let remainingToGoal: number | null = null
  if (annualGoal !== null && annualGoal > 0) {
    remainingToGoal = Math.max(0, annualGoal - ytdGCI)
    gapToGoal = annualGoal - projectedYearEnd  // positive = behind
    gapPct    = Math.round((gapToGoal / annualGoal) * 10000) / 100
  }

  // To cents (forecast snapshots store dollars as numeric)
  const toCents = (n: number) => Math.round(n * 100)

  return {
    forecast_snapshot_id:     (snap?.id as string | undefined) ?? null,
    weighted_30_cents:        toCents(w30),
    weighted_90_cents:        toCents(w90),
    weighted_180_cents:       toCents(w180),
    ytd_gci_cents:            toCents(ytdGCI),
    annual_goal_cents:        annualGoal !== null ? toCents(annualGoal) : null,
    remaining_year_cents:     remainingToGoal !== null ? toCents(remainingToGoal) : null,
    projected_year_end_cents: toCents(projectedYearEnd),
    gap_to_goal_cents:        gapToGoal !== null ? toCents(gapToGoal) : null,
    gap_to_goal_pct:          gapPct,
    low_band_pct:             snap?.low_band_pct  != null ? Number(snap.low_band_pct)  : null,
    high_band_pct:            snap?.high_band_pct != null ? Number(snap.high_band_pct) : null,
    diagnostics: {
      deal_count:           snap?.deal_count ?? 0,
      active_listing_count: snap?.active_listing_count ?? 0,
      daily_run_rate:       Math.round(dailyRunRate * 100) / 100,
      days_remaining:       daysRem,
      goal_current_value:   goalCurrentVal,
      monthly_pl_rows:      plRows?.length ?? 0,
      sphere_referral_dollars: sphere,
    },
  }
}
