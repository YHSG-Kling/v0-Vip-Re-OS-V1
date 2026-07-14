"use client"

/**
 * BROKER PORTFOLIO PANEL (#7 + #9) — where to deploy agents/budget + the
 * rising/declining segment read, from the brokerage's own territory ROI.
 * Renders nothing when there are no proven-ZIP signals (honest empty).
 */

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { TrendingUp, AlertTriangle, Map } from "lucide-react"
import type { PortfolioRead } from "@/lib/intelligence/portfolio-intelligence"

export function BrokerPortfolioPanel({ read }: { read: PortfolioRead | null }) {
  if (!read || (read.strategy.length === 0 && read.riskOps.length === 0)) return null
  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base font-semibold">
          <Map className="h-4 w-4 text-indigo-600" />
          Portfolio strategy — where to deploy
        </CardTitle>
        <p className="text-xs text-muted-foreground">From your own territory ROI across {read.zips} ZIPs · last {read.windowDays} days</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {read.strategy.map((m) => (
          <div key={m.key} className="rounded-md border-l-4 border-indigo-400 bg-indigo-50/60 dark:bg-indigo-950/20 p-3">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="h-3.5 w-3.5 text-indigo-600" />
              {m.zip && <Badge variant="outline" className="text-xs">{m.zip}</Badge>}
            </div>
            <p className="text-sm">{m.line}</p>
          </div>
        ))}
        {read.riskOps.filter((r) => r.kind === "risk").slice(0, 2).map((r, i) => (
          <div key={i} className="rounded-md border-l-4 border-amber-400 bg-amber-50/60 dark:bg-amber-950/20 p-3">
            <div className="flex items-center gap-2 mb-1">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-600" />
              <Badge variant="outline" className="text-xs">{r.zip}</Badge>
            </div>
            <p className="text-sm">{r.line}</p>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}
