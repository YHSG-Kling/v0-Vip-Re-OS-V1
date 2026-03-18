"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  TrendingUp,
  Target,
  RefreshCw,
  Loader2,
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  Calendar,
} from "lucide-react"
import Link from "next/link"
import { toast } from "sonner"

interface FocusArea {
  area: string
  priority: "critical" | "high" | "medium"
  current_score: number
  target_score: number
  recommendation: string
}

interface WeeklyProgress {
  week_number: number
  overall_improvement: number
  areas_improved: number
  areas_declined: number
}

interface WeeklyImprovementPanelProps {
  focusAreas: FocusArea[]
  weeklyProgress: WeeklyProgress | null
  lastReportDate: string | null
  onGenerateReport: () => Promise<void>
}

const priorityColors = {
  critical: "bg-red-100 text-red-700",
  high: "bg-amber-100 text-amber-700",
  medium: "bg-blue-100 text-blue-700",
}

export function WeeklyImprovementPanel({
  focusAreas,
  weeklyProgress,
  lastReportDate,
  onGenerateReport,
}: WeeklyImprovementPanelProps) {
  const [isGenerating, setIsGenerating] = useState(false)

  const handleGenerate = async () => {
    setIsGenerating(true)
    try {
      await onGenerateReport()
      toast.success("Weekly coaching report generated")
    } catch (error) {
      toast.error("Failed to generate report")
    } finally {
      setIsGenerating(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <TrendingUp className="h-5 w-5 text-green-500" />
              Weekly Improvement
            </CardTitle>
            <CardDescription>Focus areas and progress tracking</CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleGenerate}
            disabled={isGenerating}
          >
            {isGenerating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <RefreshCw className="mr-2 h-4 w-4" />
                New Report
              </>
            )}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Last Report Date */}
        {lastReportDate && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Calendar className="h-3 w-3" />
            Last report: {new Date(lastReportDate).toLocaleDateString()}
          </div>
        )}

        {/* Weekly Progress Summary */}
        {weeklyProgress && (
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg border bg-card p-3 text-center">
              <p
                className={`text-lg font-semibold ${
                  weeklyProgress.overall_improvement >= 0 ? "text-green-600" : "text-red-600"
                }`}
              >
                {weeklyProgress.overall_improvement >= 0 ? "+" : ""}
                {weeklyProgress.overall_improvement}%
              </p>
              <p className="text-xs text-muted-foreground">Overall</p>
            </div>
            <div className="rounded-lg border bg-card p-3 text-center">
              <p className="text-lg font-semibold text-green-600">{weeklyProgress.areas_improved}</p>
              <p className="text-xs text-muted-foreground">Improved</p>
            </div>
            <div className="rounded-lg border bg-card p-3 text-center">
              <p className="text-lg font-semibold text-red-600">{weeklyProgress.areas_declined}</p>
              <p className="text-xs text-muted-foreground">Declined</p>
            </div>
          </div>
        )}

        {/* Focus Areas */}
        {focusAreas.length > 0 ? (
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-foreground">This Week's Focus Areas</h4>
            {focusAreas.map((area, idx) => (
              <div key={idx} className="space-y-2 rounded-lg border bg-card p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Target className="h-4 w-4 text-muted-foreground" />
                    <span className="text-sm font-medium">{area.area}</span>
                  </div>
                  <Badge variant="outline" className={priorityColors[area.priority]}>
                    {area.priority}
                  </Badge>
                </div>
                <div className="space-y-1">
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>Current: {area.current_score}</span>
                    <span>Target: {area.target_score}</span>
                  </div>
                  <Progress
                    value={(area.current_score / area.target_score) * 100}
                    className="h-2"
                  />
                </div>
                <p className="text-xs text-muted-foreground">{area.recommendation}</p>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2 rounded-lg bg-muted/50 p-4 text-muted-foreground">
            <AlertCircle className="h-4 w-4" />
            <span className="text-sm">Generate a report to see focus areas</span>
          </div>
        )}

        {focusAreas.length > 0 && focusAreas.every((a) => a.current_score >= a.target_score) && (
          <div className="flex items-center gap-2 rounded-lg bg-green-50 p-3 text-green-700">
            <CheckCircle2 className="h-4 w-4" />
            <span className="text-sm">All focus areas on target</span>
          </div>
        )}

        {/* View Full Report Link */}
        <Button variant="ghost" size="sm" className="w-full" asChild>
          <Link href="/dashboard/coaching">
            View Full Weekly Report
            <ArrowRight className="ml-2 h-4 w-4" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  )
}
