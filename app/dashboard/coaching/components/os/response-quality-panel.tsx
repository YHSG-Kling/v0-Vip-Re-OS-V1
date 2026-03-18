"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  MessageSquare,
  Clock,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
} from "lucide-react"
import Link from "next/link"

interface ResponseQualityMetric {
  label: string
  value: number
  target: number
  unit: string
  trend: "up" | "down" | "flat"
}

interface ObjectionOpportunity {
  objection_type: string
  frequency: number
  avg_resolution_rate: number
  coaching_tip: string
  example_contacts: string[]
}

interface ResponseSuggestion {
  context: string
  suggestion: string
  priority: "high" | "medium" | "low"
}

interface ResponseQualityPanelProps {
  metrics: ResponseQualityMetric[]
  objectionOpportunities: ObjectionOpportunity[]
  suggestions: ResponseSuggestion[]
}

export function ResponseQualityPanel({
  metrics,
  objectionOpportunities,
  suggestions,
}: ResponseQualityPanelProps) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageSquare className="h-5 w-5 text-purple-500" />
              Response Quality
            </CardTitle>
            <CardDescription>AI and human response coaching</CardDescription>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/dashboard/inbox">
              View Inbox
              <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Response Metrics */}
        <div className="grid grid-cols-2 gap-3">
          {metrics.map((metric, idx) => (
            <div key={idx} className="rounded-lg border bg-card p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{metric.label}</span>
                {metric.trend === "up" ? (
                  <TrendingUp className="h-3 w-3 text-green-500" />
                ) : metric.trend === "down" ? (
                  <TrendingDown className="h-3 w-3 text-red-500" />
                ) : (
                  <Clock className="h-3 w-3 text-muted-foreground" />
                )}
              </div>
              <p className="mt-1 text-lg font-semibold">
                {metric.value}
                {metric.unit}
              </p>
              <Progress
                value={Math.min((metric.value / metric.target) * 100, 100)}
                className="mt-2 h-1"
              />
              <p className="mt-1 text-xs text-muted-foreground">Target: {metric.target}{metric.unit}</p>
            </div>
          ))}
        </div>

        {/* Objection Handling Opportunities */}
        {objectionOpportunities.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-foreground">Objection Handling</h4>
            {objectionOpportunities.slice(0, 2).map((opp, idx) => (
              <div key={idx} className="rounded-lg border bg-amber-50 p-3">
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <Badge variant="outline" className="bg-amber-100 text-amber-700">
                        {opp.objection_type}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {opp.frequency}x this week
                      </span>
                    </div>
                    <p className="text-sm text-amber-900">{opp.coaching_tip}</p>
                    <p className="text-xs text-muted-foreground">
                      Resolution rate: {opp.avg_resolution_rate}%
                    </p>
                  </div>
                  {opp.example_contacts.length > 0 && (
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/dashboard/contacts/${opp.example_contacts[0]}`}>
                        Example
                      </Link>
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Response Coaching Suggestions */}
        {suggestions.length > 0 && (
          <div className="space-y-2">
            <h4 className="text-sm font-medium text-foreground">Coaching Suggestions</h4>
            {suggestions.slice(0, 3).map((suggestion, idx) => (
              <div
                key={idx}
                className="flex items-start gap-2 rounded-lg border bg-card p-3"
              >
                <AlertTriangle
                  className={`mt-0.5 h-4 w-4 flex-shrink-0 ${
                    suggestion.priority === "high"
                      ? "text-red-500"
                      : suggestion.priority === "medium"
                        ? "text-amber-500"
                        : "text-blue-500"
                  }`}
                />
                <div>
                  <p className="text-sm font-medium text-foreground">{suggestion.context}</p>
                  <p className="text-xs text-muted-foreground">{suggestion.suggestion}</p>
                </div>
              </div>
            ))}
          </div>
        )}

        {objectionOpportunities.length === 0 && suggestions.length === 0 && (
          <div className="flex items-center gap-2 rounded-lg bg-green-50 p-3 text-green-700">
            <CheckCircle2 className="h-4 w-4" />
            <span className="text-sm">Response quality is strong</span>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
