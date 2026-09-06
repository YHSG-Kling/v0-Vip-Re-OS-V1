"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import Link from "next/link"
import {
  Sparkles,
  ThumbsUp,
  ThumbsDown,
  AlertCircle,
  ArrowRight,
  TrendingUp,
  TrendingDown,
} from "lucide-react"

interface AIQualityPanelProps {
  thisWeekMetrics: {
    totalFeedback: number
    positiveRate: number
    avgRating: number
    editedResponses: number
    rejectedResponses: number
  }
  weekOverWeekChange: {
    positiveRate: number
    avgRating: number
  }
  recentIssues: Array<{
    id: string
    issueType: string
    context: string
    timestamp: string
  }>
}

export function AIQualityPanel({
  thisWeekMetrics,
  weekOverWeekChange,
  recentIssues,
}: AIQualityPanelProps) {
  const qualityLevel = thisWeekMetrics.positiveRate >= 85 ? "Excellent" :
                       thisWeekMetrics.positiveRate >= 70 ? "Good" :
                       thisWeekMetrics.positiveRate >= 50 ? "Needs Improvement" : "Critical"

  const qualityColor = thisWeekMetrics.positiveRate >= 85 ? "text-green-600" :
                       thisWeekMetrics.positiveRate >= 70 ? "text-blue-600" :
                       thisWeekMetrics.positiveRate >= 50 ? "text-amber-600" : "text-red-600"

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Sparkles className="h-4 w-4 text-primary" />
            AI Quality Monitor
          </CardTitle>
          <Badge variant="outline" className={qualityColor}>
            {qualityLevel}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Main Quality Score */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Approval Rate</span>
            <div className="flex items-center gap-2">
              <span className="font-semibold">{thisWeekMetrics.positiveRate}%</span>
              {weekOverWeekChange.positiveRate !== 0 && (
                <span className={`flex items-center text-xs ${
                  weekOverWeekChange.positiveRate > 0 ? "text-green-600" : "text-red-600"
                }`}>
                  {weekOverWeekChange.positiveRate > 0 ? (
                    <TrendingUp className="h-3 w-3" />
                  ) : (
                    <TrendingDown className="h-3 w-3" />
                  )}
                  {Math.abs(weekOverWeekChange.positiveRate)}%
                </span>
              )}
            </div>
          </div>
          <Progress value={thisWeekMetrics.positiveRate} className="h-2" />
        </div>

        {/* Stats Grid */}
        <div className="grid grid-cols-2 gap-3 text-center">
          <div className="rounded-lg border p-2">
            <div className="flex items-center justify-center gap-1">
              <ThumbsUp className="h-4 w-4 text-green-600" />
              <span className="text-lg font-bold">
                {Math.round(thisWeekMetrics.totalFeedback * (thisWeekMetrics.positiveRate / 100))}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">Approved</p>
          </div>
          <div className="rounded-lg border p-2">
            <div className="flex items-center justify-center gap-1">
              <ThumbsDown className="h-4 w-4 text-red-600" />
              <span className="text-lg font-bold">{thisWeekMetrics.rejectedResponses}</span>
            </div>
            <p className="text-xs text-muted-foreground">Rejected</p>
          </div>
        </div>

        {/* Avg Rating */}
        <div className="flex items-center justify-between rounded-lg bg-muted/50 p-3">
          <span className="text-sm">Avg Rating</span>
          <div className="flex items-center gap-2">
            <span className="text-lg font-bold">{thisWeekMetrics.avgRating.toFixed(1)}</span>
            <span className="text-sm text-muted-foreground">/ 5</span>
          </div>
        </div>

        {/* Recent Issues */}
        {recentIssues.length > 0 && (
          <div className="space-y-2">
            <h4 className="flex items-center gap-2 text-sm font-medium">
              <AlertCircle className="h-4 w-4 text-amber-500" />
              Recent Issues ({recentIssues.length})
            </h4>
            {recentIssues.slice(0, 2).map((issue) => (
              <div key={issue.id} className="rounded-lg bg-amber-50 p-2 text-sm dark:bg-amber-950/20">
                <span className="font-medium">{issue.issueType}</span>
                <p className="text-xs text-muted-foreground truncate">{issue.context}</p>
              </div>
            ))}
          </div>
        )}

        <Link href="/dashboard/ai-quality">
          <Button variant="outline" size="sm" className="w-full gap-2">
            View AI Quality Dashboard
            <ArrowRight className="h-4 w-4" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
