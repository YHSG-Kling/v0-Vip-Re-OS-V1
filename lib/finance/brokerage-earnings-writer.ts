// lib/finance/brokerage-earnings-writer.ts
// ─────────────────────────────────────────────────────────────────────────────
// BROKERAGE EARNINGS + P&L ROLLUP (writer-less burn-down, campaign 1).
// The brokerage financials page reads brokerage_earnings (mtd/ytd) and
// brokerage_p_l — both writer-less until now, so the broker's money page
// rendered zeros forever. This rolls up the SAME canonical source as the
// per-agent and team snapshots (agent_commissions, never transactions math)
// so brokerage totals reconcile EXACTLY with agent and team numbers.
//
// EXPENSE FOLD (l72_s10): business_expenses now carries brokerage- and
// team-scoped rows (logged via logScopedExpense on the brokerage money page).
// OWNER RULE: team financials do NOT roll up to brokerage financials — only
// BROKERAGE-scoped rows (agent_id NULL AND team_id NULL) fold into the P&L
// buckets by category (marketing/office/technology→tech, rest→operating) and
// subtract from net_profit. Team expenses stay on the team's own book. When a
// tenant has logged NOTHING, the buckets stay honest-NULL and net_profit
// remains GCI minus splits — never a fabricated 0 pretending expenses were
// tracked.

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

      // brokerage_p_l — one row per month. Fold ONLY brokerage-scoped expenses
      // (agent_id NULL AND team_id NULL — owner rule: team financials never
      // roll up to brokerage). Zero logged rows keeps honest-NULL buckets.
      const m = periods[0].f
      const { data: expRows } = await svc
        .from("business_expenses")
        .select("category, amount")
        .eq("brokerage_id", b.id)
        .is("agent_id", null)
        .is("team_id", null)
        .gte("expense_date", monthStart.slice(0, 10))
        .limit(5000)
      const exp = (expRows ?? []) as Array<{ category: string | null; amount: number | null }>
      const bucket = { marketing: 0, office: 0, tech: 0, operating: 0 }
      for (const e of exp) {
        const amt = Number(e.amount) || 0
        const cat = (e.category ?? "").toLowerCase()
        if (cat === "marketing" || cat === "advertising") bucket.marketing += amt
        else if (cat === "office") bucket.office += amt
        else if (cat === "technology" || cat === "tech") bucket.tech += amt
        else bucket.operating += amt // education / transportation / other → operating
      }
      const totalExpenses = bucket.marketing + bucket.office + bucket.tech + bucket.operating
      const tracked = exp.length > 0
      const netProfit = m.net - (tracked ? totalExpenses : 0)
      await svc.from("brokerage_p_l").delete().eq("brokerage_id", b.id).eq("period_label", monthLabel)
      const { error: plErr } = await svc.from("brokerage_p_l").insert({
        brokerage_id: b.id,
        period_label: monthLabel,
        gross_commission_income: m.gci,
        agent_splits_paid: m.splits,
        net_profit: netProfit,
        profit_margin_pct: m.gci > 0 ? Math.round((netProfit / m.gci) * 1000) / 10 : null,
        marketing_expenses: tracked ? bucket.marketing : null,
        office_expenses: tracked ? bucket.office : null,
        operating_expenses: tracked ? bucket.operating : null,
        tech_expenses: tracked ? bucket.tech : null,
        computed_at: now.toISOString(),
      })
      if (!plErr) out.rowsWritten++
    } catch { /* per-brokerage isolation — one tenant's failure never blocks the fleet */ }
  }
  return out
}
