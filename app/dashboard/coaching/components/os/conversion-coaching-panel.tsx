"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  TrendingDown,
  TrendingUp,
  Users,
  Target,
  ArrowRight,
  AlertCircle,
  CheckCircle2,
} from "lucide-react"
import Link from "next/link"

interface ConversionMetric {
  label: string
  current: number
  previous: number
  target: number
  unit: string
}

interface ConversionIssue {
  stage: string
  issue: string
  impact: string
  contact_count: number
  contact_ids: string[]
}

interface ConversionCoachingPanelProps {
  metrics: ConversionMetric[]
  issues: ConversionIssue[]
  topImprovement: string | null
}

export function ConversionCoachingPanel({
  metrics,
  issues,
  topImprovement,
}: ConversionCoachingPanelProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Target className="h-5 w-5 text-blue-500" />
              Conversion Coaching
            </CardTitle>
            <CardDescription>Where opportunities are being lost</CardDescription>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/dashboard/buyers">
              View Pipeline
              <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Top Improvement Highlight */}
        {topImprovement && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 p-3">
            <div className="flex items-start gap-2">
              <AlertCircle className="mt-0.5 h-4 w-4 text-blue-600" />
              <div>
                <p className="text-sm font-medium text-blue-900">Next Best Improvement</p>
                <p className="text-sm text-blue-700">{topImprovement}</p>
              </div>
            </div>
          </div>
        )}

        {/* Conversion Metrics */}
        <div className="space-y-3">
          {metrics.map((metric, idx) => {
            const change = metric.current - metric.previous
            const changePercent = metric.previous > 0 ? ((change / metric.previous) * 100).toFixed(0) : 0
            const isImproving = change >= 0
            const progressToTarget = Math.min((metric.current / metric.target) * 100, 100)

            return (
              <div key={idx} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{metric.label}</span>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {metric.current}
                      {metric.unit}
                    </span>
                    <Badge
                      variant="outline"
                      className={isImproving ? "text-green-600" : "text-red-600"}
                    >
                      {isImproving ? (
                        <TrendingUp className="mr-1 h-3 w-3" />
                      ) : (
                        <TrendingDown className="mr-1 h-3 w-3" />
                      )}
                      {changePercent}%
                    </Badge>
                  </div>
                </div>
                <Progress value={progressToTarget} className="h-2" />
                <p className="text-xs text-muted-foreground">Target: {metric.target}{metric.unit}</p>
              </div>
            )
          })}
        </div>

        {/* Conversion Issues */}
        {issues.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-foreground">Opportunities Being Lost</h4>
            {issues.slice(0, 3).map((issue, idx) => (
              <div
                key={idx}
                className="flex items-start justify-between rounded-lg border bg-card p-3"
              >
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">{issue.stage}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {issue.contact_count} contact{issue.contact_count !== 1 ? "s" : ""}
                    </span>
                  </div>
                  <p className="text-sm font-medium text-foreground">{issue.issue}</p>
                  <p className="text-xs text-muted-foreground">{issue.impact}</p>
                </div>
                {issue.contact_ids.length > 0 && (
                  <Button variant="ghost" size="sm" asChild>
                    <Link href={`/dashboard/contacts?ids=${issue.contact_ids.slice(0, 5).join(",")}`}>
                      <Users className="mr-1 h-4 w-4" />
                      View
                    </Link>
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}

        {issues.length === 0 && (
          <div className="flex items-center gap-2 rounded-lg bg-green-50 p-3 text-green-700">
            <CheckCircle2 className="h-4 w-4" />
            <span className="text-sm">Pipeline conversion is healthy</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
