"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { TrendingUp, CheckCircle2, FileText, Home, Heart } from "lucide-react"

interface ValueMetrics {
  milestonesCompleted?: number
  contentSent?: number
  showingsArranged?: number
  offersSubmitted?: number
  trustCapitalScore?: number
}

interface ValueDeliveredPanelProps {
  contactId: string
  agentId: string
  valueMetrics?: ValueMetrics | null
}

export function ValueDeliveredPanel({
  contactId,
  agentId,
  valueMetrics,
}: ValueDeliveredPanelProps) {
  const metrics = valueMetrics || {}

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-emerald-600" />
          Value Delivered
        </CardTitle>
      </CardHeader>
      <CardContent>
        {/* Metric row */}
        <div className="grid grid-cols-4 gap-3 mb-4">
          <div className="text-center p-2 bg-gray-50 rounded-lg">
            <CheckCircle2 className="h-4 w-4 mx-auto text-emerald-500 mb-1" />
            <p className="text-lg font-bold">{metrics.milestonesCompleted || 0}</p>
            <p className="text-xs text-muted-foreground">Milestones</p>
          </div>
          <div className="text-center p-2 bg-gray-50 rounded-lg">
            <FileText className="h-4 w-4 mx-auto text-blue-500 mb-1" />
            <p className="text-lg font-bold">{metrics.contentSent || 0}</p>
            <p className="text-xs text-muted-foreground">Updates Sent</p>
          </div>
          <div className="text-center p-2 bg-gray-50 rounded-lg">
            <Home className="h-4 w-4 mx-auto text-indigo-500 mb-1" />
            <p className="text-lg font-bold">{metrics.showingsArranged || 0}</p>
            <p className="text-xs text-muted-foreground">Showings</p>
          </div>
          <div className="text-center p-2 bg-gray-50 rounded-lg">
            <Heart className="h-4 w-4 mx-auto text-rose-500 mb-1" />
            <p className="text-lg font-bold">{metrics.trustCapitalScore || "--"}</p>
            <p className="text-xs text-muted-foreground">Trust Score</p>
          </div>
        </div>

        {/* Trust Capital progress bar */}
        {metrics.trustCapitalScore !== undefined && metrics.trustCapitalScore !== null && (
          <div className="mb-2">
            <div className="flex justify-between text-xs text-muted-foreground mb-1">
              <span>Trust Capital</span>
              <span>{metrics.trustCapitalScore}/100</span>
            </div>
            <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-emerald-500 transition-all duration-500"
                style={{ width: `${metrics.trustCapitalScore}%` }}
              />
            </div>
          </div>
        )}

        {!valueMetrics && (
          <p className="text-xs text-muted-foreground text-center py-2">
            Value tracking builds as you work with this contact
          </p>
        )}
      </CardContent>
    </Card>
  )
}
