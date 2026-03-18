"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Scale, CheckCircle, XCircle, AlertTriangle } from "lucide-react"
import Link from "next/link"

interface Exception {
  id: string
  transaction_id: string
  check_type: string
  check_label: string
  status: string
  is_blocking: boolean
  failure_reason?: string | null
  transaction?: {
    property_address: string
    stage: string
  }
}

interface ExceptionReviewPanelProps {
  exceptions: Exception[]
  onApproveException?: (id: string, transactionId: string) => Promise<void>
  onRejectException?: (id: string, transactionId: string) => Promise<void>
}

export function ExceptionReviewPanel({ 
  exceptions,
  onApproveException,
  onRejectException,
}: ExceptionReviewPanelProps) {
  // Exceptions requiring decision (needs_review status)
  const pendingDecisions = exceptions.filter(e => e.status === "needs_review")
  const escalated = exceptions.filter(e => e.is_blocking && e.status === "fail")

  if (exceptions.length === 0) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Scale className="h-5 w-5 text-muted-foreground" />
            Exception Review
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <div className="rounded-full bg-green-500/10 p-3 mb-3">
              <Scale className="h-6 w-6 text-green-600" />
            </div>
            <p className="text-sm text-muted-foreground">No exceptions requiring decision</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Scale className="h-5 w-5 text-muted-foreground" />
            Exception Review
          </CardTitle>
          <div className="flex items-center gap-2">
            {pendingDecisions.length > 0 && (
              <Badge className="bg-orange-500 text-white">{pendingDecisions.length} Pending</Badge>
            )}
            {escalated.length > 0 && (
              <Badge variant="destructive">{escalated.length} Escalated</Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {pendingDecisions.slice(0, 3).map((exception) => (
          <div
            key={exception.id}
            className="rounded-lg border p-3 space-y-3"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-orange-500" />
                  <span className="font-medium text-sm">{exception.check_label}</span>
                </div>
                {exception.transaction?.property_address && (
                  <p className="text-xs text-muted-foreground pl-6">
                    {exception.transaction.property_address}
                  </p>
                )}
                {exception.failure_reason && (
                  <p className="text-xs text-muted-foreground pl-6 line-clamp-2">
                    Reason: {exception.failure_reason}
                  </p>
                )}
              </div>
              <Badge variant="outline" className="shrink-0">
                {exception.transaction?.stage || "Unknown"}
              </Badge>
            </div>

            <div className="flex items-center gap-2 pl-6">
              {onApproveException && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-green-600 border-green-600 hover:bg-green-50"
                  onClick={() => onApproveException(exception.id, exception.transaction_id)}
                >
                  <CheckCircle className="h-4 w-4 mr-1" />
                  Waive
                </Button>
              )}
              {onRejectException && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive border-destructive hover:bg-destructive/10"
                  onClick={() => onRejectException(exception.id, exception.transaction_id)}
                >
                  <XCircle className="h-4 w-4 mr-1" />
                  Reject
                </Button>
              )}
              <Button variant="ghost" size="sm" asChild>
                <Link href={`/dashboard/transactions/${exception.transaction_id}`}>
                  View Deal
                </Link>
              </Button>
            </div>
          </div>
        ))}

        {escalated.length > 0 && pendingDecisions.length < 3 && (
          <div className="border-t pt-3 mt-3">
            <p className="text-xs font-medium text-destructive mb-2">Escalated Issues</p>
            {escalated.slice(0, 2).map((e) => (
              <div key={e.id} className="flex items-center justify-between py-2">
                <div className="flex items-center gap-2">
                  <XCircle className="h-4 w-4 text-destructive" />
                  <span className="text-sm">{e.check_label}</span>
                </div>
                <Button variant="ghost" size="sm" asChild>
                  <Link href={`/dashboard/transactions/${e.transaction_id}`}>
                    View
                  </Link>
                </Button>
              </div>
            ))}
          </div>
        )}

        {(pendingDecisions.length > 3 || escalated.length > 2) && (
          <Button variant="outline" className="w-full" asChild>
            <Link href="#transactions">
              View All Exceptions
            </Link>
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
