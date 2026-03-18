"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import Link from "next/link"
import {
  DollarSign,
  TrendingUp,
  TrendingDown,
  ArrowRight,
} from "lucide-react"

interface BrokerFinancialPulseProps {
  ytdRevenue: number
  projectedRevenue: number
  marginPercent: number
  pendingPayouts: number
  trend: "up" | "down" | "flat"
  trendPercent?: number
}

export function BrokerFinancialPulse({
  ytdRevenue,
  projectedRevenue,
  marginPercent,
  pendingPayouts,
  trend,
  trendPercent,
}: BrokerFinancialPulseProps) {
  const formatCurrency = (val: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(val)

  const TrendIcon = trend === "up" ? TrendingUp : trend === "down" ? TrendingDown : TrendingUp
  const trendColor = trend === "up" ? "text-green-600" : trend === "down" ? "text-red-600" : "text-muted-foreground"

  const marginStatus =
    marginPercent >= 20 ? "healthy" : marginPercent >= 10 ? "watch" : "warning"
  const marginBadgeVariant =
    marginStatus === "healthy" ? "outline" : marginStatus === "watch" ? "secondary" : "destructive"

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base flex items-center gap-2">
            <DollarSign className="h-4 w-4" />
            Financial Pulse
          </CardTitle>
          <Link href="/dashboard/financials/brokerage">
            <Button variant="ghost" size="sm" className="text-xs">
              Open Financials
              <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
          </Link>
        </div>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4">
          {/* YTD Revenue */}
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground uppercase tracking-wide">YTD Revenue</div>
            <div className="text-2xl font-bold">{formatCurrency(ytdRevenue)}</div>
            {trendPercent !== undefined && (
              <div className={`flex items-center gap-1 text-xs ${trendColor}`}>
                <TrendIcon className="h-3 w-3" />
                {trend === "up" ? "+" : trend === "down" ? "-" : ""}{Math.abs(trendPercent).toFixed(1)}% vs last year
              </div>
            )}
          </div>

          {/* Projected Revenue */}
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground uppercase tracking-wide">90-Day Forecast</div>
            <div className="text-2xl font-bold">{formatCurrency(projectedRevenue)}</div>
            <div className="text-xs text-muted-foreground">projected revenue</div>
          </div>

          {/* Margin */}
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground uppercase tracking-wide">Profit Margin</div>
            <div className="flex items-center gap-2">
              <span className="text-2xl font-bold">{marginPercent.toFixed(1)}%</span>
              <Badge variant={marginBadgeVariant} className="text-xs">
                {marginStatus}
              </Badge>
            </div>
          </div>

          {/* Pending Payouts */}
          <div className="space-y-1">
            <div className="text-xs text-muted-foreground uppercase tracking-wide">Pending Payouts</div>
            <div className="text-2xl font-bold text-orange-600">{formatCurrency(pendingPayouts)}</div>
            <div className="text-xs text-muted-foreground">agent commissions due</div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
