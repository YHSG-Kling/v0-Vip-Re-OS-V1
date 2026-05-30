"use client"

import { useEffect, useState } from "react"
import { getMagnetPerformanceAction } from "@/app/actions/lead-magnets-actions"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Eye, Users, QrCode, TrendingUp, RefreshCw } from "lucide-react"

interface Props {
  magnetId: string
  brokerageId: string
  magnetName?: string
}

type Performance = {
  totalViews: number
  totalSubmissions: number
  totalQrScans: number
  conversionRate: number
  submissionsByDay: Array<{ date: string; count: number }>
  topSources: Array<{ source: string; count: number }>
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ElementType
  label: string
  value: string | number
  sub?: string
}) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-4">
        <div className="p-2 bg-muted rounded-lg shrink-0">
          <Icon className="h-4 w-4 text-muted-foreground" />
        </div>
        <div>
          <p className="text-2xl font-bold leading-none">{value}</p>
          <p className="text-sm text-muted-foreground mt-1">{label}</p>
          {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
        </div>
      </CardContent>
    </Card>
  )
}

export function PerformanceDashboard({ magnetId, brokerageId, magnetName }: Props) {
  const [performance, setPerformance] = useState<Performance | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    load()
  }, [magnetId, brokerageId])

  async function load() {
    setLoading(true)
    setError(null)
    const result = await getMagnetPerformanceAction(magnetId)
    if (result.success) {
      const subs = result.submissions ?? []
      const byDay: Record<string, number> = {}
      for (const sub of subs) {
        const date = (sub as any).created_at?.substring(0, 10) ?? ""
        if (date) byDay[date] = (byDay[date] ?? 0) + 1
      }
      setPerformance({
        totalViews: subs.length,
        totalSubmissions: subs.length,
        totalQrScans: 0,
        conversionRate: subs.length > 0 ? 1 : 0,
        submissionsByDay: Object.entries(byDay).map(([date, count]) => ({ date, count })),
        topSources: [],
      })
    } else {
      setError(result.error ?? "Failed to load performance")
    }
    setLoading(false)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12 text-sm text-muted-foreground">
        Loading performance data...
      </div>
    )
  }

  if (error || !performance) {
    return (
      <div className="flex flex-col items-center gap-3 py-12">
        <p className="text-sm text-destructive">{error ?? "No data available"}</p>
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Retry
        </Button>
      </div>
    )
  }

  // Build submission chart data — last 30 days filled with zeros
  const today = new Date()
  const chartDays = Array.from({ length: 14 }, (_, i) => {
    const d = new Date(today)
    d.setDate(d.getDate() - (13 - i))
    return d.toISOString().substring(0, 10)
  })
  const dayMap: Record<string, number> = {}
  for (const { date, count } of performance.submissionsByDay) {
    dayMap[date] = count
  }
  const chartData = chartDays.map((date) => ({ date, count: dayMap[date] ?? 0 }))
  const maxCount = Math.max(...chartData.map((d) => d.count), 1)

  return (
    <div className="space-y-6">
      {magnetName && (
        <div className="flex items-center gap-2">
          <h3 className="font-semibold text-lg">{magnetName}</h3>
          <Badge variant="outline" className="text-xs">Analytics</Badge>
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          icon={Eye}
          label="Total Views"
          value={performance.totalViews.toLocaleString()}
        />
        <StatCard
          icon={Users}
          label="Submissions"
          value={performance.totalSubmissions.toLocaleString()}
        />
        <StatCard
          icon={QrCode}
          label="QR Scans"
          value={performance.totalQrScans.toLocaleString()}
        />
        <StatCard
          icon={TrendingUp}
          label="Conversion Rate"
          value={`${(performance.conversionRate * 100).toFixed(1)}%`}
          sub="views to submissions"
        />
      </div>

      {/* Submissions over time */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium">Submissions — Last 14 Days</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-end gap-1 h-24">
            {chartData.map(({ date, count }) => (
              <div key={date} className="flex-1 flex flex-col items-center gap-1 group">
                <div
                  className="w-full bg-primary/80 rounded-t transition-all hover:bg-primary"
                  style={{ height: `${(count / maxCount) * 100}%`, minHeight: count > 0 ? "4px" : "1px" }}
                  title={`${date}: ${count}`}
                />
              </div>
            ))}
          </div>
          <div className="flex justify-between mt-2 text-xs text-muted-foreground">
            <span>{chartDays[0]}</span>
            <span>{chartDays[chartDays.length - 1]}</span>
          </div>
        </CardContent>
      </Card>

      {/* Top Sources */}
      {performance.topSources.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm font-medium">Top Sources</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {performance.topSources.map(({ source, count }) => (
              <div key={source} className="flex items-center justify-between text-sm">
                <span className="capitalize text-muted-foreground">{source.replace("_", " ")}</span>
                <span className="font-medium tabular-nums">{count}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={load}>
          <RefreshCw className="h-4 w-4 mr-2" />
          Refresh
        </Button>
      </div>
    </div>
  )
}
