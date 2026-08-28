import {
NextRequest, NextResponse } from "next/server"
import { createServiceClient } from "@/lib/supabase/service"
import {
  createCronRunContextAction,
  recordCronStartAction,
  recordCronSuccessAction,
  recordCronFailureAction,
} from "@/app/actions/cron-kernel"
import { verifyCronAuth } from "@/lib/cron-auth"

export const dynamic = "force-dynamic"
export const maxDuration = 300

/**
 * Brokerage P&L Rollup Cron — nightly
 *
 * For each active agent in every brokerage, computes:
 *   gci_gross          = sum(agent_commissions.gross_commission) closed this month
 *   agent_payout       = sum(net_to_agent ?? agent_commission)   — NET-PREFERENCE RULE
 *   brokerage_gross    = sum(net_to_brokerage ?? gross - agent_commission)
 *   ai_cost_cents      = sum(ai_tool_usage.cost_cents) for this agent this month
 *   fee_income_cents   = sum(agent_fee_charges.amount * 100) where status='paid'
 *   marketing_spend_cents = 0 (future: attribute campaign spend)
 *   net_brokerage_margin  = brokerage_gross - (ai_cost_cents/100) + (fee_income_cents/100)
 *   roi_multiple          = gci_gross / total_spend (if total_spend > 0)
 *
 * Upserts into agent_pl_snapshot (UNIQUE agent_id, month_year).
 * IDEMPOTENT — safe to re-run multiple times per day.
 */
