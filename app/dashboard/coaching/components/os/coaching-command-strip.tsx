"use client"

import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ArrowRight, Target, AlertTriangle, TrendingUp, Clock } from "lucide-react"
import Link from "next/link"

interface CoachingOpportunity {
  headline: string
  why_it_matters: string
  focus_area: string
  urgency: "critical" | "high" | "medium" | "low"
  cta_label: string
  cta_href: string
}

interface CoachingCommandStripProps {
  opportunity?: CoachingOpportunity | null
  isLoading?: boolean
  agentId?: string
  brokerageId?: string
}

const urgencyConfig = {
  critical: { bg: "bg-red-50 border-red-200", text: "text-red-700", badge: "bg-red-100 text-red-700" },
  high: { bg: "bg-amber-50 border-amber-200", text: "text-amber-700", badge: "bg-amber-100 text-amber-700" },
  medium: { bg: "bg-blue-50 border-blue-200", text: "text-blue-700", badge: "bg-blue-100 text-blue-700" },
  low: { bg: "bg-green-50 border-green-200", text: "text-green-700", badge: "bg-green-100 text-green-700" },
}

export function CoachingCommandStrip({ opportunity = null, isLoading }: CoachingCommandStripProps) {
  if (isLoading) {
    return (
      <Card className="border-2 border-dashed border-muted">
        <CardContent className="flex items-center justify-center py-6">
          <div className="flex items-center gap-2 text-muted-foreground">
            <Clock className="h-4 w-4 animate-pulse" />
            <span className="text-sm">Analyzing coaching opportunities...</span>
          </div>
        </CardContent>
      </Card>
    )
  }

  if (!opportunity) {
    return (
      <Card className="border-2 border-green-200 bg-green-50">
        <CardContent className="flex items-center justify-between py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-green-100">
              <TrendingUp className="h-5 w-5 text-green-600" />
            </div>
            <div>
              <p className="font-medium text-green-900">All systems performing well</p>
              <p className="text-sm text-green-700">No critical coaching areas identified</p>
            </div>
          </div>
          <Button variant="outline" size="sm" asChild>
            <Link href="/dashboard/coaching">
              View Full Report
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </CardContent>
      </Card>
    )
  }

  const config = urgencyConfig[opportunity.urgency]

  return (
    <Card className={`border-2 ${config.bg}`}>
      <CardContent className="py-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className={`flex h-10 w-10 items-center justify-center rounded-full ${config.badge}`}>
              {opportunity.urgency === "critical" ? (
                <AlertTriangle className="h-5 w-5" />
              ) : (
                <Target className="h-5 w-5" />
              )}
            </div>
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Badge variant="outline" className={config.badge}>
                  {opportunity.urgency.toUpperCase()}
                </Badge>
                <span className="text-xs text-muted-foreground">{opportunity.focus_area}</span>
              </div>
              <p className={`font-semibold ${config.text}`}>{opportunity.headline}</p>
              <p className="text-sm text-muted-foreground">{opportunity.why_it_matters}</p>
            </div>
          </div>
          <Button size="sm" asChild>
            <Link href={opportunity.cta_href}>
              {opportunity.cta_label}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
