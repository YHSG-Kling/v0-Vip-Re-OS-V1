"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { TrendingUp, Wallet, Home, Sparkles, Loader2 } from "lucide-react"
import { getMyPLTrendAction, type MyPLResult } from "@/app/actions/agent-pl"

const fmt = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n)
const monthLabel = (my: string) => {
  const [y, m] = my.split("-")
  return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString("en-US", { month: "short" })
}

/**
 * AGENT P&L SELF-SERVICE — the agent's own monthly profit-and-loss (previously broker-only). Shows
 * YTD production, take-home, deals, and the ROI of their AI tools, plus a 12-month trend.
 */
export function MyProfitLossPanel() {
  const [data, setData] = useState<MyPLResult | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getMyPLTrendAction({ months: 12 }).then((res) => {
      if (res.success) setData(res.data)
      setLoading(false)
    })
  }, [])

  if (loading) {
    return <Card><CardContent className="p-6 flex items-center gap-2 text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Building your P&L…</CardContent></Card>
  }
  if (!data || data.rows.length === 0) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base flex items-center gap-2"><TrendingUp className="h-4 w-4 text-indigo-600" /> My P&L</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">Your monthly P&L appears here once you have a closed deal. It updates automatically every night.</CardContent>
      </Card>
    )
  }

  const { ytd, rows } = data
  const maxGci = Math.max(1, ...rows.map((r) => r.gciGross))

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2"><TrendingUp className="h-4 w-4 text-indigo-600" /> My P&L · {new Date().getFullYear()} YTD</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Stat icon={<TrendingUp className="h-4 w-4 text-emerald-600" />} label="GCI produced" value={fmt(ytd.gciGross)} />
          <Stat icon={<Wallet className="h-4 w-4 text-green-600" />} label="Take-home" value={fmt(ytd.agentPayout)} />
          <Stat icon={<Home className="h-4 w-4 text-sky-600" />} label="Deals closed" value={String(ytd.transactionCount)} />
          <Stat
            icon={<Sparkles className="h-4 w-4 text-purple-600" />}
            label="AI-tool ROI"
            value={ytd.aiRoiMultiple != null ? `${ytd.aiRoiMultiple}×` : "—"}
            sub={ytd.aiCostCents > 0 ? `${fmt(ytd.aiCostCents / 100)} cost` : "no AI cost yet"}
          />
        </div>

        <div>
          <p className="text-xs text-muted-foreground mb-2">Monthly GCI (last {rows.length} months)</p>
          <div className="flex items-end gap-1.5 h-24">
            {rows.map((r) => (
              <div key={r.monthYear} className="flex-1 flex flex-col items-center gap-1" title={`${r.monthYear}: ${fmt(r.gciGross)} · ${r.transactionCount} deals`}>
                <div className="w-full rounded-t bg-indigo-500/80" style={{ height: `${Math.max(2, (r.gciGross / maxGci) * 100)}%` }} />
                <span className="text-[10px] text-muted-foreground">{monthLabel(r.monthYear)}</span>
              </div>
            ))}
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">Updated nightly. AI-tool ROI = GCI produced per $1 of AI-tool cost — proof the platform pays for itself.</p>
      </CardContent>
    </Card>
  )
}

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">{icon}{label}</div>
      <div className="text-lg font-semibold mt-1">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  )
}
