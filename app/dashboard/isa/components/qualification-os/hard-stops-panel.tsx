"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  ShieldAlert,
  XCircle,
  Clock,
  AlertTriangle,
  FileWarning,
  UserX,
  Ban,
  Eye,
  ArrowRight,
} from "lucide-react"
import Link from "next/link"

type HardStopReason =
  | "insufficient_qualification"
  | "no_positive_response"
  | "cooldown_active"
  | "compliance_restriction"
  | "duplicate_data_issue"
  | "human_review_needed"
  | "transfer_blocked"

interface HardStop {
  id: string
  contactId: string
  contactName: string
  reason: HardStopReason
  reasonDetail: string
  blockedSince: string
  canRetryAt: string | null
}

interface HardStopsPanelProps {
  hardStops: HardStop[]
  onRequestReview?: (hardStopId: string) => void
}

const reasonConfig: Record<
  HardStopReason,
  { label: string; icon: typeof XCircle; color: string; bgColor: string }
> = {
  insufficient_qualification: {
    label: "Insufficient Qualification",
    icon: XCircle,
    color: "text-red-600",
    bgColor: "bg-red-50",
  },
  no_positive_response: {
    label: "No Positive Response",
    icon: UserX,
    color: "text-amber-600",
    bgColor: "bg-amber-50",
  },
  cooldown_active: {
    label: "Cooldown Active",
    icon: Clock,
    color: "text-blue-600",
    bgColor: "bg-blue-50",
  },
  compliance_restriction: {
    label: "Compliance Restriction",
    icon: ShieldAlert,
    color: "text-red-700",
    bgColor: "bg-red-100",
  },
  duplicate_data_issue: {
    label: "Duplicate / Data Issue",
    icon: FileWarning,
    color: "text-orange-600",
    bgColor: "bg-orange-50",
  },
  human_review_needed: {
    label: "Human Review Needed",
    icon: Eye,
    color: "text-purple-600",
    bgColor: "bg-purple-50",
  },
  transfer_blocked: {
    label: "Transfer Blocked",
    icon: Ban,
    color: "text-gray-600",
    bgColor: "bg-gray-100",
  },
}

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))

  if (diffHours < 24) return `${diffHours}h ago`
  return `${Math.floor(diffHours / 24)}d ago`
}

export function HardStopsPanel({ hardStops, onRequestReview }: HardStopsPanelProps) {
  const groupedByReason = hardStops.reduce((acc, stop) => {
    if (!acc[stop.reason]) acc[stop.reason] = []
    acc[stop.reason].push(stop)
    return acc
  }, {} as Record<HardStopReason, HardStop[]>)

  const reasonCounts = Object.entries(groupedByReason).map(([reason, stops]) => ({
    reason: reason as HardStopReason,
    count: stops.length,
  }))

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-red-600" />
            Hard Stops
          </CardTitle>
          <Badge variant="destructive" className="text-xs">
            {hardStops.length} blocked
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        {hardStops.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <ShieldAlert className="h-10 w-10 text-muted-foreground/50 mb-3" />
            <p className="text-sm text-muted-foreground">No hard stops</p>
            <p className="text-xs text-muted-foreground mt-1">
              All leads are progressing through qualification
            </p>
          </div>
        ) : (
          <>
            {/* Reason Summary */}
            <div className="flex flex-wrap gap-2 mb-3 pb-3 border-b">
              {reasonCounts.map(({ reason, count }) => {
                const config = reasonConfig[reason]
                return (
                  <div
                    key={reason}
                    className={`${config.bgColor} rounded-md px-2 py-1 flex items-center gap-1`}
                  >
                    <config.icon className={`h-3 w-3 ${config.color}`} />
                    <span className={`text-xs font-medium ${config.color}`}>{count}</span>
                    <span className="text-xs text-muted-foreground">{config.label}</span>
                  </div>
                )
              })}
            </div>

            {/* Hard Stop List */}
            <ScrollArea className="h-[200px]">
              <div className="space-y-2 pr-2">
                {hardStops.map((stop) => {
                  const config = reasonConfig[stop.reason]
                  return (
                    <div
                      key={stop.id}
                      className={`${config.bgColor} border rounded-lg p-2.5`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <config.icon className={`h-4 w-4 ${config.color} shrink-0`} />
                          <div>
                            <p className="text-sm font-medium">{stop.contactName}</p>
                            <p className="text-xs text-muted-foreground">{config.label}</p>
                          </div>
                        </div>
                        <span className="text-[10px] text-muted-foreground shrink-0">
                          {formatTimeAgo(stop.blockedSince)}
                        </span>
                      </div>

                      <p className="text-xs text-muted-foreground mt-1.5 pl-6">
                        {stop.reasonDetail}
                      </p>

                      {stop.canRetryAt && (
                        <p className="text-xs text-blue-600 mt-1 pl-6">
                          Can retry: {new Date(stop.canRetryAt).toLocaleDateString()}
                        </p>
                      )}

                      <div className="flex items-center justify-end mt-2 gap-1">
                        {stop.reason === "human_review_needed" && onRequestReview && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-xs"
                            onClick={() => onRequestReview(stop.id)}
                          >
                            <Eye className="h-3 w-3 mr-1" />
                            Review
                          </Button>
                        )}
                        <Link href={`/dashboard/contacts/${stop.contactId}`}>
                          <Button variant="ghost" size="sm" className="h-6 text-xs">
                            View
                            <ArrowRight className="h-3 w-3 ml-1" />
                          </Button>
                        </Link>
                      </div>
                    </div>
                  )
                })}
              </div>
            </ScrollArea>
          </>
        )}
      </CardContent>
    </Card>
  )
}
