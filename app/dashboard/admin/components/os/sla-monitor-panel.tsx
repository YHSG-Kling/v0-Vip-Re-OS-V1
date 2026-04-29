"use client"

import { useEffect, useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { ActionConfirmSheet } from "@/app/components/action-framework/action-confirm-sheet"
import { createTask } from "@/app/actions/tasks"
import { updateComplianceCheck } from "@/app/actions/transaction-compliance"
import {
  Clock,
  ChevronRight,
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Timer,
  ShieldAlert,
  ExternalLink,
} from "lucide-react"
import Link from "next/link"
import { createClient } from "@/lib/supabase/client"

interface SlaMonitorPanelProps {
  brokerageId: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  stats?: any
}

interface SlaMetrics {
  overdueTasks: number
  stuckRequests: number
  pendingApprovals: number
  avgResponseTime: number
  complianceRate: number
}

interface OverdueTask {
  id: string
  title: string
  due_date: string
  transaction_id?: string
}

export function SlaMonitorPanel({ brokerageId }: SlaMonitorPanelProps) {
  const [metrics, setMetrics] = useState<SlaMetrics | null>(null)
  const [overdueTasks, setOverdueTasks] = useState<OverdueTask[]>([])
  const [loading, setLoading] = useState(true)
  const [escalateTarget, setEscalateTarget] = useState<OverdueTask | null>(null)
  const [resolveTarget, setResolveTarget] = useState<OverdueTask | null>(null)
  const [isPending, startTransition] = useTransition()
  const [toast, setToast] = useState<string | null>(null)

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
        overdueResult,
        { count: stuckRequests },
        { count: pendingApprovals },
        { data: slaTracking },
      ] = await Promise.all([
        // Overdue tasks with details (first 5 for fast-action display)
        supabase
          .from("tasks")
          .select("id, title, due_date, transaction_id")
          .eq("brokerage_id", brokerageId)
          .eq("status", "pending")
          .lt("due_date", today)
          .order("due_date", { ascending: true })
          .limit(5),
        // Stuck showing requests
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

      const tasks = overdueResult.data || []
      setOverdueTasks(tasks)

      const totalSla = (slaTracking || []).length
      const breached = (slaTracking || []).filter((s: any) => s.breached).length
      const complianceRate = totalSla > 0 ? Math.round(((totalSla - breached) / totalSla) * 100) : 100

      setMetrics({
        overdueTasks: tasks.length,
        stuckRequests: stuckRequests || 0,
        pendingApprovals: pendingApprovals || 0,
        avgResponseTime: 2.4,
        complianceRate,
      })
      setLoading(false)
    }

    loadSlaMetrics()
  }, [brokerageId])

  function showToast(msg: string) {
    setToast(msg)
    setTimeout(() => setToast(null), 3000)
  }

  async function handleEscalate(task: OverdueTask) {
    await createTask({
      title: `ESCALATION: ${task.title}`,
      description: `SLA overdue since ${task.due_date}. Escalated by admin.`,
      priority: "urgent",
      transactionId: task.transaction_id,
    })
    showToast(`Escalated: ${task.title}`)
    setEscalateTarget(null)
  }

  async function handleMarkResolved(task: OverdueTask) {
    // Mark the task as complete via supabase client — updateComplianceCheck requires
    // checkId/transactionId/brokerageId; for overdue tasks without a compliance check
    // we directly update the task status.
    const supabase = createClient()
    await supabase
      .from("tasks")
      .update({ status: "completed", updated_at: new Date().toISOString() })
      .eq("id", task.id)
    setOverdueTasks((prev) => prev.filter((t) => t.id !== task.id))
    setMetrics((prev) => prev ? { ...prev, overdueTasks: Math.max(0, prev.overdueTasks - 1) } : prev)
    showToast(`Resolved: ${task.title}`)
    setResolveTarget(null)
  }

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
    <>
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
          {toast && (
            <div className="text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded p-2">{toast}</div>
          )}

          {/* Compliance Progress */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs text-muted-foreground">SLA Compliance</span>
              <span className="text-xs font-medium">{metrics.complianceRate}%</span>
            </div>
            <Progress
              value={metrics.complianceRate}
              className={`h-2 ${
                metrics.complianceRate >= 90
                  ? "[&>div]:bg-emerald-500"
                  : metrics.complianceRate >= 70
                  ? "[&>div]:bg-amber-500"
                  : "[&>div]:bg-red-500"
              }`}
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

          {/* SLA Recovery Actions — per overdue task */}
          {overdueTasks.length > 0 && (
            <div className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Overdue Items</p>
              {overdueTasks.map((task) => (
                <div key={task.id} className="p-2 rounded-lg border border-red-200 bg-red-50/50 space-y-1">
                  <div className="flex items-start justify-between gap-2">
                    <span className="text-xs font-medium text-red-800 leading-tight">{task.title}</span>
                    <span className="text-[10px] text-red-600 whitespace-nowrap">Due {task.due_date}</span>
                  </div>
                  <div className="flex items-center gap-1 flex-wrap">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-red-700 hover:bg-red-100"
                      onClick={() => setEscalateTarget(task)}
                    >
                      <ShieldAlert className="h-3 w-3 mr-1" />
                      Escalate
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-xs text-emerald-700 hover:bg-emerald-50"
                      onClick={() => setResolveTarget(task)}
                    >
                      <CheckCircle2 className="h-3 w-3 mr-1" />
                      Mark Resolved
                    </Button>
                    {task.transaction_id && (
                      <Link href={`/dashboard/transactions/${task.transaction_id}`}>
                        <Button variant="ghost" size="sm" className="h-6 px-2 text-xs">
                          <ExternalLink className="h-3 w-3 mr-1" />
                          Record
                        </Button>
                      </Link>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}

          {totalIssues === 0 && (
            <div className="flex items-center gap-2 p-2 bg-emerald-50 border border-emerald-200 rounded-lg">
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
              <span className="text-xs text-emerald-700">All SLA items on track</span>
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

      {/* Escalate confirm sheet */}
      {escalateTarget && (
        <ActionConfirmSheet
          open={!!escalateTarget}
          onOpenChange={(open) => !open && setEscalateTarget(null)}
          title={`Escalate: "${escalateTarget.title}"`}
          description={`This will create an urgent escalation task for this overdue item (due ${escalateTarget.due_date}). The escalation will appear in the task queue for immediate attention.`}
          actionLabel="Escalate"
          confirmingLabel="Escalating..."
          destructive
          onConfirm={() => handleEscalate(escalateTarget)}
        />
      )}

      {/* Resolve confirm sheet */}
      {resolveTarget && (
        <ActionConfirmSheet
          open={!!resolveTarget}
          onOpenChange={(open) => !open && setResolveTarget(null)}
          title={`Mark Resolved: "${resolveTarget.title}"`}
          description={`This will mark this overdue task as completed and remove it from the SLA monitor.`}
          actionLabel="Mark Resolved"
          confirmingLabel="Resolving..."
          onConfirm={() => handleMarkResolved(resolveTarget)}
        />
      )}
    </>
  )
}
