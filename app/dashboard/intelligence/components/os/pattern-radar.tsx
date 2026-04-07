"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  Brain,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Target,
} from "lucide-react"

interface PatternRadarProps {
  trustCapitalScore: number
  totalValueDelivered: number
  activePatterns: number
  highPriorityPatterns: number
  accuracyRate: number
  pendingPredictions: number
}

export function PatternRadar({
  trustCapitalScore,
  totalValueDelivered,
  activePatterns,
  highPriorityPatterns,
  accuracyRate,
  pendingPredictions,
}: PatternRadarProps) {
  const trustLevel = trustCapitalScore >= 75 ? "High" : trustCapitalScore >= 50 ? "Building" : "Focus Needed"
  const trustColor = trustCapitalScore >= 75 ? "text-green-600" : trustCapitalScore >= 50 ? "text-amber-600" : "text-red-600"

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Brain className="h-4 w-4 text-primary" />
            Intelligence Radar
          </CardTitle>
          <Badge variant={trustCapitalScore >= 75 ? "default" : "secondary"} className={trustColor}>
            {trustLevel}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Trust Capital Score */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Trust Capital</span>
            <span className="font-semibold">{trustCapitalScore}/100</span>
          </div>
          <Progress value={trustCapitalScore} className="h-2" />
        </div>

        {/* Value Delivered */}
        <div className="flex items-center justify-between rounded-lg bg-muted/50 p-3">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-green-600" />
            <span className="text-sm">Value Delivered</span>
          </div>
          <span className="font-semibold text-green-600">
            ${totalValueDelivered.toLocaleString()}
          </span>
        </div>

        {/* Pattern Stats Grid */}
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border p-3 text-center">
            <div className="flex items-center justify-center gap-1">
              <Target className="h-4 w-4 text-primary" />
              <span className="text-2xl font-bold">{activePatterns}</span>
            </div>
            <p className="text-xs text-muted-foreground">Active Patterns</p>
          </div>

          <div className="rounded-lg border p-3 text-center">
            <div className="flex items-center justify-center gap-1">
              <AlertTriangle className="h-4 w-4 text-amber-500" />
              <span className="text-2xl font-bold">{highPriorityPatterns}</span>
            </div>
            <p className="text-xs text-muted-foreground">High Priority</p>
          </div>

          <div className="rounded-lg border p-3 text-center">
            <div className="flex items-center justify-center gap-1">
              <CheckCircle2 className="h-4 w-4 text-green-600" />
              <span className="text-2xl font-bold">{accuracyRate}%</span>
            </div>
            <p className="text-xs text-muted-foreground">Prediction Accuracy</p>
          </div>

          <div className="rounded-lg border p-3 text-center">
            <div className="flex items-center justify-center gap-1">
              <Clock className="h-4 w-4 text-blue-600" />
              <span className="text-2xl font-bold">{pendingPredictions}</span>
            </div>
            <p className="text-xs text-muted-foreground">Pending Predictions</p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
