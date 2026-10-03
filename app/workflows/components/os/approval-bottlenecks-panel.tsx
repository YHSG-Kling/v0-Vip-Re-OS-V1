"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Clock, CheckCircle2, Eye } from "lucide-react"
import { formatDistanceToNow } from "date-fns"

interface Execution {
  id: string
  workflow_name: string
  status: string
  started_at: string
  waiting_for?: string
}

interface ApprovalBottlenecksPanelProps {
  executions: Execution[]
  onApprove: (executionId: string) => Promise<void>
  onViewDetail: (executionId: string) => void
}

export function ApprovalBottlenecksPanel({
  executions,
  onApprove,
  onViewDetail,
}: ApprovalBottlenecksPanelProps) {
  const pendingApprovals = executions.filter(
    (e) => e.status === "awaiting_approval" || e.status === "paused"
  )

  if (pendingApprovals.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            Pending Approvals
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2 text-green-700 bg-green-50 rounded-md px-3 py-2">
            <CheckCircle2 className="h-4 w-4" />
            <span className="text-sm">No approvals pending</span>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className="border-amber-200">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 text-amber-700">
          <Clock className="h-4 w-4" />
          Pending Approvals ({pendingApprovals.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {pendingApprovals.map((execution) => {
          const waitTime = formatDistanceToNow(new Date(execution.started_at), { addSuffix: false })
          // `paused` IS the engine's awaiting-approval state (engine.ts parks the run
          // at `paused` with its step at `needs_approval`). Gating the button on
          // "awaiting_approval" — a status the engine never writes — meant the
          // Approve control never rendered for a single real run.
          const canApprove = execution.status === "paused" || execution.status === "awaiting_approval"

          return (
            <div
              key={execution.id}
              className="rounded-md bg-amber-50 border border-amber-200 p-3 space-y-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-sm truncate">{execution.workflow_name}</p>
                  {execution.waiting_for && (
                    <p className="text-xs text-amber-700">Waiting for: {execution.waiting_for}</p>
                  )}
                  <p className="text-xs text-muted-foreground mt-1">Waiting for {waitTime}</p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {canApprove ? (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => onApprove(execution.id)}
                    className="text-xs bg-amber-600 hover:bg-amber-700"
                  >
                    <CheckCircle2 className="h-3 w-3 mr-1" />
                    Approve & Continue
                  </Button>
                ) : null}
                {/* TOMBSTONE (§1.3, dangling-link sweep template class, 2026-09-02):
                    an "Open Workflow" Link to `/workflows/${execution.id}` stood in
                    the else-branch above. app/workflows has no [id] child; the
                    execution detail lives on THIS page — the "View Details" button
                    below calls onViewDetail → loadExecutionDetails →
                    getWorkflowExecutionDetails (app/workflows/workflows-content.tsx:121),
                    which opens the inline run/steps panel. Two controls for one
                    destination, one of them a 404, so the dead one is gone. */}
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onViewDetail(execution.id)}
                  className="text-xs"
                >
                  <Eye className="h-3 w-3 mr-1" />
                  View Details
                </Button>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
