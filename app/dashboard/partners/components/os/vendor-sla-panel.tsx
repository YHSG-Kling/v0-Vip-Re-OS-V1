"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { CheckCircle, AlertTriangle, Clock, TrendingUp } from "lucide-react"
import { computeVendorSla } from "@/lib/kernel/vendor-sla"
import { createClient } from "@/lib/supabase/client"

interface VendorSlaPanelProps {
  brokerageId: string
  /** Pass userRole to gate per-vendor detail to broker/team_lead only */
  userRole?: string
}

interface VendorSlaRow {
  id: string
  name: string
  category: string | null
  turnaroundDays: number
  totalCompleted: number
  onTime: number
  slaPct: number
}

interface WeekTrend {
  label: string
  pct: number
}

export function VendorSlaPanel({ brokerageId, userRole }: VendorSlaPanelProps) {
  const isBroker = !userRole || userRole === "broker" || userRole === "team_lead" || userRole === "admin"

  const [vendorRows, setVendorRows] = useState<VendorSlaRow[]>([])
  const [overallPct, setOverallPct] = useState<number | null>(null)
  const [trend, setTrend] = useState<WeekTrend[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const supabase = createClient()

      // Fetch vendors with turnaround commitment
      const { data: vendors } = await supabase
        .from("vendors")
        .select("id, name, category, estimated_turnaround_days")
        .eq("brokerage_id", brokerageId)

      if (!vendors || vendors.length === 0) {
        setLoading(false)
        return
      }

      const vendorIds = vendors.map((v: any) => v.id)
      const turnaroundMap: Record<string, number> = {}
      for (const v of vendors as any[]) {
        turnaroundMap[v.id] = v.estimated_turnaround_days ?? 1
      }

      // Fetch reliability-bearing bookings in the last 90 days: completions AND no-shows (a no-show
      // dents reliability too — same rule the shared computeVendorSla + orchestration use).
      const since = new Date()
      since.setDate(since.getDate() - 90)

      const { data: bookings } = await supabase
        .from("vendor_bookings")
        .select("vendor_id, scheduled_date, completed_at, status")
        .in("vendor_id", vendorIds)
        .gte("created_at", since.toISOString())
        .or("completed_at.not.is.null,status.eq.no_show")

      // Per-vendor SLA via the SHARED pure computeVendorSla (same math the no-show autopilot uses).
      const byVendor = computeVendorSla((bookings ?? []) as any[], turnaroundMap)

      const rows: VendorSlaRow[] = (vendors as any[]).map((v) => {
        const stats = byVendor[v.id] ?? { total: 0, onTime: 0, slaPct: 100 }
        return {
          id: v.id,
          name: v.name,
          category: v.category,
          turnaroundDays: turnaroundMap[v.id] ?? 1,
          totalCompleted: stats.total,
          onTime: stats.onTime,
          slaPct: stats.slaPct,
        }
      }).sort((a, b) => b.slaPct - a.slaPct)

      // Overall SLA %
      const allTotal = rows.reduce((s, r) => s + r.totalCompleted, 0)
      const allOnTime = rows.reduce((s, r) => s + r.onTime, 0)
      setOverallPct(allTotal > 0 ? Math.round((allOnTime / allTotal) * 100) : null)
      setVendorRows(rows)

      // 30-day weekly trend
      const weeks: WeekTrend[] = []
      for (let w = 3; w >= 0; w--) {
        const start = new Date(); start.setDate(start.getDate() - (w + 1) * 7)
        const end = new Date(); end.setDate(end.getDate() - w * 7)
        const weekBookings = ((bookings ?? []) as any[]).filter((b) => {
          const c = new Date(b.completed_at)
          return c >= start && c < end
        })
        const wTotal = weekBookings.length
        let wOnTime = 0
        for (const b of weekBookings) {
          const vid = b.vendor_id
          const due = new Date(b.scheduled_date)
          due.setDate(due.getDate() + (turnaroundMap[vid] ?? 1))
          if (new Date(b.completed_at) <= due) wOnTime++
        }
        weeks.push({
          label: `W${4 - w}`,
          pct: wTotal > 0 ? Math.round((wOnTime / wTotal) * 100) : 0,
        })
      }
      setTrend(weeks)
      setLoading(false)
    }

    load()
  }, [brokerageId])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <TrendingUp className="h-5 w-5" />
            SLA Compliance
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        </CardContent>
      </Card>
    )
  }

  const compliant = vendorRows.filter((r) => r.slaPct >= 90).length
  const warning = vendorRows.filter((r) => r.slaPct >= 75 && r.slaPct < 90).length
  const breach = vendorRows.filter((r) => r.slaPct < 75).length

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg flex items-center gap-2">
          <TrendingUp className="h-5 w-5" />
          SLA Compliance
        </CardTitle>
        <CardDescription>On-time delivery vs committed turnaround — last 90 days</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">

        {/* Overall + breakdown */}
        {overallPct !== null ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Overall On-Time</span>
              <span className="font-bold text-lg">{overallPct}%</span>
            </div>
            <Progress value={overallPct} className="h-2" />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No completed bookings in the last 90 days.</p>
        )}

        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col items-center rounded-lg bg-green-50 p-2 dark:bg-green-950/20">
            <CheckCircle className="h-4 w-4 text-green-600" />
            <span className="mt-1 text-lg font-bold text-green-600">{compliant}</span>
            <span className="text-xs text-green-600/70">≥90%</span>
          </div>
          <div className="flex flex-col items-center rounded-lg bg-yellow-50 p-2 dark:bg-yellow-950/20">
            <Clock className="h-4 w-4 text-yellow-600" />
            <span className="mt-1 text-lg font-bold text-yellow-600">{warning}</span>
            <span className="text-xs text-yellow-600/70">75–89%</span>
          </div>
          <div className="flex flex-col items-center rounded-lg bg-red-50 p-2 dark:bg-red-950/20">
            <AlertTriangle className="h-4 w-4 text-red-600" />
            <span className="mt-1 text-lg font-bold text-red-600">{breach}</span>
            <span className="text-xs text-red-600/70">&lt;75%</span>
          </div>
        </div>

        {/* 30-day weekly trend */}
        {trend.length > 0 && trend.some((w) => w.pct > 0) && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">30-Day Weekly Trend</p>
            <div className="flex items-end gap-2 h-16">
              {trend.map((w) => (
                <div key={w.label} className="flex-1 flex flex-col items-center gap-0.5">
                  <div
                    className="w-full rounded-t"
                    style={{
                      height: `${Math.max(4, (w.pct / 100) * 48)}px`,
                      background: w.pct >= 90 ? "rgb(22 163 74)" : w.pct >= 75 ? "rgb(202 138 4)" : "rgb(220 38 38)",
                    }}
                  />
                  <span className="text-[10px] text-muted-foreground">{w.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Per-vendor detail (broker-only) */}
        {isBroker && vendorRows.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Per-Vendor SLA</p>
            <div className="space-y-2 max-h-56 overflow-y-auto">
              {vendorRows.map((row) => (
                <div key={row.id} className="flex items-center gap-2 text-sm">
                  <div className="flex-1 min-w-0">
                    <p className="font-medium truncate">{row.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{row.category ?? "General"} · {row.turnaroundDays}d turnaround</p>
                  </div>
                  <div className="text-right shrink-0">
                    <Badge
                      variant="outline"
                      className={row.slaPct >= 90 ? "border-green-300 text-green-700" : row.slaPct >= 75 ? "border-yellow-300 text-yellow-700" : "border-red-300 text-red-700"}
                    >
                      {row.slaPct}%
                    </Badge>
                    <p className="text-[10px] text-muted-foreground">{row.onTime}/{row.totalCompleted} on time</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
