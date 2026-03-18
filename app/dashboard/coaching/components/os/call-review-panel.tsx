"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Phone,
  Play,
  Clock,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Star,
  MessageSquareText,
} from "lucide-react"
import Link from "next/link"

interface CallCoachingInsight {
  call_id: string
  contact_name: string
  contact_id: string
  call_date: string
  duration_minutes: number
  coaching_score: number
  insight_type: "missed_moment" | "best_practice" | "objection" | "recommendation"
  insight_content: string
  has_transcript: boolean
}

interface CallSummary {
  total_calls: number
  avg_coaching_score: number
  calls_needing_review: number
  improvement_trend: "up" | "down" | "flat"
}

interface CallReviewPanelProps {
  insights: CallCoachingInsight[]
  summary: CallSummary | null
}

const insightTypeConfig = {
  missed_moment: { icon: AlertTriangle, color: "text-amber-500", bg: "bg-amber-50 border-amber-200" },
  best_practice: { icon: Star, color: "text-green-500", bg: "bg-green-50 border-green-200" },
  objection: { icon: MessageSquareText, color: "text-purple-500", bg: "bg-purple-50 border-purple-200" },
  recommendation: { icon: TrendingUp, color: "text-blue-500", bg: "bg-blue-50 border-blue-200" },
}

export function CallReviewPanel({ insights, summary }: CallReviewPanelProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Phone className="h-5 w-5 text-emerald-500" />
              Call Review
            </CardTitle>
            <CardDescription>Transcript coaching and missed moments</CardDescription>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/dashboard/voice">
              All Calls
              <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Call Summary Stats */}
        {summary && (
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg border bg-card p-2 text-center">
              <p className="text-lg font-semibold">{summary.total_calls}</p>
              <p className="text-xs text-muted-foreground">Total Calls</p>
            </div>
            <div className="rounded-lg border bg-card p-2 text-center">
              <div className="flex items-center justify-center gap-1">
                <p className="text-lg font-semibold">{summary.avg_coaching_score}</p>
                {summary.improvement_trend === "up" ? (
                  <TrendingUp className="h-3 w-3 text-green-500" />
                ) : summary.improvement_trend === "down" ? (
                  <TrendingDown className="h-3 w-3 text-red-500" />
                ) : null}
              </div>
              <p className="text-xs text-muted-foreground">Avg Score</p>
            </div>
            <div className="rounded-lg border bg-card p-2 text-center">
              <p className="text-lg font-semibold text-amber-600">{summary.calls_needing_review}</p>
              <p className="text-xs text-muted-foreground">Need Review</p>
            </div>
          </div>
        )}

        {/* Coaching Insights */}
        {insights.length > 0 ? (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-foreground">Recent Coaching Insights</h4>
            {insights.slice(0, 4).map((insight, idx) => {
              const config = insightTypeConfig[insight.insight_type]
              const Icon = config.icon

              return (
                <div
                  key={idx}
                  className={`rounded-lg border p-3 ${config.bg}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2">
                      <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${config.color}`} />
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/dashboard/contacts/${insight.contact_id}`}
                            className="text-sm font-medium hover:underline"
                          >
                            {insight.contact_name}
                          </Link>
                          <Badge variant="outline" className="text-xs">
                            {insight.coaching_score}/100
                          </Badge>
                        </div>
                        <p className="text-sm text-muted-foreground">{insight.insight_content}</p>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <Clock className="h-3 w-3" />
                          {insight.duration_minutes}m
                          <span>•</span>
                          {new Date(insight.call_date).toLocaleDateString()}
                        </div>
                      </div>
                    </div>
                    {insight.has_transcript && (
                      <Button variant="ghost" size="sm" asChild>
                        <Link href={`/dashboard/voice/review/${insight.call_id}`}>
                          <Play className="h-4 w-4" />
                        </Link>
                      </Button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-4 text-muted-foreground">
            <Phone className="h-4 w-4" />
            <span className="text-sm">No recent call coaching insights available</span>
          </div>
        )}

        {insights.length === 0 && !summary && (
          <div className="flex items-center gap-2 rounded-lg bg-green-50 p-3 text-green-700">
            <CheckCircle2 className="h-4 w-4" />
            <span className="text-sm">Call performance is on track</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
