"use client"

import { Sparkles, TrendingUp } from "lucide-react"
import { Card } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"

interface AIInsightCardProps {
  title: string
  insight: string
  confidence: number
  trend?: "up" | "down" | "neutral"
  priority?: "high" | "medium" | "low"
  actionable?: boolean
  className?: string
}

export function AIInsightCard({
  title,
  insight,
  confidence,
  trend = "neutral",
  priority = "medium",
  actionable = false,
  className = "",
}: AIInsightCardProps) {
  const priorityColors = {
    high: "border-red-500/30 bg-red-500/5",
    medium: "border-yellow-500/30 bg-yellow-500/5",
    low: "border-blue-500/30 bg-blue-500/5",
  }

  const trendIcons = {
    up: <TrendingUp size={14} className="text-green-500" />,
    down: <TrendingUp size={14} className="text-red-500 rotate-180" />,
    neutral: <Sparkles size={14} className="text-primary" />,
  }

  return (
    <Card className={`p-4 ${priorityColors[priority]} border ${className}`}>
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="p-1.5 rounded-lg gradient-ai-subtle">{trendIcons[trend]}</div>
          <h4 className="font-semibold text-sm text-white">{title}</h4>
        </div>
        {actionable && (
          <Badge variant="secondary" className="text-xs">
            Action Available
          </Badge>
        )}
      </div>

      <p className="text-sm text-muted-foreground mb-3">{insight}</p>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Sparkles size={12} className="text-primary" />
          <span>{confidence}% AI Confidence</span>
        </div>
        {priority === "high" && (
          <Badge variant="destructive" className="text-xs">
            High Priority
          </Badge>
        )}
      </div>
    </Card>
  )
}

export default AIInsightCard
