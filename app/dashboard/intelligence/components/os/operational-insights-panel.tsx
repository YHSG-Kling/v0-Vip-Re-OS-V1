"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import {
  Activity,
  ArrowRight,
  Calendar,
  TrendingUp,
  TrendingDown,
} from "lucide-react"

interface OperationalInsight {
  id: string
  type: "opportunity" | "risk" | "trend" | "milestone"
  title: string
  description: string
  metric?: string
  trend?: "up" | "down" | "stable"
  actionUrl?: string
  actionLabel?: string
  priority: "high" | "medium" | "low"
}

interface OperationalInsightsPanelProps {
  insights: OperationalInsight[]
  periodLabel: string
}

export function OperationalInsightsPanel({
  insights,
  periodLabel,
}: OperationalInsightsPanelProps) {
  const getTypeIcon = (type: string) => {
    switch (type) {
      case "opportunity": return <TrendingUp className="h-4 w-4 text-green-600" />
      case "risk": return <TrendingDown className="h-4 w-4 text-red-600" />
      case "trend": return <Activity className="h-4 w-4 text-blue-600" />
      case "milestone": return <Calendar className="h-4 w-4 text-purple-600" />
      default: return <Activity className="h-4 w-4" />
    }
  }

  const getPriorityColor = (priority: string) => {
    switch (priority) {
      case "high": return "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
      case "medium": return "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
      case "low": return "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
      default: return "bg-muted text-muted-foreground"
    }
  }

  const getTypeColor = (type: string) => {
    switch (type) {
      case "opportunity": return "border-l-green-500"
      case "risk": return "border-l-red-500"
      case "trend": return "border-l-blue-500"
      case "milestone": return "border-l-purple-500"
      default: return "border-l-gray-500"
    }
  }

  const highPriorityCount = insights.filter(i => i.priority === "high").length

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Activity className="h-4 w-4 text-primary" />
            Operational Insights
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="text-xs">
              {periodLabel}
            </Badge>
            {highPriorityCount > 0 && (
              <Badge variant="destructive" className="text-xs">
                {highPriorityCount} urgent
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {insights.length === 0 ? (
          <div className="py-4 text-center text-sm text-muted-foreground">
            No insights available for this period
          </div>
        ) : (
          insights.slice(0, 4).map((insight) => (
            <div
              key={insight.id}
              className={`rounded-lg border border-l-4 ${getTypeColor(insight.type)} p-3 space-y-2`}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2">
                  {getTypeIcon(insight.type)}
                  <span className="font-medium text-sm">{insight.title}</span>
                </div>
                <Badge className={`text-xs ${getPriorityColor(insight.priority)}`}>
                  {insight.priority}
                </Badge>
              </div>

              <p className="text-xs text-muted-foreground">
                {insight.description}
              </p>

              {insight.metric && (
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{insight.metric}</span>
                  {insight.trend === "up" && <TrendingUp className="h-3 w-3 text-green-600" />}
                  {insight.trend === "down" && <TrendingDown className="h-3 w-3 text-red-600" />}
                </div>
              )}

              {insight.actionUrl && (
                <Link href={insight.actionUrl}>
                  <Button variant="ghost" size="sm" className="h-7 text-xs p-0">
                    {insight.actionLabel || "View Details"}
                    <ArrowRight className="h-3 w-3 ml-1" />
                  </Button>
                </Link>
              )}
            </div>
          ))
        )}

        {insights.length > 4 && (
          <p className="text-center text-xs text-muted-foreground">
            +{insights.length - 4} more insights
          </p>
        )}

        <Link href="/dashboard/analytics">
          <Button variant="outline" size="sm" className="w-full gap-2">
            View Full Analytics
            <ArrowRight className="h-4 w-4" />
          </Button>
        </Link>
      </CardContent>
    </Card>
  )
}
