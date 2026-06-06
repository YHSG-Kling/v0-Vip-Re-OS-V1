// lib/vendor-governance/budget-visibility.ts
// Role-scoped redaction for vendor-spend governance. PRIVACY CONTRACT:
//   • Platform staff (superadmin, support) see full detail — spend, ceiling, %,
//     and per-vendor breakdown (vendor NAMES included).
//   • Brokerage / subscriber users see ONLY a coarse status level and, when the
//     superadmin has enabled it, a "you're approaching your usage limit" warning.
//     They NEVER see dollar amounts, the budget ceiling, percentages, or any
//     vendor names. Vendors are platform-internal.
// Pure — no I/O — so the redaction is unit-tested deterministically.

import type { VendorBudgetEval } from "./budget-eval"

export type BudgetLevel = "ok" | "approaching" | "paused"

/** Coarse status from a budget evaluation (no numbers leak through this). */
export function budgetLevel(e: Pick<VendorBudgetEval, "allowed" | "softWarning">): BudgetLevel {
  if (!e.allowed) return "paused"
  if (e.softWarning) return "approaching"
  return "ok"
}

// What a brokerage/subscriber user is allowed to see: a level + whether to show
// the warning banner. No spend, no ceiling, no percent, no vendor names.
export interface BrokerageBudgetView {
  scope: "brokerage"
  level: BudgetLevel
  /** Show the "approaching usage limit" banner — gated by the superadmin toggle. */
  showWarning: boolean
}

// What platform staff (superadmin/support) see: everything.
export interface PlatformBudgetView {
  scope: "platform"
  level: BudgetLevel
  allowed: boolean
  spent: number
  budget: number
  percent: number
  /** Per-vendor spend breakdown — vendor NAMES are platform-only. */
  vendors?: Array<{ vendor: string; spent: number }>
}

export type BudgetView = BrokerageBudgetView | PlatformBudgetView

/**
 * Redact a budget evaluation for the requesting actor.
 *   isPlatformStaff      → full PlatformBudgetView (vendor names allowed)
 *   else (brokerage user) → BrokerageBudgetView; warning shown only when the
 *                           superadmin toggle (showBrokerageWarning) is ON.
 */
export function redactBudgetForActor(
  e: VendorBudgetEval,
  opts: {
    isPlatformStaff: boolean
    showBrokerageWarning: boolean
    vendors?: Array<{ vendor: string; spent: number }>
  },
): BudgetView {
  const level = budgetLevel(e)
  if (opts.isPlatformStaff) {
    return {
      scope: "platform",
      level,
      allowed: e.allowed,
      spent: e.spent,
      budget: e.budget,
      percent: e.percent,
      vendors: opts.vendors,
    }
  }
  return {
    scope: "brokerage",
    level,
    // Only surface the banner when superadmin enabled it AND there's something to warn about.
    showWarning: opts.showBrokerageWarning && level !== "ok",
  }
}
