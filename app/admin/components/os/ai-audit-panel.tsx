"use client"

import Link from "next/link"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Brain, ThumbsUp, ThumbsDown, TrendingUp, ExternalLink } from "lucide-react"

interface AiFeedbackSummary {
  totalFeedback: number
  positiveCount: number
  negativeCount: number
  approvalRate: number
  topNegativeThemes: string[]
  improvementApplied: boolean
}

interface AiAuditPanelProps {
  feedbackSummary: AiFeedbackSummary
  weeklyTrend: number // percentage change
}

export function AiAuditPanel({ feedbackSummary, weeklyTrend }: AiAuditPanelProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-lg flex items-center gap-2">
            <Brain className="h-5 w-5" />
            AI Quality Audit
          </CardTitle>
          <Link href="/admin/ai-audit">
            <Button variant="ghost" size="sm" className="gap-1">
              <ExternalLink className="h-3 w-3" />
              Full Audit
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Approval Rate */}
        <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
          <div>
            <p className="text-sm text-muted-foreground">Approval Rate</p>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-bold">{feedbackSummary.approvalRate.toFixed(1)}%</span>
              {weeklyTrend !== 0 && (
                <Badge variant={weeklyTrend > 0 ? "default" : "destructive"} className={weeklyTrend > 0 ? "bg-green-600" : ""}>
                  <TrendingUp className={`h-3 w-3 mr-1 ${weeklyTrend < 0 ? "rotate-180" : ""}`} />
                  {Math.abs(weeklyTrend).toFixed(1)}%
                </Badge>
              )}
            </div>
          </div>
          <div className="h-16 w-16">
            <svg viewBox="0 0 100 100" className="transform -rotate-90">
              <circle cx="50" cy="50" r="40" stroke="currentColor" strokeWidth="8" fill="none" className="text-muted" />
              <circle
                cx="50"
                cy="50"
                r="40"
                stroke="currentColor"
                strokeWidth="8"
                fill="none"
                strokeDasharray={`${feedbackSummary.approvalRate * 2.51} 251`}
                className={feedbackSummary.approvalRate >= 80 ? "text-green-500" : feedbackSummary.approvalRate >= 60 ? "text-yellow-500" : "text-red-500"}
              />
            </svg>
          </div>
        </div>

        {/* Feedback Counts */}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex items-center gap-2 p-2 bg-green-500/10 rounded-lg">
            <ThumbsUp className="h-4 w-4 text-green-600" />
            <div>
              <p className="text-lg font-bold">{feedbackSummary.positiveCount}</p>
              <p className="text-xs text-muted-foreground">Positive</p>
            </div>
          </div>
          <div className="flex items-center gap-2 p-2 bg-red-500/10 rounded-lg">
            <ThumbsDown className="h-4 w-4 text-red-600" />
            <div>
              <p className="text-lg font-bold">{feedbackSummary.negativeCount}</p>
              <p className="text-xs text-muted-foreground">Negative</p>
            </div>
          </div>
        </div>

        {/* Top Negative Themes */}
        {feedbackSummary.topNegativeThemes.length > 0 && (
          <div>
            <p className="text-sm font-medium mb-2">Top Issues</p>
            <div className="flex flex-wrap gap-1">
              {feedbackSummary.topNegativeThemes.slice(0, 5).map((theme, idx) => (
                <Badge key={idx} variant="outline" className="text-xs">
                  {theme}
                </Badge>
              ))}
            </div>
          </div>
        )}

        {/* Improvement Status */}
        {feedbackSummary.improvementApplied && (
          <div className="p-2 bg-blue-500/10 rounded-lg border border-blue-500/20">
            <p className="text-xs text-blue-600">Model improvements applied based on feedback</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
