"use client"

import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { TrendingUp, Brain, DollarSign, AlertTriangle } from "lucide-react"
import type { AgentPLRow } from "@/app/actions/pl-truth-engine"

interface Props {
  rows: AgentPLRow[]
  monthYear: string
}

function fmt(val: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  }).format(val)
}

function fmtCents(cents: number) {
  return fmt(cents / 100)
}

function roiBadge(roi: number | null) {
  if (roi == null) return <span className="text-muted-foreground text-xs">—</span>
  if (roi >= 50)  return <Badge className="bg-emerald-100 text-emerald-800 text-xs">{roi.toFixed(0)}x</Badge>
  if (roi >= 10)  return <Badge className="bg-blue-100 text-blue-800 text-xs">{roi.toFixed(0)}x</Badge>
  if (roi >= 1)   return <Badge className="bg-amber-100 text-amber-800 text-xs">{roi.toFixed(1)}x</Badge>
  return <Badge className="bg-red-100 text-red-800 text-xs">{roi.toFixed(1)}x</Badge>
}

export function AgentPLTable({ rows, monthYear }: Props) {
  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6 text-center text-sm text-muted-foreground">
          No agent P&amp;L data for {monthYear}. Run the nightly brokerage-pl-rollup cron to populate.
        </CardContent>
      </Card>
    )
  }

  const totals = rows.reduce(
    (acc, r) => ({
      gci:     acc.gci     + r.gci_gross,
      payout:  acc.payout  + r.agent_payout,
      margin:  acc.margin  + r.net_brokerage_margin,
      aiCost:  acc.aiCost  + r.ai_cost_cents,
      txCount: acc.txCount + r.transaction_count,
    }),
    { gci: 0, payout: 0, margin: 0, aiCost: 0, txCount: 0 },
  )

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <DollarSign className="h-4 w-4 text-emerald-600" />
          Agent P&amp;L Truth — {monthYear}
          <span className="ml-auto text-xs font-normal text-muted-foreground">
            {rows.length} agents · {totals.txCount} transactions
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        {/* Summary strip */}
        <div className="grid grid-cols-4 divide-x border-b bg-muted/20">
          <div className="px-4 py-3">
            <p className="text-xs text-muted-foreground">Total GCI</p>
            <p className="text-lg font-bold">{fmt(totals.gci)}</p>
          </div>
          <div className="px-4 py-3">
            <p className="text-xs text-muted-foreground">Agent Payouts</p>
            <p className="text-lg font-bold text-slate-600">{fmt(totals.payout)}</p>
          </div>
          <div className="px-4 py-3">
            <p className="text-xs text-muted-foreground">AI Spend</p>
            <p className="text-lg font-bold text-purple-700">{fmtCents(totals.aiCost)}</p>
          </div>
          <div className="px-4 py-3">
            <p className="text-xs text-muted-foreground">Net Brokerage Margin</p>
            <p className={`text-lg font-bold ${totals.margin >= 0 ? "text-emerald-700" : "text-red-600"}`}>
              {fmt(totals.margin)}
            </p>
          </div>
        </div>

        {/* Per-agent table */}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/10">
                <th className="text-left px-4 py-2 font-medium text-muted-foreground">Agent</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">GCI</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">To Agent</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">Brokerage Gross</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground flex items-center justify-end gap-1">
                  <Brain className="h-3 w-3 text-purple-500" />AI Cost
                </th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">Marketing</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">Net Margin</th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">
                  <TrendingUp className="inline h-3 w-3 text-emerald-500 mr-1" />
                  AI ROI
                </th>
                <th className="text-right px-4 py-2 font-medium text-muted-foreground">Txns</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(r => {
                const marginNegative = r.net_brokerage_margin < 0
                return (
                  <tr key={r.agent_id} className="border-b last:border-0 hover:bg-muted/10">
                    <td className="px-4 py-2.5 font-medium">
                      {r.agent_name}
                      {r.gci_gross === 0 && (
                        <Badge variant="outline" className="ml-2 text-xs text-slate-400">no closed txns</Badge>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right">{fmt(r.gci_gross)}</td>
                    <td className="px-4 py-2.5 text-right text-slate-600">{fmt(r.agent_payout)}</td>
                    <td className="px-4 py-2.5 text-right">{fmt(r.brokerage_gross)}</td>
                    <td className="px-4 py-2.5 text-right text-purple-700 text-xs">
                      {r.ai_cost_cents > 0 ? fmtCents(r.ai_cost_cents) : <span className="text-muted-foreground">—</span>}
                    </td>
                    {/* marketing_spend_cents is booked 0 by the rollup until
                        campaign attribution lands — an honest dash, never a
                        confident $0 that reads as "measured and free". */}
                    <td className="px-4 py-2.5 text-right text-xs">
                      {r.marketing_spend_cents > 0 ? fmtCents(r.marketing_spend_cents) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td className={`px-4 py-2.5 text-right font-semibold ${marginNegative ? "text-red-600" : "text-emerald-700"}`}>
                      {marginNegative && <AlertTriangle className="inline h-3 w-3 mr-1" />}
                      {fmt(r.net_brokerage_margin)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {roiBadge(r.roi_multiple)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-muted-foreground">
                      {r.transaction_count}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted-foreground px-4 py-2 border-t">
          Net margin = brokerage gross − AI spend + fee income. AI ROI = GCI ÷ AI spend. Updated nightly.
        </p>
      </CardContent>
    </Card>
  )
}
