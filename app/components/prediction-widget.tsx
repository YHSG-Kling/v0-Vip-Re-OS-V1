"use client"

// components/prediction-widget.tsx
// Layer 9.3 Content Performance Predictor — Reusable Widget
// Shows predicted_score as radial gauge, confidence badge, CTR, engagement rate,
// recommended publish window, and rationale.

import { useState } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Loader2, TrendingUp, Clock, ChevronDown, ChevronUp, Info, Target, BarChart3 } from "lucide-react"
import { cn } from "@/lib/utils"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface PredictionData {
  predicted_score: number
  predicted_ctr: number
  predicted_engagement_rate: number
  recommended_publish_window: {
    day: string
    hour: number
    timezone: string
  }
  rationale: string
  confidence: "low" | "medium" | "high"
}

export interface PredictionWidgetProps {
  // Existing prediction data (if already predicted)
  prediction?: PredictionData | null
  // Whether a prediction is currently loading
  isLoading?: boolean
  // Callback to trigger a new prediction
  onPredict?: () => void
  // Whether the predict button should be shown
  showPredictButton?: boolean
  // Additional CSS classes
  className?: string
  // Compact mode for inline usage
  compact?: boolean
}

// ─── RADIAL GAUGE ─────────────────────────────────────────────────────────────

function RadialGauge({ score, size = 100 }: { score: number; size?: number }) {
  // Calculate color based on score
  const getColor = (value: number) => {
    if (value < 40) return "#ef4444" // red
    if (value < 70) return "#f59e0b" // yellow
    return "#22c55e" // green
  }

  const color = getColor(score)
  const radius = (size - 10) / 2
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (score / 100) * circumference

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="transform -rotate-90">
        {/* Background circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="currentColor"
          strokeWidth={8}
          className="text-muted/20"
        />
        {/* Progress circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={8}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-500"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="text-2xl font-bold" style={{ color }}>
          {score}
        </span>
      </div>
    </div>
  )
}

// ─── CONFIDENCE BADGE ─────────────────────────────────────────────────────────

function ConfidenceBadge({ confidence }: { confidence: "low" | "medium" | "high" }) {
  const config = {
    low: { label: "Low Confidence", className: "bg-gray-100 text-gray-700 border-gray-300" },
    medium: { label: "Medium Confidence", className: "bg-yellow-100 text-yellow-700 border-yellow-300" },
    high: { label: "High Confidence", className: "bg-green-100 text-green-700 border-green-300" },
  }

  const { label, className } = config[confidence]

  return (
    <Badge variant="outline" className={cn("text-xs", className)}>
      {label}
    </Badge>
  )
}

// ─── MAIN WIDGET ──────────────────────────────────────────────────────────────

export function PredictionWidget({
  prediction,
  isLoading = false,
  onPredict,
  showPredictButton = true,
  className,
  compact = false,
}: PredictionWidgetProps) {
  const [rationaleOpen, setRationaleOpen] = useState(false)

  // Format hour to 12-hour time
  const formatHour = (hour: number) => {
    const suffix = hour >= 12 ? "pm" : "am"
    const h = hour % 12 || 12
    return `${h}${suffix}`
  }

  // No prediction yet state
  if (!prediction && !isLoading) {
    return (
      <Card className={cn("border-dashed", className)}>
        <CardContent className="pt-6">
          <div className="flex flex-col items-center justify-center text-center py-4">
            <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mb-3">
              <TrendingUp className="h-6 w-6 text-muted-foreground" />
            </div>
            <p className="text-sm text-muted-foreground mb-3">
              Get an AI-powered performance prediction
            </p>
            {showPredictButton && onPredict && (
              <Button onClick={onPredict} variant="outline" size="sm">
                <BarChart3 className="h-4 w-4 mr-2" />
                Predict Performance
              </Button>
            )}
            <p className="text-xs text-muted-foreground mt-2">
              Advisory only — does not auto-publish
            </p>
          </div>
        </CardContent>
      </Card>
    )
  }

  // Loading state
  if (isLoading) {
    return (
      <Card className={className}>
        <CardContent className="pt-6">
          <div className="flex flex-col items-center justify-center text-center py-8">
            <Loader2 className="h-8 w-8 animate-spin text-primary mb-3" />
            <p className="text-sm text-muted-foreground">Analyzing content...</p>
          </div>
        </CardContent>
      </Card>
    )
  }

  // Compact view
  if (compact && prediction) {
    return (
      <div className={cn("flex items-center gap-3 p-3 rounded-lg border bg-card", className)}>
        <RadialGauge score={prediction.predicted_score} size={60} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-medium">Performance Score</span>
            <ConfidenceBadge confidence={prediction.confidence} />
          </div>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>CTR: {(prediction.predicted_ctr * 100).toFixed(2)}%</span>
            <span>Eng: {(prediction.predicted_engagement_rate * 100).toFixed(2)}%</span>
          </div>
        </div>
        {showPredictButton && onPredict && (
          <Button onClick={onPredict} variant="ghost" size="sm">
            <TrendingUp className="h-4 w-4" />
          </Button>
        )}
      </div>
    )
  }

  // Full view
  return (
    <Card className={className}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" />
            Performance Prediction
          </CardTitle>
          <ConfidenceBadge confidence={prediction!.confidence} />
        </div>
        <CardDescription className="text-xs">
          Advisory only — does not auto-publish
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Score Gauge */}
        <div className="flex items-center justify-center">
          <RadialGauge score={prediction!.predicted_score} size={120} />
        </div>

        {/* Metrics Grid */}
        <div className="grid grid-cols-2 gap-3">
          <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50">
            <Target className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Predicted CTR</p>
              <p className="text-sm font-medium">
                {(prediction!.predicted_ctr * 100).toFixed(2)}%
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2 p-2 rounded-lg bg-muted/50">
            <BarChart3 className="h-4 w-4 text-muted-foreground" />
            <div>
              <p className="text-xs text-muted-foreground">Engagement Rate</p>
              <p className="text-sm font-medium">
                {(prediction!.predicted_engagement_rate * 100).toFixed(2)}%
              </p>
            </div>
          </div>
        </div>

        {/* Recommended Publish Window */}
        <div className="flex items-center gap-2 p-3 rounded-lg bg-primary/5 border border-primary/10">
          <Clock className="h-4 w-4 text-primary" />
          <div className="flex-1">
            <p className="text-xs text-muted-foreground">Best Time to Publish</p>
            <p className="text-sm font-medium">
              {prediction!.recommended_publish_window.day} at{" "}
              {formatHour(prediction!.recommended_publish_window.hour)}{" "}
              <span className="text-xs text-muted-foreground">
                ({prediction!.recommended_publish_window.timezone})
              </span>
            </p>
          </div>
        </div>

        {/* Rationale Collapsible */}
        <Collapsible open={rationaleOpen} onOpenChange={setRationaleOpen}>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" className="w-full justify-between text-sm">
              <span className="flex items-center gap-2">
                <Info className="h-4 w-4" />
                Analysis Details
              </span>
              {rationaleOpen ? (
                <ChevronUp className="h-4 w-4" />
              ) : (
                <ChevronDown className="h-4 w-4" />
              )}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="p-3 mt-1 rounded-lg bg-muted/50 text-sm text-muted-foreground">
              {prediction!.rationale}
            </div>
          </CollapsibleContent>
        </Collapsible>

        {/* Re-predict Button */}
        {showPredictButton && onPredict && (
          <Button onClick={onPredict} variant="outline" className="w-full" size="sm">
            <TrendingUp className="h-4 w-4 mr-2" />
            Re-analyze Content
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
