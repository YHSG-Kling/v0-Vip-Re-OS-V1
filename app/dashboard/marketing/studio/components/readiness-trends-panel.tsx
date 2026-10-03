"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { AlertCircle, Loader2, TrendingUp } from "lucide-react"
import { getReadinessTrendSnapshot, type ReadinessTrendPoint } from "@/app/actions/marketing-ops"

/**
 * READINESS TREND — Marketing Studio → Ops tab.
 *
 * The daily ready/blocked split behind the "Readiness Pass Rate" tile: one
 * number tells a brokerage where it stands today, this tells it which way it is
 * moving. Read-only, self-loading, brokerage-scoped server-side.
 *
 * This panel is what app/actions/campaign-readiness.ts::fetchReadinessTrends was
 * written for. It stayed unwired while the lib query behind it aggregated every
 * brokerage on the platform; that query now takes a REQUIRED brokerageId and
 * filters on it, and the brokerage is resolved from the SESSION in
 * getReadinessTrendSnapshot — nothing tenant-identifying is sent from here.
 *
 * A read that FAILED renders as an error, never as an empty chart. An empty
 * series and a refused query look identical once a failure is swallowed, and a
 * flatline of zeroes is a statement about the brokerage's content that the data
 * does not support.
 */
export function ReadinessTrendsPanel() {
  const [trends, setTrends] = useState<ReadinessTrendPoint[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    getReadinessTrendSnapshot(30)
      .then((res) => {
        if (!alive) return
        if (res.ok) {
          setTrends(res.trends)
          setError(null)
        } else {
          setTrends(null)
          setError(res.error)
        }
      })
      .catch(() => alive && setError("Could not load readiness trend."))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  const totalReady = (trends ?? []).reduce((n, t) => n + t.ready_count, 0)
  const totalBlocked = (trends ?? []).reduce((n, t) => n + t.blocked_count, 0)
  const totalEvaluations = totalReady + totalBlocked
  const overall = totalEvaluations > 0 ? Math.round((totalReady / totalEvaluations) * 100) : null
  const maxDay = Math.max(1, ...(trends ?? []).map((t) => t.ready_count + t.blocked_count))

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-indigo-600" /> Readiness Trend — last 30 days
        </CardTitle>
        <CardDescription className="text-xs">
          Daily campaign-content readiness verdicts recorded for your brokerage.
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-4">
        {loading && (
          <div className="flex items-center justify-center py-8 text-muted-foreground text-sm">
            <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading readiness trend…
          </div>
        )}

        {/* A FAILED read is reported as a failure — it is never drawn as an
            empty (0-ready / 0-blocked) series. */}
        {!loading && error && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 px-3 py-2.5 text-sm text-amber-800 dark:text-amber-200">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>Readiness trend could not be loaded: {error}</span>
          </div>
        )}

        {!loading && !error && trends && trends.length === 0 && (
          <p className="py-6 text-sm text-muted-foreground text-center">
            No readiness verdicts recorded in the last 30 days. Run a readiness sweep from the
            Assets tab to start building this trend.
          </p>
        )}

        {!loading && !error && trends && trends.length > 0 && (
          <div className="space-y-3">
            <div className="flex items-baseline gap-4">
              <div>
                <p className="text-xs text-muted-foreground">Pass rate over the period</p>
                <p className="text-2xl font-bold">{overall != null ? `${overall}%` : "—"}</p>
              </div>
              <p className="text-xs text-muted-foreground">
                {totalReady.toLocaleString()} ready · {totalBlocked.toLocaleString()} blocked ·{" "}
                {totalEvaluations.toLocaleString()} evaluations
              </p>
            </div>

            <div className="space-y-1">
              {trends.map((t) => {
                const dayTotal = t.ready_count + t.blocked_count
                const width = (dayTotal / maxDay) * 100
                const readyShare = dayTotal > 0 ? (t.ready_count / dayTotal) * 100 : 0
                return (
                  <div key={t.date} className="flex items-center gap-3 text-xs">
                    <span className="w-20 shrink-0 text-muted-foreground tabular-nums">{t.date}</span>
                    <div className="flex-1 h-3 rounded bg-muted overflow-hidden">
                      <div className="h-full flex" style={{ width: `${width}%` }}>
                        <div className="bg-emerald-500 h-full" style={{ width: `${readyShare}%` }} />
                        <div className="bg-red-400 h-full" style={{ width: `${100 - readyShare}%` }} />
                      </div>
                    </div>
                    <span className="w-28 shrink-0 text-right text-muted-foreground tabular-nums">
                      {t.ready_count}/{dayTotal} · {Math.round(t.ready_percentage)}%
                    </span>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
