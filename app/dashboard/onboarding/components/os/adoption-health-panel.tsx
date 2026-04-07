"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { 
  Heart, 
  TrendingUp,
  TrendingDown,
  Minus,
  CheckCircle2,
  AlertTriangle,
  Clock
} from "lucide-react"

interface AdoptionHealthPanelProps {
  health: {
    overallScore: number
    trend: 'up' | 'down' | 'stable'
    trendValue: number
    factors: Array<{
      name: string
      score: number
      status: 'good' | 'warning' | 'critical'
    }>
    recommendations: string[]
  }
}

const trendConfig = {
  up: { icon: TrendingUp, color: "text-green-500", label: "Improving" },
  down: { icon: TrendingDown, color: "text-red-500", label: "Declining" },
  stable: { icon: Minus, color: "text-gray-500", label: "Stable" },
}

const statusConfig = {
  good: { color: "bg-green-500", badge: "bg-green-100 text-green-700" },
  warning: { color: "bg-yellow-500", badge: "bg-yellow-100 text-yellow-700" },
  critical: { color: "bg-red-500", badge: "bg-red-100 text-red-700" },
}

export function AdoptionHealthPanel({ health }: AdoptionHealthPanelProps) {
  const TrendIcon = trendConfig[health.trend].icon
  const healthColor = health.overallScore >= 70 
    ? "text-green-600" 
    : health.overallScore >= 40 
    ? "text-yellow-600" 
    : "text-red-600"

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium flex items-center gap-2">
          <Heart className="h-4 w-4" />
          Adoption Health
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Overall Score */}
        <div className="flex items-center justify-between">
          <div>
            <p className={`text-3xl font-bold ${healthColor}`}>{health.overallScore}</p>
            <p className="text-xs text-muted-foreground">Health Score</p>
          </div>
          <div className="text-right">
            <div className={`flex items-center gap-1 ${trendConfig[health.trend].color}`}>
              <TrendIcon className="h-4 w-4" />
              <span className="text-sm font-medium">
                {health.trend !== 'stable' && (health.trend === 'up' ? '+' : '-')}
                {health.trendValue}%
              </span>
            </div>
            <p className="text-xs text-muted-foreground">{trendConfig[health.trend].label}</p>
          </div>
        </div>

        {/* Health Factors */}
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground uppercase">Health Factors</h4>
          {health.factors.map((factor, index) => (
            <div key={index} className="space-y-1">
              <div className="flex items-center justify-between text-sm">
                <span>{factor.name}</span>
                <Badge className={`text-xs ${statusConfig[factor.status].badge}`}>
                  {factor.score}%
                </Badge>
              </div>
              <Progress 
                value={factor.score} 
                className="h-1"
              />
            </div>
          ))}
        </div>

        {/* Recommendations */}
        {health.recommendations.length > 0 && (
          <div className="space-y-2 pt-2 border-t">
            <h4 className="text-xs font-medium text-muted-foreground uppercase">Recommendations</h4>
            {health.recommendations.slice(0, 2).map((rec, index) => (
              <div key={index} className="flex items-start gap-2 text-xs text-muted-foreground">
                <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0 text-yellow-500" />
                <span>{rec}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
