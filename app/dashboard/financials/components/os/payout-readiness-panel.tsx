"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Users,
  CheckCircle2,
  AlertTriangle,
  Clock,
  ChevronRight,
  FileText,
  XCircle,
} from "lucide-react"
import Link from "next/link"

interface PayoutFile {
  id: string
  agentId: string
  agentName?: string
  transactionId?: string
  propertyAddress?: string
  amount: number
  status: "ready" | "blocked" | "pending_review" | "processing"
  blockerReason?: string
  closeDate?: string
  missingItems?: string[]
}

interface PayoutReadinessPanelProps {
  files: PayoutFile[]
  summary: {
    ready: number
    blocked: number
    pendingReview: number
    processing: number
    totalReady: number
    totalBlocked: number
  }
  transactionLinkPrefix?: string
}

export function PayoutReadinessPanel({
  files,
  summary,
  transactionLinkPrefix = "/dashboard/transactions/",
}: PayoutReadinessPanelProps) {
  const formatCurrency = (val: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(val)

  const statusConfig = {
    ready: {
      icon: <CheckCircle2 className="h-4 w-4" />,
      color: "text-green-600",
      bg: "bg-green-50 border-green-200",
      label: "Ready",
    },
    blocked: {
      icon: <XCircle className="h-4 w-4" />,
      color: "text-red-600",
      bg: "bg-red-50 border-red-200",
      label: "Blocked",
    },
    pending_review: {
      icon: <Clock className="h-4 w-4" />,
      color: "text-amber-600",
      bg: "bg-amber-50 border-amber-200",
      label: "Pending Review",
    },
    processing: {
      icon: <Clock className="h-4 w-4" />,
      color: "text-blue-600",
      bg: "bg-blue-50 border-blue-200",
      label: "Processing",
    },
  }

  const readyFiles = files.filter((f) => f.status === "ready")
  const blockedFiles = files.filter((f) => f.status === "blocked")
  const upcomingPayouts = files
    .filter((f) => f.closeDate && f.status !== "blocked")
    .sort((a, b) => new Date(a.closeDate!).getTime() - new Date(b.closeDate!).getTime())
    .slice(0, 5)

  return (
    <Card className="border-purple-200">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-purple-100">
              <Users className="h-5 w-5 text-purple-700" />
            </div>
            <div>
              <CardTitle className="text-base">Payout Readiness</CardTitle>
              <CardDescription>Track payout status and blockers</CardDescription>
            </div>
          </div>
          <Link href="/dashboard/financials/payouts">
            <Button variant="ghost" size="sm">
              View All
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Summary Stats */}
        <div className="grid grid-cols-4 gap-2">
          <div className="p-2 rounded-lg bg-green-50 border border-green-200 text-center">
            <p className="text-xs text-green-700">Ready</p>
            <p className="text-lg font-bold text-green-600">{summary.ready}</p>
            <p className="text-xs text-green-600">{formatCurrency(summary.totalReady)}</p>
          </div>
          <div className="p-2 rounded-lg bg-red-50 border border-red-200 text-center">
            <p className="text-xs text-red-700">Blocked</p>
            <p className="text-lg font-bold text-red-600">{summary.blocked}</p>
            <p className="text-xs text-red-600">{formatCurrency(summary.totalBlocked)}</p>
          </div>
          <div className="p-2 rounded-lg bg-amber-50 border border-amber-200 text-center">
            <p className="text-xs text-amber-700">Review</p>
            <p className="text-lg font-bold text-amber-600">{summary.pendingReview}</p>
          </div>
          <div className="p-2 rounded-lg bg-blue-50 border border-blue-200 text-center">
            <p className="text-xs text-blue-700">Processing</p>
            <p className="text-lg font-bold text-blue-600">{summary.processing}</p>
          </div>
        </div>

        {/* Blocked Files with Reasons */}
        {blockedFiles.length > 0 && (
          <div className="p-3 rounded-lg border border-red-200 bg-red-50/50">
            <h4 className="text-sm font-medium text-red-800 mb-2 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Blocked Payouts ({blockedFiles.length})
            </h4>
            <div className="space-y-2">
              {blockedFiles.slice(0, 3).map((file) => (
                <div
                  key={file.id}
                  className="flex items-start justify-between p-2 rounded bg-white border border-red-100"
                >
                  <div className="min-w-0 flex-1">
                    {transactionLinkPrefix && file.transactionId ? (
                      <Link
                        href={`${transactionLinkPrefix}${file.transactionId}`}
                        className="text-sm font-medium hover:text-violet-600 block truncate"
                      >
                        {file.propertyAddress || file.agentName || `File #${file.id.slice(0, 8)}`}
                      </Link>
                    ) : (
                      <p className="text-sm font-medium truncate">
                        {file.propertyAddress || file.agentName || `File #${file.id.slice(0, 8)}`}
                      </p>
                    )}
                    {file.blockerReason && (
                      <p className="text-xs text-red-600 mt-1">{file.blockerReason}</p>
                    )}
                    {file.missingItems && file.missingItems.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {file.missingItems.slice(0, 2).map((item, idx) => (
                          <Badge key={idx} variant="outline" className="text-xs border-red-200 text-red-600">
                            Missing: {item}
                          </Badge>
                        ))}
                        {file.missingItems.length > 2 && (
                          <Badge variant="outline" className="text-xs">
                            +{file.missingItems.length - 2} more
                          </Badge>
                        )}
                      </div>
                    )}
                  </div>
                  <span className="text-sm font-bold text-red-600 ml-2">
                    {formatCurrency(file.amount)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Upcoming Payout-Sensitive Closings */}
        {upcomingPayouts.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2">Upcoming Payout Closings</h4>
            <div className="space-y-2">
              {upcomingPayouts.map((file) => {
                const config = statusConfig[file.status]
                return (
                  <div
                    key={file.id}
                    className="flex items-center justify-between p-2 rounded-lg bg-muted/50"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <div className={`p-1 rounded ${config.bg}`}>
                        <span className={config.color}>{config.icon}</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-medium truncate">
                          {file.propertyAddress || file.agentName || `File #${file.id.slice(0, 8)}`}
                        </p>
                        {file.closeDate && (
                          <p className="text-xs text-muted-foreground">
                            Close: {new Date(file.closeDate).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="text-right ml-2">
                      <p className="text-sm font-bold text-purple-600">
                        {formatCurrency(file.amount)}
                      </p>
                      <Badge variant="outline" className={`text-xs ${config.bg} ${config.color}`}>
                        {config.label}
                      </Badge>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* Empty State */}
        {files.length === 0 && (
          <div className="text-center py-6 text-muted-foreground">
            <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No payout records found</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
