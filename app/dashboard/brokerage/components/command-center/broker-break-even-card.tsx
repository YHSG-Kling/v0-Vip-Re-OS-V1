"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Target,
  TrendingUp,
  TrendingDown,
  Clock,
} from "lucide-react"

interface BrokerBreakEvenCardProps {
  avgBreakEvenMonth: number
  breakEvenMonths: number[]
  trend?: "improving" | "worsening" | "stable"
}

export function BrokerBreakEvenCard({ avgBreakEvenMonth, breakEvenMonths, trend }: BrokerBreakEvenCardProps) {
  const status =
    avgBreakEvenMonth <= 6 ? "excellent" :
    avgBreakEvenMonth <= 12 ? "good" :
    avgBreakEvenMonth <= 18 ? "acceptable" : "concerning"

  const statusStyles = {
    excellent: {
      badge: "outline" as const,
      text: "text-green-600",
      bg: "bg-green-500/10",
      label: "Excellent",
    },
    good: {
      badge: "secondary" as const,
      text: "text-blue-600",
      bg: "bg-blue-500/10",
      label: "Good",
    },
    acceptable: {
      badge: "secondary" as const,
      text: "text-yellow-600",
      bg: "bg-yellow-500/10",
      label: "Acceptable",
    },
    concerning: {
      badge: "destructive" as const,
      text: "text-red-600",
      bg: "bg-red-500/10",
      label: "Needs Attention",
    },
  }

  const styles = statusStyles[status]
  const TrendIcon = trend === "improving" ? TrendingUp : trend === "worsening" ? TrendingDown : Clock
  const trendColor = trend === "improving" ? "text-green-600" : trend === "worsening" ? "text-red-600" : "text-muted-foreground"

  // Distribution of break-even times
  const distribution = {
    fast: breakEvenMonths.filter(m => m <= 6).length,
    moderate: breakEvenMonths.filter(m => m > 6 && m <= 12).length,
    slow: breakEvenMonths.filter(m => m > 12).length,
  }

  return (
    <Card className={styles.bg}>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <Target className="h-4 w-4" />
            Recruiting Break-Even
          </CardTitle>
          <Badge variant={styles.badge}>
            {styles.label}
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-center justify-between">
          <div>
            <div className={`text-3xl font-bold ${styles.text}`}>
              {avgBreakEvenMonth > 0 ? avgBreakEvenMonth.toFixed(1) : "N/A"}
            </div>
            <div className="text-sm text-muted-foreground">
              months average to break even
            </div>
            {trend && (
              <div className={`flex items-center gap-1 text-xs mt-1 ${trendColor}`}>
                <TrendIcon className="h-3 w-3" />
                {trend === "improving" ? "Improving" : trend === "worsening" ? "Lengthening" : "Stable"}
              </div>
            )}
          </div>

          {breakEvenMonths.length > 0 && (
            <div className="text-right text-xs space-y-1">
              <div className="flex items-center justify-end gap-2">
                <span className="text-muted-foreground">Fast ({"<"}6mo)</span>
                <span className="font-medium text-green-600">{distribution.fast}</span>
              </div>
              <div className="flex items-center justify-end gap-2">
                <span className="text-muted-foreground">Moderate</span>
                <span className="font-medium text-blue-600">{distribution.moderate}</span>
              </div>
              <div className="flex items-center justify-end gap-2">
                <span className="text-muted-foreground">Slow ({">"}12mo)</span>
                <span className="font-medium text-orange-600">{distribution.slow}</span>
              </div>
            </div>
          )}
        </div>

        {breakEvenMonths.length === 0 && (
          <p className="text-xs text-muted-foreground mt-2">
            Break-even data will appear once recruits generate revenue
          </p>
        )}
      </CardContent>
    </Card>
  )
}
