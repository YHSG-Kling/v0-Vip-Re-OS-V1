/**
 * lib/remotion/stock-scope.ts
 *
 * Wave 39 — the stock-asset (uploaded b-roll / bookends / music) resolution
 * cascade. Agents, teams, AND brokerages can upload stock to video_assets at
 * their own tier (scope_type), and a render pulls the MOST-SPECIFIC available:
 *
 *     agent render   → agent's own → their team's → the brokerage's
 *     team render    → the team's  → the brokerage's
 *     brokerage+     → that scope  → the brokerage's
 *
 * Pure (no DB) so the cascade order is unit-tested; pickStockAsset walks it.
 * (Previously the cascade skipped the TEAM tier, so a team's uploaded b-roll
 * never reached its agents — this fixes that.)
 */
export interface StockScopeRef { scopeType: string; scopeId: string }

export interface StockScopeIntent {
  scopeType:   string
  scopeId:     string
  brokerageId: string
}

/**
 * Ordered, deduplicated list of (scopeType, scopeId) to try — most specific
 * first. `teamId` is the agent's team (resolved by the caller); when absent,
 * the team tier is simply skipped (no regression vs the old agent→brokerage).
 */
export function resolveStockScopeOrder(intent: StockScopeIntent, teamId?: string | null): StockScopeRef[] {
  const order: StockScopeRef[] = []
  const seen = new Set<string>()
  const add = (scopeType: string, scopeId: string | null | undefined) => {
    if (!scopeId) return
    const key = `${scopeType}:${scopeId}`
    if (seen.has(key)) return
    seen.add(key)
    order.push({ scopeType, scopeId })
  }

  // 1. The caller's exact scope.
  add(intent.scopeType, intent.scopeId)
  // 2. An agent also inherits their team's stock.
  if (intent.scopeType === "agent") add("team", teamId)
  // 3. Everything below brokerage (and multi_location / platform) falls back to
  //    the brokerage's shared stock library.
  if (intent.scopeType !== "brokerage") add("brokerage", intent.brokerageId)

  return order
}
