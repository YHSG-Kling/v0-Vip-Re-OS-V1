"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  ArrowRightLeft,
  Clock,
  AlertTriangle,
  CheckCircle2,
  ArrowRight,
  User,
  Timer,
} from "lucide-react"
import Link from "next/link"

interface HandoffMetric {
  label: string
  value: number
  target: number
  unit: string
}

interface HandoffIssue {
  contact_id: string
  contact_name: string
  handoff_id: string
  issue_type: "late_first_touch" | "missed_opportunity" | "timing_issue" | "no_follow_up"
  time_since_handoff_hours: number
  coaching_tip: string
  urgency: "critical" | "high" | "medium"
}

interface HandoffCoachingPanelProps {
  metrics?: HandoffMetric[]
  issues?: HandoffIssue[]
  totalHandoffs?: number
  successRate?: number
  agentId?: string
  brokerageId?: string
}

const issueTypeLabels = {
  late_first_touch: "Late First Touch",
  missed_opportunity: "Missed Opportunity",
  timing_issue: "Timing Issue",
  no_follow_up: "No Follow-up",
}

const urgencyColors = {
  critical: "bg-red-100 text-red-700 border-red-200",
  high: "bg-amber-100 text-amber-700 border-amber-200",
  medium: "bg-blue-100 text-blue-700 border-blue-200",
}

export function HandoffCoachingPanel({
  metrics = [],
  issues = [],
  totalHandoffs = 0,
  successRate = 0,
}: HandoffCoachingPanelProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <ArrowRightLeft className="h-5 w-5 text-indigo-500" />
              AI ISA Handoff Coaching
            </CardTitle>
            <CardDescription>Follow-through after AI qualification</CardDescription>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/dashboard/voice/isa">
              AI ISA Dashboard
              <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Handoff Summary */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border bg-card p-3">
            <p className="text-xs text-muted-foreground">Total Handoffs (7d)</p>
            <p className="text-xl font-semibold">{totalHandoffs}</p>
          </div>
          <div className="rounded-lg border bg-card p-3">
            <p className="text-xs text-muted-foreground">Success Rate</p>
            <p className="text-xl font-semibold text-green-600">{successRate}%</p>
            <Progress value={successRate} className="mt-2 h-1" />
          </div>
        </div>

        {/* Handoff Metrics */}
        <div className="space-y-2">
          {metrics.map((metric, idx) => (
            <div key={idx} className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">{metric.label}</span>
              <div className="flex items-center gap-2">
                <span className="font-medium">
                  {metric.value}
                  {metric.unit}
                </span>
                <span className="text-xs text-muted-foreground">
                  (target: {metric.target}{metric.unit})
                </span>
              </div>
            </div>
          ))}
        </div>

        {/* Handoff Issues */}
        {issues.length > 0 ? (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-foreground">Needs Attention</h4>
            {issues.slice(0, 3).map((issue, idx) => (
              <div
                key={idx}
                className={`rounded-lg border p-3 ${urgencyColors[issue.urgency].replace("text-", "bg-").replace("border-", "")}`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <User className="h-4 w-4 text-muted-foreground" />
                      <Link
                        href={`/contacts/${issue.contact_id}`}
                        className="text-sm font-medium hover:underline"
                      >
                        {issue.contact_name}
                      </Link>
                      <Badge variant="outline" className={urgencyColors[issue.urgency]}>
                        {issueTypeLabels[issue.issue_type]}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">{issue.coaching_tip}</p>
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Timer className="h-3 w-3" />
                      {issue.time_since_handoff_hours}h since handoff
                    </div>
                  </div>
                  <Button variant="outline" size="sm" asChild>
                    <Link href={`/contacts/${issue.contact_id}`}>
                      Follow Up
                    </Link>
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg bg-green-50 p-3 text-green-700">
            <CheckCircle2 className="h-4 w-4" />
            <span className="text-sm">All handoffs followed up on time</span>
          </div>
        )}

        {totalHandoffs === 0 && (
          <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-4 text-muted-foreground">
            <ArrowRightLeft className="h-4 w-4" />
            <span className="text-sm">No AI ISA handoffs in the past 7 days</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
