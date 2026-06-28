// lib/seller-equity/scenarios.ts
// ─────────────────────────────────────────────────────────────────────────────
// SELLER WHAT-IF SCENARIOS — the seller-side decision tool sellers ask for (RealScout/Fello wishlist):
// "list at X vs Y", "wait 6 months", "do these improvements" — each with the NET they'd actually keep.
// PURE. Reuses estimateSellerNetProceeds (the canonical net math) so every scenario agrees with the
// equity card + interactive net sheet. No fabricated numbers: appreciation/repair inputs are explicit
// and labeled as estimates; absent inputs simply omit that scenario.

import { estimateSellerNetProceeds } from "./equity-estimate"

export interface ScenarioInput {
  estimatedValue: number
  mortgageBalance: number | null
  commissionRate?: number
  hoaDuesMonthly?: number | null
  /** Zip-level annual appreciation as a decimal (e.g. 0.04). Enables the "wait 6 months" scenario. */
  annualAppreciationPct?: number | null
  /** A specific improvement: its cost and the value uplift it's expected to add. Enables "after repairs". */
  improvement?: { label: string; cost: number; valueUplift: number } | null
}

export interface Scenario {
  key: string
  label: string
  /** The home value assumed in this scenario. */
  value: number
  /** Net proceeds in this scenario (null when the mortgage balance isn't known yet). */
  netProceeds: number | null
  /** Net delta vs the base "at estimated value" scenario (null until balances known). */
  deltaVsBase: number | null
  note?: string
}

/** PURE. Build the seller's what-if scenario set. Base is always present; others depend on inputs. */
export function buildPricingScenarios(input: ScenarioInput): Scenario[] {
  const base = input.estimatedValue
  const netAt = (value: number) =>
    estimateSellerNetProceeds({
      estimatedValue: value, mortgageBalance: input.mortgageBalance,
      commissionRate: input.commissionRate, hoaDuesMonthly: input.hoaDuesMonthly,
    }).netProceeds

  const baseNet = netAt(base)
  const mk = (key: string, label: string, value: number, note?: string): Scenario => {
    const net = netAt(Math.round(value))
    return {
      key, label, value: Math.round(value), netProceeds: net,
      deltaVsBase: net !== null && baseNet !== null ? net - baseNet : null, note,
    }
  }

  const scenarios: Scenario[] = [
    mk("list_below", "List 5% under", base * 0.95, "A faster-sale price"),
    mk("at_value", "At estimated value", base),
    mk("list_above", "List 5% over", base * 1.05, "Test the ceiling"),
  ]

  // Wait 6 months — apply HALF the annual appreciation (honest, labeled an estimate).
  if (input.annualAppreciationPct != null && input.annualAppreciationPct !== 0) {
    const waited = base * (1 + input.annualAppreciationPct / 2)
    scenarios.push(mk("wait_6mo", "Wait ~6 months", waited,
      `Assumes ${(input.annualAppreciationPct * 100).toFixed(1)}%/yr area appreciation — an estimate, not a promise`))
  }

  // After a specific improvement — net of its cost (uplift added to value, cost deducted from net).
  if (input.improvement && input.improvement.cost >= 0 && input.improvement.valueUplift >= 0) {
    const imp = input.improvement
    const improvedValueNet = netAt(base + imp.valueUplift)
    const net = improvedValueNet !== null ? improvedValueNet - imp.cost : null
    scenarios.push({
      key: "after_repairs", label: `After: ${imp.label}`, value: Math.round(base + imp.valueUplift),
      netProceeds: net,
      deltaVsBase: net !== null && baseNet !== null ? net - baseNet : null,
      note: `Adds ~$${imp.valueUplift.toLocaleString()} value for ~$${imp.cost.toLocaleString()} — net of cost`,
    })
  }

  return scenarios
}

/** PURE. The scenario that nets the seller the most (among those with a known net). null if none known. */
export function bestNetScenario(scenarios: Scenario[]): Scenario | null {
  const known = scenarios.filter((s) => s.netProceeds !== null)
  if (known.length === 0) return null
  return known.reduce((best, s) => ((s.netProceeds as number) > (best.netProceeds as number) ? s : best), known[0])
}
