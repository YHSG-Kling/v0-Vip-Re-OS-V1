"use client"

/**
 * MARKET ALERTS — the alert engine nothing could reach.
 *
 * `app/actions/ai-market-intelligence.ts:getMarketAlerts` reads the agent's own
 * `specializations` and the most recent `market_data` rows and returns
 * prioritised alerts (price changes, new-listing openings, condition shifts,
 * opportunities, warnings) plus a one-line market snapshot. It was complete,
 * authenticated and tenant-anchored — and called from nowhere, so no screen in
 * the product ever told an agent that their market had moved.
 *
 * Its two siblings in that file already have surfaces (generateMarketReport on
 * the agent superpowers panel, analyzeNeighborhood on the listing neighbourhood
 * report). This is the third.
 *
 * Nothing here is computed client-side. Every alert and every number on screen
 * came back from getMarketAlerts. Alerts are a MODEL READING of recent market
 * data, not a measurement, and the panel says so rather than presenting them as
 * observed fact.
 */

import { useState, useTransition } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { AlertTriangle, Bell, Loader2, TrendingUp, Lightbulb, Home, RefreshCw } from "lucide-react"
import { getMarketAlerts } from "@/app/actions/ai-market-intelligence"

interface MarketAlert {
  type: "price_change" | "new_listing" | "market_shift" | "opportunity" | "warning"
  priority: "high" | "medium" | "low"
  title: string
  description: string
  area: string
  actionRequired: boolean
  suggestedAction?: string
  expiresAt?: string
}

interface Snapshot {
  overallTrend: string
  keyMetric: string
  comparedToLastMonth: string
}

const TYPE_ICON = {
  price_change: TrendingUp,
  new_listing: Home,
  market_shift: TrendingUp,
  opportunity: Lightbulb,
  warning: AlertTriangle,
} as const

const PRIORITY_VARIANT: Record<string, "destructive" | "default" | "secondary"> = {
  high: "destructive",
  medium: "default",
  low: "secondary",
}

export function MarketAlertsPanel({ agentId }: { agentId: string }) {
  const [alerts, setAlerts] = useState<MarketAlert[] | null>(null)
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const run = () => {
    setError(null)
    startTransition(async () => {
      const result = await getMarketAlerts({ agentId })
      if (!result.success) {
        // A refusal has a reason — no agent profile, an agent outside this
        // brokerage, a blocked read. Showing "no alerts" for any of those would
        // be a lie about the market.
        setError((result as { error?: string }).error ?? "Could not generate market alerts.")
        setAlerts(null)
        setSnapshot(null)
        return
      }
      setAlerts(((result as { alerts?: MarketAlert[] }).alerts ?? []) as MarketAlert[])
      setSnapshot(((result as { snapshot?: Snapshot }).snapshot ?? null) as Snapshot | null)
    })
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bell className="h-4 w-4" />
            Market alerts
          </CardTitle>
          <CardDescription>
            Read against your specializations and the most recent market data on file.
          </CardDescription>
        </div>
        <Button size="sm" variant="outline" onClick={run} disabled={isPending || !agentId}>
          {isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="mr-2 h-3.5 w-3.5" />}
          {alerts ? "Refresh" : "Check my markets"}
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {!agentId && (
          <p className="text-sm text-muted-foreground">
            No agent profile is linked to this account yet, so there is no specialization list to check alerts against.
          </p>
        )}

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {snapshot && (
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            <p className="font-medium">{snapshot.overallTrend}</p>
            <p className="text-muted-foreground">
              {snapshot.keyMetric} · vs last month: {snapshot.comparedToLastMonth}
            </p>
          </div>
        )}

        {alerts && alerts.length === 0 && !error && (
          <p className="text-sm text-muted-foreground">
            No alerts came back for your markets on the data currently on file.
          </p>
        )}

        {alerts?.map((alert, i) => {
          const Icon = TYPE_ICON[alert.type] ?? Bell
          return (
            <div key={`${alert.title}-${i}`} className="rounded-md border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="text-sm font-medium">{alert.title}</span>
                <Badge variant={PRIORITY_VARIANT[alert.priority] ?? "secondary"} className="text-[10px] uppercase">
                  {alert.priority}
                </Badge>
                {alert.actionRequired && (
                  <Badge variant="outline" className="text-[10px]">Action needed</Badge>
                )}
                {alert.area && <span className="text-xs text-muted-foreground">{alert.area}</span>}
              </div>
              <p className="mt-1.5 text-sm text-muted-foreground">{alert.description}</p>
              {alert.suggestedAction && (
                <p className="mt-1.5 text-xs">
                  <span className="font-medium">Suggested: </span>
                  {alert.suggestedAction}
                </p>
              )}
            </div>
          )
        })}

        {alerts && alerts.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            These are an AI reading of the market data on file, not measured events. Verify before acting on a client's behalf.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
