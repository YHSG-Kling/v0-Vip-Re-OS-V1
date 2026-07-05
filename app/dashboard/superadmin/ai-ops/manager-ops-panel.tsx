'use client'

// Per-manager cost / latency (p95) / error-rate + SLO — the operability view of the 13 AI
// managers. Staff-gated server-side. A 'breach' means one manager is over its cost, p95, or
// error-rate ceiling in the window — surfaced before it becomes a bill or an outage.
import { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Gauge, Loader2 } from 'lucide-react'
import { getManagerOpsAction } from '@/app/actions/superadmin/ai-ops'
import type { ManagerOps, SloStatus } from '@/lib/platform/manager-ops'

const sloBadge: Record<SloStatus, string> = {
  ok: 'bg-emerald-100 text-emerald-800',
  warn: 'bg-amber-100 text-amber-800',
  breach: 'bg-red-100 text-red-800',
}

export function ManagerOpsPanel() {
  const [data, setData] = useState<ManagerOps | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    getManagerOpsAction(24).then((r) => { if (r.ok) setData(r.data); else setErr(r.error); setLoading(false) })
  }, [])

  const money = (cents: number) => `$${(cents / 100).toFixed(2)}`

  return (
    <Card>
      <CardHeader className="pb-3 flex-row items-center justify-between">
        <CardTitle className="text-sm flex items-center gap-2"><Gauge className="h-4 w-4 text-primary" />Manager cost / latency / SLO (24h)</CardTitle>
        {data && (
          <span className="text-xs text-muted-foreground">
            {money(data.summary.totalCostCents)} · {data.summary.totalCalls.toLocaleString()} calls
            {data.summary.breaching > 0 && <Badge className="ml-2 text-[10px] bg-red-100 text-red-800">{data.summary.breaching} breaching</Badge>}
            {data.summary.warning > 0 && <Badge className="ml-2 text-[10px] bg-amber-100 text-amber-800">{data.summary.warning} warning</Badge>}
          </span>
        )}
      </CardHeader>
      <CardContent className="p-0">
        {err && <p className="p-4 text-xs text-red-600">{err}</p>}
        {loading ? (
          <p className="p-4 text-sm text-muted-foreground flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" />Loading…</p>
        ) : !data || data.managers.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No AI-model usage in the window yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-muted/10 text-left text-xs text-muted-foreground">
                <th className="px-4 py-2">Manager</th><th className="px-4 py-2 text-right">Cost</th><th className="px-4 py-2 text-right">Calls</th>
                <th className="px-4 py-2 text-right">p95</th><th className="px-4 py-2 text-right">Errors</th><th className="px-4 py-2 text-right">SLO</th>
              </tr></thead>
              <tbody>
                {data.managers.map((m) => (
                  <tr key={m.manager} className="border-b last:border-0">
                    <td className="px-4 py-2 font-medium">{m.manager}</td>
                    <td className="px-4 py-2 text-right">{money(m.costCents)}</td>
                    <td className="px-4 py-2 text-right">{m.calls.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right">{m.p95Ms ? `${(m.p95Ms / 1000).toFixed(1)}s` : '—'}</td>
                    <td className="px-4 py-2 text-right">{(m.errorRate * 100).toFixed(0)}%</td>
                    <td className="px-4 py-2 text-right"><span className={'rounded px-1.5 py-0.5 text-[11px] font-medium ' + sloBadge[m.slo]}>{m.slo}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
