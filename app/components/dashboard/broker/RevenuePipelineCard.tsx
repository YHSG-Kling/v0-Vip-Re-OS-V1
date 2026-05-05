"use client"

/**
 * RevenuePipelineCard — broker dashboard widget that renders the 30/60/90-day
 * weighted GCI projection from getRevenuePipelineProjectionAction. Designed
 * to slot into the existing broker dashboard grid without a layout shift.
 */

import { useEffect, useState } from "react"
import { Loader2, TrendingUp } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { getRevenuePipelineProjectionAction } from "@/app/actions/revenue-pipeline"

const fmt = (n: number) => `$${Math.round(n).toLocaleString()}`

export function RevenuePipelineCard() {
  const [projection, setProjection] = useState<Awaited<
    ReturnType<typeof getRevenuePipelineProjectionAction>
  > | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    getRevenuePipelineProjectionAction()
      .then((r) => !cancelled && setProjection(r))
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <TrendingUp className="h-4 w-4 text-emerald-600" />
          Revenue pipeline (weighted GCI)
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Computing pipeline…
          </div>
        ) : !projection?.success ? (
          <p className="text-xs text-destructive">{projection?.error ?? "Unavailable"}</p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              {projection.projection.windows.map((w) => (
                <div key={w.windowDays} className="rounded-md border p-2.5">
                  <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
                    Next {w.windowDays}d
                  </p>
                  <p className="font-bold text-lg">{fmt(w.weightedGci)}</p>
                  <p className="text-[11px] text-muted-foreground">
                    {w.dealCount} deals • raw {fmt(w.rawGci)}
                  </p>
                </div>
              ))}
            </div>

            <div className="rounded-md border">
              <p className="px-2.5 py-1.5 text-[11px] uppercase tracking-wide text-muted-foreground border-b">
                Top stages — 60d
              </p>
              <ul className="divide-y">
                {projection.projection.windows[1].byStage.slice(0, 5).map((s) => (
                  <li
                    key={s.stage}
                    className="px-2.5 py-1.5 flex justify-between items-center text-xs"
                  >
                    <span className="capitalize">{s.stage.replace(/_/g, " ")}</span>
                    <span className="font-medium">
                      {s.count} • {fmt(s.weightedGci)}
                    </span>
                  </li>
                ))}
                {projection.projection.windows[1].byStage.length === 0 && (
                  <li className="px-2.5 py-2 text-xs text-muted-foreground">
                    No active pipeline in window.
                  </li>
                )}
              </ul>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
