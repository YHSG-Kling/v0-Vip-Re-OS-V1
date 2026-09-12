"use client"

import { useState, useTransition } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Sparkles, Route, AlertTriangle, CheckCircle2 } from "lucide-react"
import { optimizeDailySchedule } from "@/app/actions/ai-calendar-management"
import type { UnifiedCalendarEvent } from "./calendar-shell"

interface CalendarOptimizationPanelProps {
  agentId: string
  date: string
  events: UnifiedCalendarEvent[]
}

type OptimizationResult = {
  optimizedTimeline: Array<{
    time: string
    endTime: string
    activity: string
    type: string
    location?: string
    priority: string
    notes?: string
  }>
  travelOptimization: {
    totalTravelTime: number
    suggestedRoute: string[]
    savedTime: number
  }
  conflicts: Array<{
    item1: string
    item2: string
    resolution: string
  }>
  productivityScore: number
  recommendations: Array<{
    suggestion: string
    benefit: string
  }>
}

export function CalendarOptimizationPanel({ agentId, date, events }: CalendarOptimizationPanelProps) {
  const [isPending, startTransition] = useTransition()
  const [result, setResult] = useState<OptimizationResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const handleOptimize = () => {
    setError(null)
    startTransition(async () => {
      const res = await optimizeDailySchedule({ agentId, date })
      if (res.success && res.optimizedSchedule) {
        setResult(res.optimizedSchedule as OptimizationResult)
      } else {
        setError(res.error || "Failed to optimize schedule")
      }
    })
  }

  const todayEvents = events.filter((e) => {
    const eventDate = new Date(e.startAt).toISOString().split("T")[0]
    return eventDate === date
  })

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Sparkles className="h-4 w-4 text-amber-500" />
          Schedule Optimization
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!result ? (
          <>
            <p className="text-xs text-muted-foreground">
              {todayEvents.length} events today. AI can optimize your route and timing.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="w-full"
              onClick={handleOptimize}
              disabled={isPending || todayEvents.length === 0}
            >
              {isPending ? "Optimizing..." : "Optimize Day"}
            </Button>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </>
        ) : (
          <div className="space-y-3">
            {/* Productivity Score */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Productivity Score</span>
              <Badge variant={result.productivityScore >= 80 ? "default" : "secondary"}>
                {result.productivityScore}%
              </Badge>
            </div>

            {/* Travel Optimization */}
            {result.travelOptimization && (
              <div className="p-2 bg-muted/50 rounded-lg space-y-1">
                <div className="flex items-center gap-1 text-xs font-medium text-foreground">
                  <Route className="h-3 w-3" />
                  Travel Optimization
                </div>
                <p className="text-xs text-muted-foreground">
                  Total travel: {result.travelOptimization.totalTravelTime} min
                </p>
                {result.travelOptimization.savedTime > 0 && (
                  <p className="text-xs text-green-600 dark:text-green-400">
                    Saved {result.travelOptimization.savedTime} min with optimized route
                  </p>
                )}
              </div>
            )}

            {/* Conflicts */}
            {result.conflicts.length > 0 && (
              <div className="p-2 bg-destructive/10 rounded-lg space-y-1">
                <div className="flex items-center gap-1 text-xs font-medium text-destructive">
                  <AlertTriangle className="h-3 w-3" />
                  {result.conflicts.length} Conflict{result.conflicts.length > 1 ? "s" : ""} Found
                </div>
                {result.conflicts.slice(0, 2).map((c, i) => (
                  <p key={i} className="text-xs text-muted-foreground">
                    {c.resolution}
                  </p>
                ))}
              </div>
            )}

            {/* Recommendations */}
            {result.recommendations.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium text-foreground">Recommendations</p>
                {result.recommendations.slice(0, 2).map((rec, i) => (
                  <div key={i} className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <CheckCircle2 className="h-3 w-3 text-green-500 mt-0.5 flex-shrink-0" />
                    <span>{rec.suggestion}</span>
                  </div>
                ))}
              </div>
            )}

            <Button
              size="sm"
              variant="ghost"
              className="w-full text-xs"
              onClick={() => setResult(null)}
            >
              Reset
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
