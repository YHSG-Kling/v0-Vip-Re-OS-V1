"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Activity,
  AlertTriangle,
  Heart,
  DollarSign,
  Server,
  Shield,
} from "lucide-react"

interface RiskSignal {
  category: "deals" | "fatigue" | "compliance" | "payouts" | "providers"
  level: "critical" | "warning" | "watch" | "healthy"
  label: string
  value: number
  description?: string
}

interface BrokerRiskRadarProps {
  signals: RiskSignal[]
}

export function BrokerRiskRadar({ signals }: BrokerRiskRadarProps) {
  const categoryIcons = {
    deals: Activity,
    fatigue: Heart,
    compliance: Shield,
    payouts: DollarSign,
    providers: Server,
  }

  const levelColors = {
    critical: {
      bg: "bg-red-500/10",
      border: "border-red-500/30",
      text: "text-red-600",
      badge: "destructive" as const,
    },
    warning: {
      bg: "bg-orange-500/10",
      border: "border-orange-500/30",
      text: "text-orange-600",
      badge: "secondary" as const,
    },
    watch: {
      bg: "bg-yellow-500/10",
      border: "border-yellow-500/30",
      text: "text-yellow-600",
      badge: "secondary" as const,
    },
    healthy: {
      bg: "bg-green-500/10",
      border: "border-green-500/30",
      text: "text-green-600",
      badge: "outline" as const,
    },
  }

  // Sort by severity
  const sortedSignals = [...signals].sort((a, b) => {
    const order = { critical: 0, warning: 1, watch: 2, healthy: 3 }
    return order[a.level] - order[b.level]
  })

  const overallRisk = sortedSignals[0]?.level || "healthy"

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <AlertTriangle className="h-4 w-4" />
            Risk Radar
          </CardTitle>
          <Badge variant={levelColors[overallRisk].badge}>
            {overallRisk === "healthy" ? "All Clear" : `${sortedSignals.filter(s => s.level !== "healthy").length} Signal${sortedSignals.filter(s => s.level !== "healthy").length !== 1 ? "s" : ""}`}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {sortedSignals.map((signal, idx) => {
          const Icon = categoryIcons[signal.category]
          const colors = levelColors[signal.level]

          return (
            <div
              key={`${signal.category}-${idx}`}
              className={`flex items-center justify-between p-3 rounded-lg border ${colors.bg} ${colors.border}`}
            >
              <div className="flex items-center gap-3">
                <Icon className={`h-4 w-4 ${colors.text}`} />
                <div>
                  <div className="font-medium text-sm">{signal.label}</div>
                  {signal.description && (
                    <div className="text-xs text-muted-foreground">{signal.description}</div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-lg font-bold ${colors.text}`}>{signal.value}</span>
                <Badge variant={colors.badge} className="text-xs">
                  {signal.level}
                </Badge>
              </div>
            </div>
          )
        })}

        {signals.length === 0 && (
          <div className="text-center py-6 text-muted-foreground text-sm">
            No active risk signals
          </div>
        )}
      </CardContent>
    </Card>
  )
}
