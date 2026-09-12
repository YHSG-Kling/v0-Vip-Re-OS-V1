"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import {
  TrendingUp,
  ArrowRight,
  Users,
} from "lucide-react"

interface BrokerRecruitingROIPanelProps {
  summary: {
    totalInvested: number
    totalGenerated: number
    avgROI: number
    activeRecruits: number
    profitableRecruits: number
  }
  costBreakdown: {
    training: number
    marketing: number
    technology: number
    bonuses: number
    guarantees: number
    other: number
  }
}

export function BrokerRecruitingROIPanel({ summary, costBreakdown }: BrokerRecruitingROIPanelProps) {
  const formatCurrency = (val: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(val)

  const roiStatus = summary.avgROI > 100 ? "positive" : summary.avgROI > 0 ? "break_even" : "negative"
  const roiBadgeVariant = roiStatus === "positive" ? "outline" : roiStatus === "break_even" ? "secondary" : "destructive"
  const roiColor = roiStatus === "positive" ? "text-green-600" : roiStatus === "break_even" ? "text-yellow-600" : "text-red-600"

  // Top cost categories
  const sortedCosts = Object.entries(costBreakdown)
    .sort(([, a], [, b]) => b - a)
    .filter(([, val]) => val > 0)
    .slice(0, 3)

  const totalCost = Object.values(costBreakdown).reduce((a, b) => a + b, 0)

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4" />
            Recruiting ROI
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={roiBadgeVariant} className="text-xs">
              {summary.avgROI > 0 ? "+" : ""}{summary.avgROI.toFixed(0)}% ROI
            </Badge>
            <Link href="/dashboard/recruiting-roi">
              <Button variant="ghost" size="sm" className="text-xs">
                Details
                <ArrowRight className="h-3 w-3 ml-1" />
              </Button>
            </Link>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Key Metrics */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground uppercase tracking-wide">Invested</div>
            <div className="text-xl font-bold">{formatCurrency(summary.totalInvested)}</div>
          </div>
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground uppercase tracking-wide">Generated</div>
            <div className={`text-xl font-bold ${roiColor}`}>{formatCurrency(summary.totalGenerated)}</div>
          </div>
        </div>

        {/* Recruit Stats */}
        <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
          <div className="flex items-center gap-2">
            <Users className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">Active Recruits</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="font-bold">{summary.activeRecruits}</span>
            <span className="text-xs text-muted-foreground">
              ({summary.profitableRecruits} profitable)
            </span>
          </div>
        </div>

        {/* Cost Breakdown */}
        {sortedCosts.length > 0 && (
          <div className="space-y-2">
            <div className="text-xs text-muted-foreground uppercase tracking-wide">Top Costs</div>
            {sortedCosts.map(([category, amount]) => (
              <div key={category} className="flex items-center justify-between text-sm">
                <span className="capitalize">{category}</span>
                <div className="flex items-center gap-2">
                  <span className="font-medium">{formatCurrency(amount)}</span>
                  <span className="text-xs text-muted-foreground">
                    ({((amount / totalCost) * 100).toFixed(0)}%)
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
