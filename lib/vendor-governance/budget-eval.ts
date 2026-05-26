// lib/vendor-governance/budget-eval.ts
// Pure vendor-budget evaluation — no server-only imports, so it is directly
// unit-testable (and importable from the tsx simulator). The async DB-backed
// gate (checkVendorBudget) lives in budget-gate.ts.

// Monthly platform-vendor spend ceiling (USD) per plan tier. These guard the
// PLATFORM's cost (the platform owns these vendor keys); generous so normal use
// is never blocked, but they stop a runaway loop.
export const MONTHLY_VENDOR_BUDGET_USD: Record<string, number> = {
  solo_agent:    50,
  team:          200,
  brokerage:     750,
  multi_location: 2500,
}
export const DEFAULT_VENDOR_BUDGET = MONTHLY_VENDOR_BUDGET_USD.solo_agent
const SOFT_WARN_PCT = 0.8

export interface VendorBudgetEval {
  allowed: boolean
  spent: number
  budget: number
  percent: number
  softWarning: boolean
}

/**
 * Pure: decide allow/warn/block given current month-to-date spend, the ceiling,
 * and the cost this call would add. Blocks only when the projected total crosses
 * the ceiling; soft-warns from 80%.
 */
export function evaluateVendorBudget(spent: number, budget: number, addCost = 0): VendorBudgetEval {
  const safeBudget = budget > 0 ? budget : DEFAULT_VENDOR_BUDGET
  const projected = Math.max(0, spent) + Math.max(0, addCost)
  const percent = Math.round((projected / safeBudget) * 1000) / 10
  return {
    allowed: projected <= safeBudget,
    spent: Math.round(spent * 100) / 100,
    budget: safeBudget,
    percent,
    softWarning: projected >= safeBudget * SOFT_WARN_PCT && projected <= safeBudget,
  }
}

/** Budget ceiling for a plan tier (falls back to the solo-agent default). */
export function vendorBudgetForTier(planTier: string | null | undefined): number {
  return MONTHLY_VENDOR_BUDGET_USD[planTier ?? "solo_agent"] ?? DEFAULT_VENDOR_BUDGET
}
