"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Lightbulb, AlertTriangle, CheckCircle, X } from "lucide-react"
import { cn } from "@/lib/utils"

interface CoachingInsightCardProps {
  id: string
  insightType: string
  content: string
  priority: string
  dismissed?: boolean
  onDismiss?: (id: string) => void
}

export function CoachingInsightCard({
  id,
  insightType,
  content,
  priority,
  dismissed = false,
  onDismiss,
}: CoachingInsightCardProps) {
  const getInsightIcon = () => {
    switch (insightType.toLowerCase()) {
      case "improvement":
        return <Lightbulb className="h-4 w-4" />
      case "warning":
        return <AlertTriangle className="h-4 w-4" />
      case "positive":
        return <CheckCircle className="h-4 w-4" />
      default:
        return <Lightbulb className="h-4 w-4" />
    }
  }

  const getPriorityColor = () => {
    switch (priority.toLowerCase()) {
      case "high":
        return "bg-red-500/10 text-red-700 border-red-200"
      case "medium":
        return "bg-amber-500/10 text-amber-700 border-amber-200"
      case "low":
        return "bg-green-500/10 text-green-700 border-green-200"
      default:
        return "bg-muted text-muted-foreground"
    }
  }

  const getInsightTypeColor = () => {
    switch (insightType.toLowerCase()) {
      case "improvement":
        return "bg-blue-500/10 text-blue-700"
      case "warning":
        return "bg-amber-500/10 text-amber-700"
      case "positive":
        return "bg-green-500/10 text-green-700"
      default:
        return "bg-muted text-muted-foreground"
    }
  }

  if (dismissed) {
    return null
  }

  return (
    <Card className="relative">
      <CardContent className="pt-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className={cn("p-2 rounded-full", getInsightTypeColor())}>
              {getInsightIcon()}
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className={getInsightTypeColor()}>
                  {insightType}
                </Badge>
                <Badge variant="outline" className={getPriorityColor()}>
                  {priority} priority
                </Badge>
              </div>
              <p className="text-sm text-foreground">{content}</p>
            </div>
          </div>
          {onDismiss && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={() => onDismiss(id)}
            >
              <X className="h-4 w-4" />
              <span className="sr-only">Dismiss</span>
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
