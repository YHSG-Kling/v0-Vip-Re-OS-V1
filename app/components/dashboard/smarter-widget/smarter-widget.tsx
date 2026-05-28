"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Sparkles, TrendingUp, TrendingDown, Minus, ArrowRight } from "lucide-react"
import { getSmarterThisWeek, type SmarterDigest, type SmarterMetric } from "@/app/actions/smarter-this-week"

/**
 * Compact widget that surfaces this week's AI-driven improvements.
 * Mounts on agent dashboard. Auto-loads on mount, light footprint.
 */
export function SmarterWidget() {
  const [digest, setDigest] = useState<SmarterDigest | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getSmarterThisWeek()
      .then(setDigest)
      .finally(() => setLoading(false))
  }, [])

  if (loading) return null
  if (!digest || digest.metrics.length === 0) return null

  return (
    <Card className="border-purple-200 bg-gradient-to-br from-purple-50/40 to-blue-50/30">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-full bg-purple-100 flex items-center justify-center">
              <Sparkles className="h-4 w-4 text-purple-600" />
            </div>
            <div>
              <CardTitle className="text-base">Smarter This Week</CardTitle>
              {digest.highlight && (
                <p className="text-xs text-foreground mt-0.5">{digest.highlight}</p>
              )}
            </div>
          </div>
          <Link href="/dashboard/insights/weekly">
            <Button size="sm" variant="ghost" className="text-xs gap-1">
              See all <ArrowRight className="h-3 w-3" />
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {digest.metrics.slice(0, 3).map((m) => (
            <MetricTile key={m.key} metric={m} />
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function MetricTile({ metric }: { metric: SmarterMetric }) {
  const TrendIcon = metric.trend === "up" ? TrendingUp : metric.trend === "down" ? TrendingDown : Minus
  const trendColor =
    metric.trend === "up" ? "text-green-600" : metric.trend === "down" ? "text-red-600" : "text-gray-400"

  const formatted =
    metric.unit === "percent" ? `${metric.thisWeek.toFixed(0)}%` :
    metric.unit === "score" ? metric.thisWeek.toFixed(0) :
    String(metric.thisWeek)

  return (
    <div className="bg-white/60 rounded p-2 border border-purple-100">
      <p className="text-[11px] text-muted-foreground line-clamp-1">{metric.label}</p>
      <div className="flex items-baseline gap-2 mt-0.5">
        <span className="text-lg font-semibold">{formatted}</span>
        <span className={`text-xs flex items-center gap-0.5 ${trendColor}`}>
          <TrendIcon className="h-3 w-3" />
          {metric.deltaPercent != null
            ? `${metric.deltaPercent > 0 ? "+" : ""}${metric.deltaPercent.toFixed(0)}%`
            : "—"}
        </span>
      </div>
    </div>
  )
}
