"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { XCircle, RefreshCw, Loader2, ExternalLink, CheckCircle2 } from "lucide-react"
import { formatDistanceToNow } from "date-fns"
import Link from "next/link"

interface FailedExecution {
  id: string
  workflow_name: string
  error_message: string
  started_at: string
  affected_record_id?: string
  affected_record_type?: string
}

interface FailedRunsPanelProps {
  failedExecutions: FailedExecution[]
  onRetry: (executionId: string) => Promise<void>
  onViewDetail: (executionId: string) => void
  retrying: string | null
}

export function FailedRunsPanel({ failedExecutions, onRetry, onViewDetail, retrying }: FailedRunsPanelProps) {
  if (failedExecutions.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            No Failed Runs
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">All automations are running smoothly.</p>
        </CardContent>
      </Card>
    )
  }

  const getRecordLink = (type?: string, id?: string) => {
    if (!type || !id) return null
    const routes: Record<string, string> = {
      contact: `/crm`,
      transaction: `/dashboard/transactions`,
      listing: `/dashboard/listings`,
      lead: `/crm`,
    }
    return routes[type] || null
  }

  return (
    <Card className="border-red-200">
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 text-red-700">
          <XCircle className="h-4 w-4" />
          Failed Runs ({failedExecutions.length})
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {failedExecutions.map((execution) => {
          const recordLink = getRecordLink(execution.affected_record_type, execution.affected_record_id)
          const isRetrying = retrying === execution.id

          return (
            <div
              key={execution.id}
              className="rounded-md bg-red-50 border border-red-200 p-3 space-y-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium text-sm truncate">{execution.workflow_name}</p>
                  <p className="text-xs text-red-700 line-clamp-2">{execution.error_message}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {formatDistanceToNow(new Date(execution.started_at), { addSuffix: true })}
                  </p>
                </div>
              </div>

              {recordLink && execution.affected_record_id && (
                <Link
                  href={recordLink}
                  className="inline-flex items-center gap-1 text-xs text-blue-600 hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  View affected {execution.affected_record_type}
                </Link>
              )}

              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onRetry(execution.id)}
                  disabled={isRetrying}
                  className="text-xs"
                >
                  {isRetrying ? (
                    <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3 w-3 mr-1" />
                  )}
                  Retry
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onViewDetail(execution.id)}
                  className="text-xs"
                >
                  View Detail
                </Button>
              </div>
            </div>
          )
        })}
      </CardContent>
    </Card>
  )
}
