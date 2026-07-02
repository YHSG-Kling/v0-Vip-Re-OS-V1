// lib/finance/team-pl.ts
//
// TEAM P&L — the team-level rollup that was missing. The brokerage-pl-rollup cron already computes a
// per-AGENT monthly snapshot (agent_pl_snapshot) from the canonical agent_commissions table, and the
// reporting layer already READS team_earnings / team_performance — but nothing ever WROTE them
// (table-with-no-writer drift), so every team dashboard read empty. This computes each team's real
// economics by rolling up the SAME canonical source (agent_commissions) over the team's members, so the
// team numbers reconcile exactly with the agent numbers. Pure + honest: what the data can't support
// (per-team goals, per-period retention) stays NULL, never fabricated.

export interface TeamCommissionRow {
  agent_id: string | null
  gross_commission: number | null
  agent_commission: number | null
  transaction_id: string | null
}

export interface TeamPnlInput {
  /** agent_commissions rows (closed in the period) for the team's active members. */
  commissions: TeamCommissionRow[]
  /** Distinct active member agent ids on the team this period. */
  activeAgentIds: string[]
  /** contract_date → close_date pairs for the team's closed deals (cycle time; missing → skipped). */
  closedCycle: Array<{ contract_date: string | null; close_date: string | null }>
  /** Count of the team's still-open (non-closed, non-cancelled) deals — for the conversion rate. */
  openDealCount: number
}

export interface TeamPnl {
  /** Total GCI the team generated (Σ gross_commission). */
  grossCommission: number
  /** The team's net — what the team's agents took home (Σ agent_commission). null when unknown. */
  teamNet: number | null
  agentCount: number
  /** Distinct closed deals attributed to the team this period. */
  transactionCount: number
  /** The team's top producer this period (max gross), or null. */
  topAgentId: string | null
  /** = grossCommission (team_performance.total_revenue). */
  totalRevenue: number
  /** Mean days contract→close over the team's closed deals; null when no dated deals. */
  avgDaysToClose: number | null
  /** closed / (closed + open), 0..1; null when the team had no deal activity at all. */
  conversionRate: number | null
}

const num = (n: number | null | undefined) => Number(n ?? 0)

/**
 * PURE: fold a team's canonical commission rows + activity into its P&L. teamNet is the team's agents'
 * retained commission (agent_commission) — the team keeps that; the brokerage keeps the rest. Honest:
 * teamNet is null only when NO row carried an agent_commission (we don't invent a split).
 */
export function computeTeamPnl(input: TeamPnlInput): TeamPnl {
  const { commissions, activeAgentIds, closedCycle, openDealCount } = input

  let grossCommission = 0
  let netAcc = 0
  let sawNet = false
  const grossByAgent = new Map<string, number>()
  const deals = new Set<string>()
  for (const c of commissions) {
    grossCommission += num(c.gross_commission)
    if (c.agent_commission != null) { netAcc += num(c.agent_commission); sawNet = true }
    if (c.agent_id) grossByAgent.set(c.agent_id, (grossByAgent.get(c.agent_id) ?? 0) + num(c.gross_commission))
    if (c.transaction_id) deals.add(c.transaction_id)
  }

  let topAgentId: string | null = null
  let topGross = -1
  for (const [id, g] of grossByAgent) if (g > topGross) { topGross = g; topAgentId = id }

  // Average days contract→close over the dated closed deals (honest: undated deals are skipped).
  let daySum = 0, dayN = 0
  for (const d of closedCycle) {
    if (!d.contract_date || !d.close_date) continue
    const a = Date.parse(d.contract_date), b = Date.parse(d.close_date)
    if (Number.isNaN(a) || Number.isNaN(b) || b < a) continue
    daySum += (b - a) / 86_400_000; dayN++
  }
  const avgDaysToClose = dayN > 0 ? Math.round((daySum / dayN) * 10) / 10 : null

  const closedDeals = deals.size
  const denom = closedDeals + openDealCount
  const conversionRate = denom > 0 ? Math.round((closedDeals / denom) * 1000) / 1000 : null

  return {
    grossCommission: Math.round(grossCommission * 100) / 100,
    teamNet: sawNet ? Math.round(netAcc * 100) / 100 : null,
    agentCount: activeAgentIds.length,
    transactionCount: closedDeals,
    topAgentId,
    totalRevenue: Math.round(grossCommission * 100) / 100,
    avgDaysToClose,
    conversionRate,
  }
}

/** Year-month bucket (UTC) — the period_label the writer keys on, matching agent_pl_snapshot.month_year. */
export function monthLabel(now: Date): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
}
