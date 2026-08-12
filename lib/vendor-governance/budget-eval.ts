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
 * HOW WELL THE VERDICT IS KNOWN — the honesty half of a budget answer, separate
 * from the answer itself.
 *
 * Declared HERE, in the pure module, rather than on `VendorBudgetResult` in
 * budget-gate.ts where it was born (wave 19). Not a relocation for tidiness:
 * `redactBudgetForActor` is pure and I/O-free by contract and cannot import a
 * `server-only` module even for a type, so the alternative was a second
 * hand-copied declaration of the same three fields — two definitions that agree
 * today and drift the first time a fourth flag is added. `VendorBudgetResult`
 * extends this, so there is exactly one definition and the views cannot fall
 * behind the gate.
 *
 * Every field is OPTIONAL and absent means "not degraded", so a pure
 * `evaluateVendorBudget` result satisfies this structurally with no change.
 */
export interface VendorBudgetDegradation {
  /**
   * True when the budget could NOT actually be read (ledger/table read failure) and
   * `allowed: true` is a FAIL-OPEN verdict, not a real one. Callers that pre-flight
   * sends may ledger the breakage (recordSelfHeal) but MUST still proceed — a broken
   * budget system never silences a consented client communication.
   */
  degraded?: boolean
  /**
   * True when `budget` / `planTier` were ASSUMED rather than read from the
   * tenant's own record — either the tier read was REFUSED, or the record is
   * absent. The ceiling in this result is therefore a platform default, not
   * this tenant's ceiling. A caller that renders or explains a budget verdict
   * ("you are approaching / over your limit") MUST NOT state the ceiling as
   * fact while this is set; it is the difference between a measured claim and
   * an assumed one, and only the tier half of the result can say so.
   */
  degradedTier?: boolean
  /**
   * True when `spent` / `percent` are NOT a measured figure — the month-to-date
   * ledger read was refused (or was never reached because the tier read failed
   * first). Distinct from `degradedTier`: an unknown spend and an unknown
   * ceiling degrade different halves of the same verdict and can occur alone.
   */
  degradedSpend?: boolean
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

export interface BrokerageSpendRow {
  brokerageId: string
  name: string
  planTier: string
  spent: number
  budget: number
  percent: number
  level: "ok" | "approaching" | "paused"
}

/**
 * Pure: month-to-date vendor spend per brokerage → a platform-staff overview row set.
 * Spend rows are summed by brokerage; the ceiling comes from each brokerage's tier.
 * Sorted by percent-of-budget descending (closest-to-limit first).
 */
export function aggregateBrokerageSpend(
  usageRows: Array<{ brokerage_id: string | null; total_cost: number | string | null }>,
  brokerages: Array<{ id: string; name: string | null; plan_tier: string | null }>,
): BrokerageSpendRow[] {
  const spentByBrokerage = new Map<string, number>()
  for (const r of usageRows) {
    if (!r.brokerage_id) continue
    spentByBrokerage.set(r.brokerage_id, (spentByBrokerage.get(r.brokerage_id) ?? 0) + (Number(r.total_cost) || 0))
  }
  return brokerages
    .map((b) => {
      const spent = Math.round((spentByBrokerage.get(b.id) ?? 0) * 100) / 100
      const e = evaluateVendorBudget(spent, vendorBudgetForTier(b.plan_tier))
      const level: BrokerageSpendRow["level"] = !e.allowed ? "paused" : e.softWarning ? "approaching" : "ok"
      return { brokerageId: b.id, name: b.name ?? "—", planTier: b.plan_tier ?? "solo_agent", spent, budget: e.budget, percent: e.percent, level }
    })
    .sort((a, b) => b.percent - a.percent)
}
