// lib/recruiting/recruiting-roi-compute.ts
//
// RECRUITING ROI WRITER (recruiting_manager) — recruiting_roi was READ by the ROI dashboard, the agent
// scorecard, and the brokerage P&L, but NOTHING wrote it in production (only simulators inserted rows),
// so the headline ROI / net / breakeven KPIs read EMPTY in prod. This computes a REAL row per recruited
// agent from the data we actually have — recruiting_costs (what we spent) + recruiting_analytics (the
// brokerage's net FROM that agent) — and is HONEST about what the data can't yet support (breakeven
// month / forward LTV need a monthly cohort + retention model we don't have, so they stay null rather
// than fabricated). Pure compute is unit-tested; the writer upserts one row per recruited agent.

export interface RecruitingCostRow { amount: number | null }
export interface RecruitingAnalyticsRow {
  brokerage_net_from_agent: number | null
  gross_commission_generated: number | null
  year_number: number | null
}

export interface RecruitingRoi {
  total_recruiting_cost: number
  lifetime_brokerage_net: number
  /** (net − cost) / cost × 100, rounded. Null when cost is 0 (can't divide — honest, not "0%"). */
  roi_pct: number | null
  /** Requires a monthly cost/production cohort we don't track yet → honest null (never fabricated). */
  breakeven_month: number | null
  /** Forward LTV needs a retention/run-rate model we don't have → honest null. */
  ltv_estimate: number | null
}

const n = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? v : 0)

/**
 * PURE: compute a recruited agent's ROI from real cost + production rows. Uses the brokerage's NET from
 * the agent (not gross) — the true return on the recruiting spend. roi_pct is null when there's no cost
 * to divide by; breakeven_month + ltv_estimate stay null until the data supports them (no fabrication).
 */
export function computeRecruitingRoi(costs: RecruitingCostRow[], analytics: RecruitingAnalyticsRow[]): RecruitingRoi {
  const total_recruiting_cost = costs.reduce((s, c) => s + n(c.amount), 0)
  const lifetime_brokerage_net = analytics.reduce((s, a) => s + n(a.brokerage_net_from_agent), 0)
  const roi_pct = total_recruiting_cost > 0
    ? Math.round(((lifetime_brokerage_net - total_recruiting_cost) / total_recruiting_cost) * 100)
    : null
  return {
    total_recruiting_cost: Math.round(total_recruiting_cost * 100) / 100,
    lifetime_brokerage_net: Math.round(lifetime_brokerage_net * 100) / 100,
    roi_pct,
    breakeven_month: null,
    ltv_estimate: null,
  }
}

/**
 * PURE: the brokerage's NET from a deal's gross commission, given the agent's split (the % the AGENT
 * keeps). Brokerage net = gross × (1 − split/100). Returns null when the split is unknown — honest, so
 * the analytics row records gross-only rather than a guessed net.
 */
export function brokerageNetFromSplit(grossCommission: number | null, agentSplitPercent: number | null): number | null {
  const g = n(grossCommission)
  if (g <= 0) return 0
  if (agentSplitPercent == null || !Number.isFinite(agentSplitPercent)) return null
  const split = Math.min(100, Math.max(0, agentSplitPercent))
  return Math.round(g * (1 - split / 100) * 100) / 100
}