export async function GET(req: NextRequest) {
  // Cron auth — see lib/cron-auth.ts
  const unauth = verifyCronAuth(req)
  if (unauth) return unauth

  const ctx = await createCronRunContextAction({
    cron_name: "brokerage-pl-rollup",
    cron_path: "/app/api/cron/brokerage-pl-rollup/route.ts",
  })
  if (!ctx.success || !ctx.data) {
    return NextResponse.json({ error: "Failed to create cron context" }, { status: 500 })
  }
  const contextId = ctx.data.context_id
  await recordCronStartAction({ context_id: contextId })

  const supabase = createServiceClient()
  const now = new Date()
  const monthYear = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10)
  const monthEnd   = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10)

  let processed = 0
  const errors: string[] = []

  try {
    // Load all active agents across all brokerages
    const { data: agents, error: agentsErr } = await supabase
      .from("agents")
      .select("id, brokerage_id, commission_split")
      .eq("is_active", true)

    if (agentsErr) throw new Error(`Failed to load agents: ${agentsErr.message}`)

    for (const agent of agents ?? []) {
      try {
        // ── GCI from agent_commissions (the canonical, populated table) ──────
        // commission_records was never written (dead table) → this P&L showed $0.
        // GCI is recognized at CLOSE (close_date), not payout.
        // NET-PREFERENCE RULE (owner ruling 2026-08-28 — see
        // lib/finance/brokerage-earnings-writer.ts:foldCommissionRows): prefer
        // the STORED post-cap, post-fee net_to_agent / net_to_brokerage; fall
        // back to the GENERATED pre-cap split only for manually entered rows.
        // Post-cap the two disagree on purpose (agent keeps 100%, brokerage $0).
        const { data: commissions } = await supabase
          .from("agent_commissions")
          .select("gross_commission, agent_commission, net_to_agent, net_to_brokerage, close_date")
          .eq("agent_id", agent.id)
          .gte("close_date", `${monthStart}T00:00:00Z`)
          .lte("close_date", `${monthEnd}T23:59:59Z`)

        const gciGross    = commissions?.reduce((s, r) => s + (r.gross_commission ?? 0), 0) ?? 0
        const agentPayout = commissions?.reduce((s, r) => s + (r.net_to_agent ?? r.agent_commission ?? 0), 0) ?? 0
        const brokerageGross = commissions?.reduce(
          (s, r) => s + (r.net_to_brokerage ?? ((r.gross_commission ?? 0) - (r.agent_commission ?? 0))), 0) ?? 0
        const txCount = commissions?.length ?? 0

        // ── AI cost from ai_tool_usage ────────────────────────────────────────
        const { data: aiRows } = await supabase
          .from("ai_tool_usage")
          .select("cost_cents")
          .eq("agent_id", agent.id)
          .gte("created_at", `${monthStart}T00:00:00Z`)
          .lte("created_at", `${monthEnd}T23:59:59Z`)

        const aiCostCents = aiRows?.reduce((s, r) => s + (r.cost_cents ?? 0), 0) ?? 0

        // ── Fee income from agent_fee_charges ─────────────────────────────────
        const { data: fees } = await supabase
          .from("agent_fee_charges")
          .select("amount")
          .eq("agent_id", agent.id)
          .eq("status", "paid")
          .gte("paid_at", `${monthStart}T00:00:00Z`)
          .lte("paid_at", `${monthEnd}T23:59:59Z`)

        const feeIncomeCents = fees?.reduce((s, r) => s + Math.round((r.amount ?? 0) * 100), 0) ?? 0

        // ── Net margin ────────────────────────────────────────────────────────
        const netBrokerageMargin =
          brokerageGross
          - (aiCostCents / 100)
          + (feeIncomeCents / 100)

        // ── ROI multiple ──────────────────────────────────────────────────────
        const totalSpend = (aiCostCents + 0) / 100  // marketing_spend_cents future
        const roiMultiple = totalSpend > 0 ? gciGross / totalSpend : null

        await supabase
          .from("agent_pl_snapshot")
          .upsert({
            brokerage_id:          agent.brokerage_id,
            agent_id:              agent.id,
            month_year:            monthYear,
            gci_gross:             gciGross,
            agent_payout:          agentPayout,
            brokerage_gross:       brokerageGross,
            ai_cost_cents:         aiCostCents,
            fee_income_cents:      feeIncomeCents,
            marketing_spend_cents: 0,
            net_brokerage_margin:  netBrokerageMargin,
            roi_multiple:          roiMultiple,
            transaction_count:     txCount,
            computed_at:           now.toISOString(),
          }, { onConflict: "agent_id,month_year" })

        processed++
      } catch (err: any) {
        errors.push(`Agent ${agent.id}: ${err.message}`)
      }
    }

    // TEAM P&L ROLLUP — the team-level mirror of the per-agent snapshot above. team_earnings /
    // team_performance were READ by the reporting layer but never written (drift); this rolls up the
    // SAME canonical agent_commissions source over each team's members so team + agent numbers reconcile.
    let teamsWritten = 0
    try {
      const { runTeamPnlAll } = await import("@/lib/finance/team-pl-writer")
      const team = await runTeamPnlAll(supabase, now)
      teamsWritten = team.written
    } catch (err: any) {
      errors.push(`team-pl: ${err.message}`)
    }

    // BROKERAGE EARNINGS + P&L — the brokerage-level mirror (writer-less
    // burn-down): the money page read brokerage_earnings + brokerage_p_l but
    // nothing wrote them. Same canonical agent_commissions source, so
    // brokerage totals reconcile exactly with the agent + team snapshots.
    let brokerageRowsWritten = 0
    try {
      const { runBrokerageEarningsRollup } = await import("@/lib/finance/brokerage-earnings-writer")
      const bk = await runBrokerageEarningsRollup(supabase, now)
      brokerageRowsWritten = bk.rowsWritten
    } catch (err: any) {
      errors.push(`brokerage-earnings: ${err.message}`)
    }

    // USAGE METERING — folds the raw usage streams (usage_events / usage_logs /
    // ai_tool_usage) into meter_readings + cost_allocation, the two derived
    // tables the Billing Admin usage dashboard reads (writer-less until now —
    // the meter cards and 6-month trend chart rendered empty forever).
    let meterRows = 0
    try {
      const { runUsageMeteringRollup } = await import("@/lib/finance/usage-metering")
      const um = await runUsageMeteringRollup(supabase, now)
      meterRows = um.meterRows + um.allocationRows
    } catch (err: any) {
      errors.push(`usage-metering: ${err.message}`)
    }

    // DERIVED INTELLIGENCE SNAPSHOTS — property_smart_insights (DOM/price-cut/
    // market-position for the winning-offer AI) + team_heatmap_snapshots (geo
    // activity/revenue for the team heatmap) — both derive from tables this
    // wagon's sources already write (burn-down round 6).
    let snapshotRows = 0
    try {
      const { runDerivedSnapshots } = await import("@/lib/intelligence/derived-snapshots")
      const ds = await runDerivedSnapshots(supabase, now)
      snapshotRows = ds.insightsRows + ds.heatmapRows
    } catch (err: any) {
      errors.push(`derived-snapshots: ${err.message}`)
    }

    // SUBSCRIPTION WATCH — the platform's dunning/renewal engine: alert platform staff on every tenant
    // whose subscription needs a human (payment past due / trial expiring), deduped per tenant per day.
    let subscriptionAlerts = 0
    try {
      const { runSubscriptionWatch } = await import("@/lib/platform/subscription-oversight")
      const watch = await runSubscriptionWatch(supabase, now)
      subscriptionAlerts = watch.notified
    } catch (err: any) {
      errors.push(`subscription-watch: ${err.message}`)
    }

    await recordCronSuccessAction({
      context_id: contextId,
      records_processed: processed,
      metadata: { month_year: monthYear, teamsWritten, meterRows, snapshotRows, subscriptionAlerts, errors: errors.slice(0, 10) },
    })

    return NextResponse.json({ ok: true, monthYear, processed, teamsWritten, brokerageRowsWritten, meterRows, snapshotRows, subscriptionAlerts, errors })
  } catch (err: any) {
    await recordCronFailureAction({ context_id: contextId, error: err, stage: "main-processing" })
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 })
  }
}
