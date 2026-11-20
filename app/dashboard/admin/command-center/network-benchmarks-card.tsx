"use client"

// Wave 107F — PRIVACY-SAFE NETWORK BENCHMARKS beside this brokerage's own numbers. Reads through
// app/actions/network-intelligence.ts (session tenant, tenant-admin gated). Network cells are k-anonymous
// aggregates of OPTED-IN brokerages only; nothing here names or reveals another brokerage.

import { useEffect, useState, useTransition } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { getNetworkBenchmarksBeside, setNetworkBenchmarksOptIn } from "@/app/actions/network-intelligence"

type View = Extract<Awaited<ReturnType<typeof getNetworkBenchmarksBeside>>, { ok: true }>

const pct = (r: number | null | undefined) => (r === null || r === undefined ? "—" : `${(r * 100).toFixed(1)}%`)

export function NetworkBenchmarksCard() {
  const [view, setView] = useState<View | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, start] = useTransition()
  const load = () => start(async () => {
    const r = await getNetworkBenchmarksBeside()
    if (r.ok) { setView(r); setError(null) } else setError(r.error)
  })
  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const toggle = () => start(async () => {
    const r = await setNetworkBenchmarksOptIn({ optIn: !view?.optedIn })
    if (!r.ok) setError(r.error)
    else load()
  })
  if (error && !view) return null
  return (
    <section className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Network benchmarks — you vs. the network</h2>
        <span className="text-xs text-muted-foreground">
          {view ? `${view.marketBand.replace(/_/g, " ")} · cells need ≥ ${view.minTenants} brokerages and ≥ ${view.minEvents} events${view.periodEnd ? ` · as of ${view.periodEnd}` : " · not published yet"}` : "loading…"}
        </span>
      </div>
      <Card className="p-3 space-y-2">
        <div className="flex items-center justify-between gap-2 text-xs">
          <span>{view?.optedIn ? "You contribute anonymized aggregates (no records, no names)." : "You are not contributing. You still see the network benchmarks."}</span>
          <Button size="sm" variant="outline" disabled={pending || !view} onClick={toggle}>{view?.optedIn ? "Stop contributing" : "Contribute anonymized aggregates"}</Button>
        </div>
        {error && <div className="text-xs text-red-700">{error}</div>}
        {view && view.rows.length === 0 ? <div className="text-xs text-muted-foreground">No measurable activity yet.</div> : view?.rows.slice(0, 24).map((r) => (
          <div key={`${r.metric}|${r.segment}`} className="flex justify-between gap-2 text-xs">
            <span className="truncate">{r.metric.replace(/_/g, " ")} · {r.segment}</span>
            <span className="tabular-nums">you {pct(r.own?.rate)}{r.own ? ` (n=${r.own.sample})` : ""} · network {r.network ? `${pct(r.network.rate)} (${r.network.tenantCount} brokerages)` : "suppressed"}</span>
          </div>
        ))}
      </Card>
    </section>
  )
}
