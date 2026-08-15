"use client"

/**
 * <IncomeForecastCard> — the agent's calibrated 30/60/90 GCI projection.
 *
 * Composed of:
 *   - Pipeline-weighted forecast (open deals × stage probability)
 *   - Sphere-referral expected value (from Lifetime Customer NPV scores)
 *   - Confidence bands (low / high)
 *
 * The only RE app on the market that can produce a calibrated income
 * forecast for the agent's actual year. Renders nothing until the cron
 * has produced a snapshot; first-run state offers a "Run forecast"
 * button that POSTs to the rollup cron.
 */

import { useState } from "react"
import { useRouter } from "next/navigation"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Loader2,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  CalendarRange,
} from "lucide-react"
import { toast } from "sonner"
import { cn } from "@/lib/utils"
import {
  rescanLifetimeNpvForecastAction,
  type AgentIncomeForecast,
} from "@/app/actions/lifetime-npv"

interface Props {
  data:        AgentIncomeForecast | null
  brokerageId: string
  agentUserId: string
}

function formatUsd(n: number | null | undefined): string {
  if (n == null) return "—"
  return `$${Math.round(n).toLocaleString()}`
}

export function IncomeForecastCard({ data, brokerageId, agentUserId }: Props) {
  const router = useRouter()
  const [refreshing, setRefreshing] = useState(false)

  async function handleRefresh() {
    if (refreshing) return
    setRefreshing(true)
    try {
      const r = await rescanLifetimeNpvForecastAction({ brokerageId, agentId: agentUserId })
      if (r.success) {
        toast.success("Income forecast updated")
        router.refresh()
      } else {
        toast.error(r.error ?? "Refresh failed")
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Refresh failed")
    } finally {
      setRefreshing(false)
    }
  }

  if (!data) {
    return (
      <Card className="border-sky-200 bg-gradient-to-br from-sky-50 to-white">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarRange className="h-4 w-4 text-sky-600" />
              Income Forecast (30 / 60 / 90)
            </CardTitle>
            <Button size="sm" variant="outline" disabled={refreshing} onClick={handleRefresh} className="h-7 text-xs gap-1.5">
              {refreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              Run first forecast
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Pipeline × stage probability + sphere-referral expected value. Once the cron runs you&apos;ll see what you can expect to close in the next 30, 60, and 90 days.
          </p>
        </CardHeader>
      </Card>
    )
  }

  const trend = data.weighted90Delta != null && data.weighted90Delta !== 0
    ? data.weighted90Delta > 0
      ? { icon: <TrendingUp className="h-3 w-3" />, color: "text-emerald-700" }
      : { icon: <TrendingDown className="h-3 w-3" />, color: "text-red-700" }
    : null

  const total90Low  = Math.round(data.totalForecast90 * (1 - data.lowBandPct  / 100))
  const total90High = Math.round(data.totalForecast90 * (1 + data.highBandPct / 100))

  return (
    <Card className="border-sky-200 bg-gradient-to-br from-sky-50 via-white to-white">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <CalendarRange className="h-4 w-4 text-sky-600" />
            Income Forecast (30 / 60 / 90)
          </CardTitle>
          <Button size="sm" variant="ghost" disabled={refreshing} onClick={handleRefresh} className="h-7 text-xs gap-1.5">
            {refreshing ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
            Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Headline — 90-day total with confidence range */}
        <div>
          <p className="text-[11px] text-muted-foreground uppercase tracking-wide">90-day forecast (pipeline + sphere referrals)</p>
          <div className="flex items-baseline gap-3 mt-0.5">
            <p className="text-3xl font-bold text-sky-900 tabular-nums">{formatUsd(data.totalForecast90)}</p>
            {trend && data.weighted90Delta != null && (
              <span className={cn("inline-flex items-center gap-0.5 text-xs font-medium", trend.color)}>
                {trend.icon}
                {data.weighted90Delta > 0 ? "+" : ""}{Math.round(data.weighted90Delta / 1000)}k
              </span>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground mt-0.5">
            Range: <span className="tabular-nums">{formatUsd(total90Low)}</span> — <span className="tabular-nums">{formatUsd(total90High)}</span>
          </p>
        </div>

        {/* 30 / 60 / 90 columns */}
        <div className="grid grid-cols-3 gap-3 border-t pt-3">
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Next 30d</p>
            <p className="text-xl font-semibold tabular-nums mt-0.5">{formatUsd(data.weighted30)}</p>
            <p className="text-[10px] text-muted-foreground">{data.byStage.filter((s) => ["under_contract","pending","clear_to_close","closing_prep","financing","appraisal","inspection"].includes(s.stage)).length} closing-stage</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Next 60d</p>
            <p className="text-xl font-semibold tabular-nums mt-0.5">{formatUsd(data.weighted60)}</p>
          </div>
          <div>
            <p className="text-[10px] text-muted-foreground uppercase tracking-wide">Next 90d</p>
            <p className="text-xl font-semibold tabular-nums mt-0.5">{formatUsd(data.weighted90)}</p>
            <p className="text-[10px] text-muted-foreground">{data.dealCount} open · {data.activeListingCount} listings</p>
          </div>
        </div>

        {/* Sphere contribution callout */}
        {data.sphereReferralExpected > 0 && (
          <p className="text-[11px] text-sky-900 bg-sky-50 rounded-md px-2 py-1.5 border border-sky-100">
            <strong>+{formatUsd(data.sphereReferralExpected)}</strong> in expected sphere referrals over 90d (from your Lifetime Customer NPV scores).
          </p>
        )}

        <p className="text-[10px] text-muted-foreground text-right">
          As of {new Date(data.computedAt).toLocaleString()}
        </p>
      </CardContent>
    </Card>
  )
}
