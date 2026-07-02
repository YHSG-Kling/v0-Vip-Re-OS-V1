// lib/finance/team-pl-writer.ts
//
// TEAM P&L WRITER (finance_manager). Live side of the team-level rollup. For each team it gathers the
// canonical agent_commissions closed this month for the team's active members, the deal cycle times and
// open-pipeline count, computes the pure Team P&L, and upserts team_earnings + team_performance (both
// idempotent per team+period via m259). Rolls up the SAME source the per-agent snapshot uses, so team and
// agent numbers reconcile. Best-effort; never throws into a caller.

import { createServiceClient } from "@/lib/supabase/service"
import { computeTeamPnl, monthLabel, type TeamCommissionRow } from "@/lib/finance/team-pl"

type Svc = ReturnType<typeof createServiceClient>

/** Deals still in flight (not a terminal state) — the denominator side of the conversion rate. */
const OPEN_STATUSES = ["active", "under_contract", "pending", "contingent", "in_progress"]

export interface TeamPnlResult { teams: number; written: number; withProduction: number }

/** Compute + persist one brokerage's team P&L for the month containing `now`. */
export async function runTeamPnl(svc: Svc, params: { brokerageId: string; now?: Date }): Promise<TeamPnlResult> {
  const out: TeamPnlResult = { teams: 0, written: 0, withProduction: 0 }
  const now = params.now ?? new Date()
  const period = monthLabel(now)
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString()
  const monthEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59)).toISOString()

  const { data: teams } = await svc.from("teams")
    .select("id").eq("brokerage_id", params.brokerageId).is("deleted_at", null).limit(500)
  if (!teams || teams.length === 0) return out

  for (const t of teams as Array<{ id: string }>) {
    out.teams++
    try {
      const { data: members } = await svc.from("team_members")
        .select("agent_id").eq("team_id", t.id).eq("is_active", true).not("agent_id", "is", null).limit(500)
      const agentIds = Array.from(new Set(((members ?? []) as any[]).map((m) => m.agent_id).filter(Boolean)))
      if (agentIds.length === 0) { await upsert(svc, params.brokerageId, t.id, period, now, empty(agentIds.length)); out.written++; continue }

      // Canonical commissions closed this month for the team's members.
      const { data: comm } = await svc.from("agent_commissions")
        .select("agent_id, gross_commission, agent_commission, transaction_id")
        .in("agent_id", agentIds).gte("close_date", monthStart).lte("close_date", monthEnd).limit(5000)
      const commissions = (comm ?? []) as TeamCommissionRow[]

      // Cycle times for the closed deals (contract → close).
      const txnIds = Array.from(new Set(commissions.map((c) => c.transaction_id).filter(Boolean))) as string[]
      let closedCycle: Array<{ contract_date: string | null; close_date: string | null }> = []
      if (txnIds.length) {
        const { data: txns } = await svc.from("transactions").select("contract_date, close_date").in("id", txnIds).limit(5000)
        closedCycle = (txns ?? []) as any[]
      }

      // Open pipeline for the team's agents (conversion denominator).
      const { count: openDealCount } = await svc.from("transactions")
        .select("id", { count: "exact", head: true }).in("agent_id", agentIds).in("status", OPEN_STATUSES)

      const pnl = computeTeamPnl({ commissions, activeAgentIds: agentIds, closedCycle, openDealCount: openDealCount ?? 0 })
      if (pnl.grossCommission > 0) out.withProduction++
      await upsert(svc, params.brokerageId, t.id, period, now, pnl)
      out.written++
    } catch { /* keep going to the next team */ }
  }
  return out
}

function empty(agentCount: number) {
  return { grossCommission: 0, teamNet: null, agentCount, transactionCount: 0, topAgentId: null, totalRevenue: 0, avgDaysToClose: null, conversionRate: null }
}

async function upsert(
  svc: Svc, brokerageId: string, teamId: string, period: string, now: Date,
  pnl: ReturnType<typeof computeTeamPnl>,
) {
  // period_type is CHECK-constrained to mtd/ytd/all_time; the monthly running total is month-to-date.
  await svc.from("team_earnings").upsert({
    brokerage_id: brokerageId, team_id: teamId, period_type: "mtd", period_label: period,
    gross_commission: pnl.grossCommission, team_net: pnl.teamNet, agent_count: pnl.agentCount,
    transaction_count: pnl.transactionCount, top_agent_id: pnl.topAgentId, computed_at: now.toISOString(),
  }, { onConflict: "team_id,period_type,period_label" })

  await svc.from("team_performance").upsert({
    brokerage_id: brokerageId, team_id: teamId, period_label: period,
    total_revenue: pnl.totalRevenue, avg_days_to_close: pnl.avgDaysToClose, conversion_rate: pnl.conversionRate,
    // goal_amount / goal_pct / agent_retention_pct: no per-team-period source yet — honest NULL, never fabricated.
    computed_at: now.toISOString(),
  }, { onConflict: "team_id,period_label" })
}

/** Autonomous: roll up every brokerage's team P&L (rides the nightly brokerage-pl-rollup cron). */
export async function runTeamPnlAll(svc: Svc, now?: Date): Promise<{ brokerages: number; teams: number; written: number }> {
  const out = { brokerages: 0, teams: 0, written: 0 }
  const { data: rows } = await svc.from("brokerages").select("id").limit(1000)
  for (const b of (rows ?? []) as Array<{ id: string }>) {
    out.brokerages++
    try { const r = await runTeamPnl(svc, { brokerageId: b.id, now }); out.teams += r.teams; out.written += r.written } catch { /* keep going */ }
  }
  return out
}
