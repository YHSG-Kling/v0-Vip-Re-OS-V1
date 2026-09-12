"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import {
  AlertTriangle,
  Activity,
  Heart,
  TrendingUp,
  ChevronRight,
} from "lucide-react"

export interface BrokerPriority {
  id: string
  title: string
  description: string
  urgency: "critical" | "high" | "medium" | "low"
  metric?: string
  metricLabel?: string
  ctaLabel: string
  ctaHref: string
}

interface BrokerCommandStripProps {
  priority: BrokerPriority | null
  summary: {
    criticalDeals: number
    fatigueAlerts: number
    pendingPayouts: number
    recruitingROI: number
  }
}

export function BrokerCommandStrip({ priority, summary }: BrokerCommandStripProps) {
  const urgencyStyles = {
    critical: "border-red-500/50 bg-red-500/5",
    high: "border-orange-500/50 bg-orange-500/5",
    medium: "border-yellow-500/50 bg-yellow-500/5",
    low: "border-blue-500/50 bg-blue-500/5",
  }

  const urgencyBadge = {
    critical: { variant: "destructive" as const, label: "Critical" },
    high: { variant: "destructive" as const, label: "High Priority" },
    medium: { variant: "secondary" as const, label: "Review" },
    low: { variant: "outline" as const, label: "Info" },
  }

  const urgencyIcon = {
    critical: <AlertTriangle className="h-5 w-5 text-red-500" />,
    high: <AlertTriangle className="h-5 w-5 text-orange-500" />,
    medium: <Activity className="h-5 w-5 text-yellow-600" />,
    low: <Activity className="h-5 w-5 text-blue-500" />,
  }

  // If no priority, show a summary strip
  if (!priority) {
    return (
      <Card className="border-border/50 bg-card/50">
        <CardContent className="py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-6">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm text-muted-foreground">Brokerage Status:</span>
                <Badge variant="outline" className="text-green-600 border-green-600/30">
                  Healthy
                </Badge>
              </div>
              <div className="h-4 w-px bg-border" />
              <div className="flex items-center gap-4 text-sm">
                {summary.criticalDeals > 0 && (
                  <span className="flex items-center gap-1.5">
                    <span className="h-2 w-2 rounded-full bg-red-500" />
                    {summary.criticalDeals} at-risk deal{summary.criticalDeals !== 1 ? "s" : ""}
                  </span>
                )}
                {summary.fatigueAlerts > 0 && (
                  <span className="flex items-center gap-1.5">
                    <Heart className="h-3.5 w-3.5 text-orange-500" />
                    {summary.fatigueAlerts} fatigue alert{summary.fatigueAlerts !== 1 ? "s" : ""}
                  </span>
                )}
                <span className="flex items-center gap-1.5">
                  <TrendingUp className="h-3.5 w-3.5 text-green-600" />
                  {summary.recruitingROI > 0 ? "+" : ""}{summary.recruitingROI.toFixed(0)}% recruiting ROI
                </span>
              </div>
            </div>
            <Link href="/dashboard/brokerage/deal-health">
              <Button variant="ghost" size="sm">
                View Deal Health
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </Link>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card className={`border ${urgencyStyles[priority.urgency]}`}>
      <CardContent className="py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4 flex-1 min-w-0">
            {urgencyIcon[priority.urgency]}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <Badge variant={urgencyBadge[priority.urgency].variant} className="text-xs">
                  {urgencyBadge[priority.urgency].label}
                </Badge>
                <h3 className="font-semibold truncate">{priority.title}</h3>
              </div>
              <p className="text-sm text-muted-foreground truncate">{priority.description}</p>
            </div>
          </div>

          {priority.metric && (
            <div className="text-right shrink-0">
              <div className="text-2xl font-bold">{priority.metric}</div>
              {priority.metricLabel && (
                <div className="text-xs text-muted-foreground">{priority.metricLabel}</div>
              )}
            </div>
          )}

          <Link href={priority.ctaHref}>
            <Button
              variant={priority.urgency === "critical" ? "destructive" : "default"}
              className="shrink-0"
            >
              {priority.ctaLabel}
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  )
}
