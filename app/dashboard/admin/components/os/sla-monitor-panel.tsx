"use client"

import { useEffect, useState } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { 
  Clock, 
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Timer
} from "lucide-react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"

interface SlaMonitorPanelProps {
  brokerageId: string
}

interface SlaMetrics {
  overdueTasks: number
  stuckRequests: number
  pendingApprovals: number
  avgResponseTime: number
  complianceRate: number
}

export function SlaMonitorPanel({ brokerageId }: SlaMonitorPanelProps) {
  const [metrics, setMetrics] = useState<SlaMetrics | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function loadSlaMetrics() {
      if (!brokerageId) {
        setLoading(false)
        return
      }

      const supabase = createClient()
      const today = new Date().toISOString().split("T")[0]
      const weekAgo = new Date()
      weekAgo.setDate(weekAgo.getDate() - 7)

      const [
        { count: overdueTasks },
        { count: stuckRequests },
        { count: pendingApprovals },
        { data: slaTracking },
      ] = await Promise.all([
        // Overdue admin tasks
        supabase
          .from("tasks")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId)
          .eq("status", "pending")
          .lt("due_date", today),
        // Stuck showing requests (pending > 24h)
        supabase
          .from("showing_requests")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId)
          .eq("status", "pending")
          .lt("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()),
        // Pending approvals
        supabase
          .from("approval_items")
          .select("id", { count: "exact", head: true })
          .eq("brokerage_id", brokerageId)
          .eq("status", "pending"),
        // SLA tracking data
        supabase
          .from("lead_sla_tracking")
          .select("breached")
          .eq("brokerage_id", brokerageId)
          .gte("created_at", weekAgo.toISOString()),
      ])

      // Calculate compliance rate
      const totalSla = (slaTracking || []).length
      const breached = (slaTracking || []).filter((s) => s.breached).length
      const complianceRate = totalSla > 0 ? Math.round(((totalSla - breached) / totalSla) * 100) : 100

      setMetrics({
        overdueTasks: overdueTasks || 0,
        stuckRequests: stuckRequests || 0,
        pendingApprovals: pendingApprovals || 0,
        avgResponseTime: 2.4, // Would calculate from actual data
        complianceRate,
      })
      setLoading(false)
    }

    loadSlaMetrics()
  }, [brokerageId])

  if (loading) {
    return (
      <Card className="border-border">
        <CardContent className="flex items-center justify-center p-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    )
  }

  if (!metrics) return null

  const totalIssues = metrics.overdueTasks + metrics.stuckRequests + metrics.pendingApprovals
  const status = totalIssues > 5 ? "critical" : totalIssues > 0 ? "warning" : "healthy"

  return (
    <Card className="border-border">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base font-semibold">
            <Timer className="h-4 w-4 text-orange-600" />
            SLA Monitor
          </CardTitle>
          <Badge 
            variant={status === "healthy" ? "outline" : status === "warning" ? "secondary" : "destructive"}
            className="text-xs"
          >
            {metrics.complianceRate}% Compliant
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="pt-0 space-y-4">
        {/* Compliance Progress */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <span className="text-xs text-muted-foreground">SLA Compliance</span>
            <span className="text-xs font-medium">{metrics.complianceRate}%</span>
          </div>
          <Progress 
            value={metrics.complianceRate} 
            className={`h-2 ${metrics.complianceRate >= 90 ? "[&>div]:bg-emerald-500" : metrics.complianceRate >= 70 ? "[&>div]:bg-amber-500" : "[&>div]:bg-red-500"}`}
          />
        </div>

        {/* Metrics Grid */}
        <div className="grid grid-cols-3 gap-2">
          <div className={`text-center p-2 rounded-lg ${metrics.overdueTasks > 0 ? "bg-red-50 border border-red-200" : "bg-muted/50"}`}>
            <div className="flex items-center justify-center gap-1">
              {metrics.overdueTasks > 0 && <AlertTriangle className="h-3 w-3 text-red-600" />}
              <p className={`text-lg font-bold ${metrics.overdueTasks > 0 ? "text-red-700" : ""}`}>
                {metrics.overdueTasks}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">Overdue</p>
          </div>
          <div className={`text-center p-2 rounded-lg ${metrics.stuckRequests > 0 ? "bg-amber-50 border border-amber-200" : "bg-muted/50"}`}>
            <p className={`text-lg font-bold ${metrics.stuckRequests > 0 ? "text-amber-700" : ""}`}>
              {metrics.stuckRequests}
            </p>
            <p className="text-xs text-muted-foreground">Stuck</p>
          </div>
          <div className={`text-center p-2 rounded-lg ${metrics.pendingApprovals > 0 ? "bg-blue-50 border border-blue-200" : "bg-muted/50"}`}>
            <p className={`text-lg font-bold ${metrics.pendingApprovals > 0 ? "text-blue-700" : ""}`}>
              {metrics.pendingApprovals}
            </p>
            <p className="text-xs text-muted-foreground">Pending</p>
          </div>
        </div>

        {totalIssues > 0 && (
          <div className="p-2 bg-amber-50 border border-amber-200 rounded-lg">
            <div className="flex items-center gap-2">
              <Clock className="h-4 w-4 text-amber-600" />
              <span className="text-xs text-amber-700">
                {totalIssues} item{totalIssues > 1 ? "s" : ""} need attention
              </span>
            </div>
          </div>
        )}

        <Link href="/dashboard/admin/sla-monitor">
          <Button variant="outline" size="sm" className="w-full">
            View SLA Details
            <ChevronRight className="h-4 w-4 ml-1" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
