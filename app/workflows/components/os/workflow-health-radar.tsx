"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { CheckCircle2, AlertTriangle, Pause, XCircle, Clock, Loader2 } from "lucide-react"
import { formatDistanceToNow } from "date-fns"

interface Execution {
  id: string
  workflow_name: string
  status: string
  started_at: string
  error_message?: string
  affected_record_id?: string
}

interface WorkflowHealthRadarProps {
  executions: Execution[] | null
  loading: boolean
}

export function WorkflowHealthRadar({ executions, loading }: WorkflowHealthRadarProps) {
  if (loading) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading Health Status...
          </CardTitle>
        </CardHeader>
      </Card>
    )
  }

  const failedCount = executions?.filter((e) => e.status === "failed").length || 0
  const pausedCount = executions?.filter((e) => e.status === "paused" || e.status === "awaiting_approval").length || 0
  const last5 = executions?.slice(0, 5) || []

  const getHealthStatus = () => {
    if (failedCount > 0) {
      return {
        icon: <XCircle className="h-5 w-5 text-red-600" />,
        text: `${failedCount} failed`,
        bgColor: "bg-red-50",
        borderColor: "border-red-200",
        textColor: "text-red-800",
      }
    }
    if (pausedCount > 0) {
      return {
        icon: <Pause className="h-5 w-5 text-amber-600" />,
        text: `${pausedCount} paused`,
        bgColor: "bg-amber-50",
        borderColor: "border-amber-200",
        textColor: "text-amber-800",
      }
    }
    return {
      icon: <CheckCircle2 className="h-5 w-5 text-green-600" />,
      text: "All automations healthy",
      bgColor: "bg-green-50",
      borderColor: "border-green-200",
      textColor: "text-green-800",
    }
  }

  const health = getHealthStatus()

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "completed":
        return <CheckCircle2 className="h-4 w-4 text-green-600" />
      case "failed":
        return <XCircle className="h-4 w-4 text-red-600" />
      case "running":
        return <Loader2 className="h-4 w-4 text-blue-600 animate-spin" />
      case "paused":
      case "awaiting_approval":
        return <Pause className="h-4 w-4 text-amber-600" />
      default:
        return <Clock className="h-4 w-4 text-muted-foreground" />
    }
  }

  const getStatusBadge = (status: string) => {
    const variants: Record<string, "default" | "destructive" | "secondary" | "outline"> = {
      completed: "default",
      failed: "destructive",
      running: "secondary",
      paused: "outline",
      awaiting_approval: "outline",
    }
    return <Badge variant={variants[status] || "outline"}>{status.replace("_", " ")}</Badge>
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base">Automation Health</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Health Summary */}
        <div className={`flex items-center gap-3 rounded-md ${health.bgColor} border ${health.borderColor} px-4 py-3`}>
          {health.icon}
          <span className={`font-medium ${health.textColor}`}>{health.text}</span>
        </div>

        {/* Last 5 executions timeline */}
        {last5.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-muted-foreground">Recent Executions</p>
            {last5.map((execution) => (
              <div
                key={execution.id}
                className="flex items-center justify-between gap-2 rounded-md border px-3 py-2"
              >
                <div className="flex items-center gap-2 min-w-0">
                  {getStatusIcon(execution.status)}
                  <span className="text-sm font-medium truncate">{execution.workflow_name}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-muted-foreground">
                    {formatDistanceToNow(new Date(execution.started_at), { addSuffix: true })}
                  </span>
                  {getStatusBadge(execution.status)}
                </div>
              </div>
            ))}
          </div>
        )}

        {last5.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-4">No recent executions</p>
        )}
      </CardContent>
    </Card>
  )
}
