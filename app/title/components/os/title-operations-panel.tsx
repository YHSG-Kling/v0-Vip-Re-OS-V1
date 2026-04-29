"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { FileCheck, Clock, CheckCircle, AlertTriangle, Calendar } from "lucide-react"
import { createClient } from "@/lib/supabase/client"

interface TitleOperationsPanelProps {
  titleCompanyId: string
}

interface OperationMetrics {
  totalOrders: number
  clear: number
  inProgress: number
  issues: number
  clearRate: number
  avgTurnaround: number
  closingsThisWeek: number
}

export function TitleOperationsPanel({ titleCompanyId }: TitleOperationsPanelProps) {
  const [metrics, setMetrics] = useState<OperationMetrics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadMetrics() {
      const supabase = createClient()

      // Get all title orders
      const { data: orders } = await supabase
        .from("title_orders")
        .select("id, status, created_at, completed_at, closing_date")
        .eq("vendor_id", titleCompanyId)

      if (!orders || orders.length === 0) {
        setMetrics({
          totalOrders: 0,
          clear: 0,
          inProgress: 0,
          issues: 0,
          clearRate: 0,
          avgTurnaround: 0,
          closingsThisWeek: 0,
        })
        setLoading(false)
        return
      }

      const totalOrders = orders.length
      const clear = orders.filter((o: any) => o.status === "clear" || o.status === "completed").length
      const inProgress = orders.filter((o: any) => ["pending", "ordered", "in_progress"].includes(o.status)).length
      const issues = orders.filter((o: any) => ["issue", "exception"].includes(o.status)).length

      const decisioned = clear + issues
      const clearRate = decisioned > 0 ? (clear / decisioned) * 100 : 0

      // Calculate avg turnaround for completed orders
      const completedOrders = orders.filter((o: any) => o.completed_at && o.created_at)
      const avgTurnaround = completedOrders.length > 0
        ? completedOrders.reduce((sum: number, o: any) => {
            const days = (new Date(o.completed_at).getTime() - new Date(o.created_at).getTime()) / (1000 * 60 * 60 * 24)
            return sum + days
          }, 0) / completedOrders.length
        : 0

      // Closings this week
      const now = new Date()
      const weekFromNow = new Date()
      weekFromNow.setDate(weekFromNow.getDate() + 7)

      const closingsThisWeek = orders.filter((o: any) => {
        if (!o.closing_date) return false
        const closeDate = new Date(o.closing_date)
        return closeDate >= now && closeDate <= weekFromNow
      }).length

      setMetrics({
        totalOrders,
        clear,
        inProgress,
        issues,
        clearRate,
        avgTurnaround,
        closingsThisWeek,
      })
      setLoading(false)
    }

    loadMetrics()
  }, [titleCompanyId])

  if (loading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Operations Overview</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!metrics) return null

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-lg">Operations Overview</CardTitle>
        <CardDescription>Title order performance metrics</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Clear Rate */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">Clear Rate</span>
            <span className="text-sm font-bold">{metrics.clearRate.toFixed(0)}%</span>
          </div>
          <Progress value={metrics.clearRate} className="h-2" />
        </div>

        {/* Status Breakdown */}
        <div className="grid grid-cols-3 gap-2">
          <div className="flex flex-col items-center rounded-lg bg-green-50 p-2 dark:bg-green-950/20">
            <CheckCircle className="h-4 w-4 text-green-600" />
            <span className="mt-1 text-lg font-bold text-green-600">{metrics.clear}</span>
            <span className="text-xs text-green-600/70">Clear</span>
          </div>
          <div className="flex flex-col items-center rounded-lg bg-blue-50 p-2 dark:bg-blue-950/20">
            <Clock className="h-4 w-4 text-blue-600" />
            <span className="mt-1 text-lg font-bold text-blue-600">{metrics.inProgress}</span>
            <span className="text-xs text-blue-600/70">In Progress</span>
          </div>
          <div className="flex flex-col items-center rounded-lg bg-red-50 p-2 dark:bg-red-950/20">
            <AlertTriangle className="h-4 w-4 text-red-600" />
            <span className="mt-1 text-lg font-bold text-red-600">{metrics.issues}</span>
            <span className="text-xs text-red-600/70">Issues</span>
          </div>
        </div>

        {/* Additional Metrics */}
        <div className="space-y-2 pt-2">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <FileCheck className="h-4 w-4 text-muted-foreground" />
              Avg Turnaround
            </span>
            <Badge variant="outline">{metrics.avgTurnaround.toFixed(1)} days</Badge>
          </div>
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2">
              <Calendar className="h-4 w-4 text-muted-foreground" />
              Closings This Week
            </span>
            <Badge variant={metrics.closingsThisWeek > 0 ? "default" : "secondary"}>
              {metrics.closingsThisWeek}
            </Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
