// lib/managers/outcome-attribution.ts
// PURE outcome attribution for the closed learning loop. No I/O — maps REAL business
// outcomes back to the manager whose decision produced them, into a 0–100 "decision
// effectiveness" score that sits ALONGSIDE the Anthropic rubric pass-rate in the
// Manager-Trust scorecard. Rubric = "did the work meet the bar"; effectiveness = "did
// the work win in the real world". Two dimensions = a manager that is both compliant
// AND results-proven. The action and the simulator score through these functions.

/** strategy_outcomes.outcome CHECK values (Shopping Agent offer-strategy decisions). */
export type StrategyOutcome = "accepted" | "rejected" | "countered" | "withdrawn"

/** Win-weighting: an accepted offer is a full win, a counter is partial, the rest miss. */
const STRATEGY_WEIGHT: Record<StrategyOutcome, number> = {
  accepted: 1.0,
  countered: 0.5,
  rejected: 0.0,
  withdrawn: 0.0,
}

export interface StrategyOutcomeRow {
  outcome: string
  deviation_from_recommendation?: number | string | null
}

export interface StrategyEffectiveness {
  total: number
  accepted: number
  countered: number
  missed: number
  /** integer 0–100, win-weighted */
  effectiveness: number
  /** avg |deviation| — lower means the agent's recommendation was followed + worked */
  avgDeviation: number | null
}

export function scoreStrategyOutcomes(rows: StrategyOutcomeRow[]): StrategyEffectiveness {
  let accepted = 0, countered = 0, missed = 0, weighted = 0
  let devSum = 0, devCount = 0
  for (const r of rows) {
    const o = (r.outcome ?? "").toLowerCase() as StrategyOutcome
    const w = STRATEGY_WEIGHT[o]
    if (w === undefined) continue
    weighted += w
    if (o === "accepted") accepted++
    else if (o === "countered") countered++
    else missed++
    const d = r.deviation_from_recommendation == null ? null : Math.abs(Number(r.deviation_from_recommendation))
    if (d != null && !Number.isNaN(d)) { devSum += d; devCount++ }
  }
  const total = accepted + countered + missed
  return {
    total, accepted, countered, missed,
    effectiveness: total === 0 ? 0 : Math.round((weighted / total) * 100),
    avgDeviation: devCount === 0 ? null : Math.round((devSum / devCount) * 100) / 100,
  }
}

export interface MarketingOutcomeRow {
  plan_quality_score?: number | string | null
  realized_open_rate?: number | string | null
  realized_click_rate?: number | string | null
}

export interface MarketingEffectiveness {
  weeks: number
  avgPlanQuality: number   // 0–100
  avgOpenRate: number      // 0–100
  avgClickRate: number     // 0–100
  effectiveness: number    // 0–100
}

/** Normalize a metric stored as either a 0–1 fraction or a 0–100 percent into 0–100. */
function pct(v: number | string | null | undefined): number | null {
  if (v == null) return null
  const n = Number(v)
  if (Number.isNaN(n)) return null
  return n <= 1 ? n * 100 : n
}

export function scoreMarketingOutcomes(rows: MarketingOutcomeRow[]): MarketingEffectiveness {
  const q: number[] = [], o: number[] = [], c: number[] = []
  for (const r of rows) {
    const pq = pct(r.plan_quality_score); if (pq != null) q.push(pq)
    const or = pct(r.realized_open_rate); if (or != null) o.push(or)
    const cr = pct(r.realized_click_rate); if (cr != null) c.push(cr)
  }
  const avg = (xs: number[]) => (xs.length === 0 ? 0 : Math.round(xs.reduce((s, x) => s + x, 0) / xs.length))
  const avgPlanQuality = avg(q), avgOpenRate = avg(o), avgClickRate = avg(c)
  // Effectiveness leans on plan quality, with realized engagement as supporting signal.
  const effectiveness = q.length > 0
    ? Math.round(avgPlanQuality * 0.6 + avgOpenRate * 0.25 + avgClickRate * 0.15)
    : Math.round(avgOpenRate * 0.6 + avgClickRate * 0.4)
  return { weeks: rows.length, avgPlanQuality, avgOpenRate, avgClickRate, effectiveness }
}

export type EffectivenessBand = "proven" | "developing" | "underperforming" | "no_data"

/** Band an effectiveness score for the scorecard badge (min sample to claim a band). */
export function effectivenessBand(effectiveness: number, sample: number): EffectivenessBand {
  if (sample < 3) return "no_data"
  if (effectiveness >= 70) return "proven"
  if (effectiveness >= 45) return "developing"
  return "underperforming"
}
