// lib/finance/brokerage-earnings-writer.ts
// ─────────────────────────────────────────────────────────────────────────────
// BROKERAGE EARNINGS + P&L ROLLUP (writer-less burn-down, campaign 1).
// The brokerage financials page reads brokerage_earnings (mtd/ytd) and
// brokerage_p_l — both writer-less until now, so the broker's money page
// rendered zeros forever. This rolls up the SAME canonical source as the
// per-agent and team snapshots (agent_commissions, never transactions math)
// so brokerage totals reconcile EXACTLY with agent and team numbers.
//
// HONEST NULLS: office/tech/marketing operating expenses have no ledger source
// yet — they stay NULL and net_profit is GCI minus agent splits (the true
// brokerage-side number the ledger can prove), never a fabricated expense line.

import "server-only"

type Svc = { from: (table: string) => any }

interface CommissionRow {
  gross_commission: number | null
  agent_commission: number | null
  transaction_id: string | null
  agent_id: string
  close_date: string | null
}

export interface BrokerageEarningsResult { brokerages: number; rowsWritten: number }

function fold(rows: CommissionRow[]) {
  const gci = rows.reduce((s, r) => s + (Number(r.gross_commission) || 0), 0)
  const splits = rows.reduce((s, r) => s + (Number(r.agent_commission) || 0), 0)
  return {
    gci,
    splits,
    net: gci - splits,
    txCount: new Set(rows.map((r) => r.transaction_id).filter(Boolean)).size,
    agentCount: new Set(rows.map((r) => r.agent_id)).size,
  }
}

export async function runBrokerageEarningsRollup(svc: Svc, now: Date = new Date()): Promise<BrokerageEarningsResult> {
  const out: BrokerageEarningsResult = { brokerages: 0, rowsWritten: 0 }
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
  const yearStart = new Date(now.getFullYear(), 0, 1).toISOString()
  const monthLabel = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`

  const { data: brokerages } = await svc.from("brokerages").select("id").limit(2000)
  for (const b of ((brokerages ?? []) as Array<{ id: string }>)) {
    try {
      const { data: ytdRows } = await svc
        .from("agent_commissions")
        .select("gross_commission, agent_commission, transaction_id, agent_id, close_date")
        .eq("brokerage_id", b.id)
        .gte("close_date", yearStart)
        .limit(5000)
      const ytd = (ytdRows ?? []) as CommissionRow[]
      if (ytd.length === 0) continue // honest empty — no rows means the page shows its empty state
      out.brokerages++

      const mtd = ytd.filter((r) => (r.close_date ?? "") >= monthStart)
      const periods: Array<{ period_type: string; period_label: string; f: ReturnType<typeof fold> }> = [
        // live CHECK vocabulary: monthly / quarterly / annual (caught by fire —
        // 'mtd'/'ytd' can never exist; the page reads were fixed to match)
        { period_type: "monthly", period_label: monthLabel, f: fold(mtd) },
        { period_type: "annual", period_label: String(now.getFullYear()), f: fold(ytd) },
      ]

      // No unique index exists on (brokerage_id, period_type) — pass-10 rule:
      // never point an onConflict at a unique that isn't there. Delete-then-insert.
      await svc.from("brokerage_earnings").delete().eq("brokerage_id", b.id)
      const { error: earnErr } = await svc.from("brokerage_earnings").insert(periods.map((p) => ({
        brokerage_id: b.id,
        period_type: p.period_type,
        period_label: p.period_label,
        gross_commission_income: p.f.gci,
        agent_splits_paid: p.f.splits,
        brokerage_net: p.f.net,
        transaction_count: p.f.txCount,
        active_agent_count: p.f.agentCount,
        computed_at: now.toISOString(),
      })))
      if (!earnErr) out.rowsWritten += periods.length

      // brokerage_p_l — one row per month; expenses stay NULL until a ledger
      // source exists (never fabricated), so net_profit = brokerage-side net.
      const m = periods[0].f
      await svc.from("brokerage_p_l").delete().eq("brokerage_id", b.id).eq("period_label", monthLabel)
      const { error: plErr } = await svc.from("brokerage_p_l").insert({
        brokerage_id: b.id,
        period_label: monthLabel,
        gross_commission_income: m.gci,
        agent_splits_paid: m.splits,
        net_profit: m.net,
        profit_margin_pct: m.gci > 0 ? Math.round((m.net / m.gci) * 1000) / 10 : null,
        marketing_expenses: null,
        office_expenses: null,
        operating_expenses: null,
        tech_expenses: null,
        computed_at: now.toISOString(),
      })
      if (!plErr) out.rowsWritten++
    } catch { /* per-brokerage isolation — one tenant's failure never blocks the fleet */ }
  }
  return out
}
