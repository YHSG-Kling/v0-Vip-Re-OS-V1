"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DollarSign,
  Clock,
  CheckCircle2,
  AlertTriangle,
  PauseCircle,
  ChevronRight,
  FileText,
} from "lucide-react"
import Link from "next/link"

interface CommissionRecord {
  id: string
  transactionId: string
  propertyAddress?: string
  grossCommission: number
  agentNet: number
  status: "pending" | "approved" | "paid" | "held" | "delayed"
  createdAt: string
  closeDate?: string
  blockerReason?: string
}

interface CommissionSummary {
  pending: number
  approved: number
  paid: number
  held: number
  totalPending: number
  totalApproved: number
  totalPaid: number
}

interface CommissionIntelligencePanelProps {
  commissions: CommissionRecord[]
  summary?: CommissionSummary
  transactionLinkPrefix?: string // e.g., "/dashboard/transactions/"
}

const EMPTY_SUMMARY: CommissionSummary = {
  pending: 0, approved: 0, paid: 0, held: 0, totalPending: 0, totalApproved: 0, totalPaid: 0,
}

export function CommissionIntelligencePanel({
  commissions = [],
  // Default so a caller that omits summary can never crash on summary.pending.
  summary = EMPTY_SUMMARY,
  transactionLinkPrefix = "/dashboard/transactions/",
}: CommissionIntelligencePanelProps) {
  const formatCurrency = (val: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(val)

  const statusConfig = {
    pending: {
      icon: <Clock className="h-4 w-4" />,
      color: "text-amber-600",
      bg: "bg-amber-50 border-amber-200",
      label: "Pending",
    },
    approved: {
      icon: <CheckCircle2 className="h-4 w-4" />,
      color: "text-blue-600",
      bg: "bg-blue-50 border-blue-200",
      label: "Approved",
    },
    paid: {
      icon: <CheckCircle2 className="h-4 w-4" />,
      color: "text-green-600",
      bg: "bg-green-50 border-green-200",
      label: "Paid",
    },
    held: {
      icon: <PauseCircle className="h-4 w-4" />,
      color: "text-red-600",
      bg: "bg-red-50 border-red-200",
      label: "Held",
    },
    delayed: {
      icon: <AlertTriangle className="h-4 w-4" />,
      color: "text-orange-600",
      bg: "bg-orange-50 border-orange-200",
      label: "Delayed",
    },
  }

  const topPendingCommissions = commissions
    .filter((c) => c.status === "pending" || c.status === "approved")
    .sort((a, b) => b.agentNet - a.agentNet)
    .slice(0, 5)

  const heldCommissions = commissions.filter(
    (c) => c.status === "held" || c.status === "delayed"
  )

  return (
    <Card className="border-green-200">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-green-100">
              <DollarSign className="h-5 w-5 text-green-700" />
            </div>
            <div>
              <CardTitle className="text-base">Commission Intelligence</CardTitle>
              <CardDescription>Track commission status and payouts</CardDescription>
            </div>
          </div>
          <Link href="/dashboard/financials/commissions">
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
          <div className="p-2 rounded-lg bg-amber-50 border border-amber-200 text-center">
            <p className="text-xs text-amber-700">Pending</p>
            <p className="text-lg font-bold text-amber-600">{summary.pending}</p>
            <p className="text-xs text-amber-600">{formatCurrency(summary.totalPending)}</p>
          </div>
          <div className="p-2 rounded-lg bg-blue-50 border border-blue-200 text-center">
            <p className="text-xs text-blue-700">Approved</p>
            <p className="text-lg font-bold text-blue-600">{summary.approved}</p>
            <p className="text-xs text-blue-600">{formatCurrency(summary.totalApproved)}</p>
          </div>
          <div className="p-2 rounded-lg bg-green-50 border border-green-200 text-center">
            <p className="text-xs text-green-700">Paid</p>
            <p className="text-lg font-bold text-green-600">{summary.paid}</p>
            <p className="text-xs text-green-600">{formatCurrency(summary.totalPaid)}</p>
          </div>
          <div className="p-2 rounded-lg bg-red-50 border border-red-200 text-center">
            <p className="text-xs text-red-700">Held</p>
            <p className="text-lg font-bold text-red-600">{summary.held}</p>
          </div>
        </div>

        {/* Top Pending by Amount */}
        {topPendingCommissions.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2">Top Pending Commissions</h4>
            <div className="space-y-2">
              {topPendingCommissions.map((commission) => {
                const config = statusConfig[commission.status]
                return (
                  <div
                    key={commission.id}
                    className="flex items-center justify-between p-2 rounded-lg bg-muted/50 hover:bg-muted transition-colors"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-1">
                      <div className={`p-1 rounded ${config.bg}`}>
                        <span className={config.color}>{config.icon}</span>
                      </div>
                      <div className="min-w-0 flex-1">
                        {transactionLinkPrefix && commission.transactionId ? (
                          <Link
                            href={`${transactionLinkPrefix}${commission.transactionId}`}
                            className="text-sm font-medium truncate block hover:text-violet-600"
                          >
                            {commission.propertyAddress ||
                              `Transaction #${commission.transactionId.slice(0, 8)}`}
                          </Link>
                        ) : (
                          <p className="text-sm font-medium truncate">
                            {commission.propertyAddress ||
                              `Transaction #${commission.transactionId.slice(0, 8)}`}
                          </p>
                        )}
                        {commission.closeDate && (
                          <p className="text-xs text-muted-foreground">
                            Close: {new Date(commission.closeDate).toLocaleDateString()}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-bold text-green-600">
                        {formatCurrency(commission.agentNet)}
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

        {/* Held/Delayed with Reasons */}
        {heldCommissions.length > 0 && (
          <div className="p-3 rounded-lg border border-red-200 bg-red-50/50">
            <h4 className="text-sm font-medium text-red-800 mb-2 flex items-center gap-2">
              <AlertTriangle className="h-4 w-4" />
              Commissions Requiring Attention ({heldCommissions.length})
            </h4>
            <div className="space-y-2">
              {heldCommissions.slice(0, 3).map((commission) => (
                <div
                  key={commission.id}
                  className="flex items-center justify-between p-2 rounded bg-white border border-red-100"
                >
                  <div>
                    <p className="text-sm font-medium">
                      {commission.propertyAddress ||
                        `Transaction #${commission.transactionId.slice(0, 8)}`}
                    </p>
                    {commission.blockerReason && (
                      <p className="text-xs text-red-600">{commission.blockerReason}</p>
                    )}
                  </div>
                  <span className="text-sm font-bold text-red-600">
                    {formatCurrency(commission.agentNet)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty State */}
        {commissions.length === 0 && (
          <div className="text-center py-6 text-muted-foreground">
            <FileText className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No commission records found</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
