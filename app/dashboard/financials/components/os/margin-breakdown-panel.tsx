"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  PieChart,
  TrendingUp,
  TrendingDown,
  DollarSign,
  Percent,
} from "lucide-react"

interface MarginBreakdownItem {
  label: string
  value: number
  percentOfGross: number
  trend?: number // +/- percent change
}

interface MarginBreakdownPanelProps {
  grossIncome: number
  breakdown: MarginBreakdownItem[]
  netMargin: number
  netMarginTrend?: number
  bySource?: {
    source: string
    revenue: number
    margin: number
  }[]
}

export function MarginBreakdownPanel({
  grossIncome,
  breakdown,
  netMargin,
  netMarginTrend,
  bySource,
}: MarginBreakdownPanelProps) {
  const formatCurrency = (val: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(val)

  const formatPercent = (val: number) => `${val.toFixed(1)}%`

  const getMarginColor = (margin: number) => {
    if (margin >= 40) return "text-green-600"
    if (margin >= 25) return "text-emerald-600"
    if (margin >= 15) return "text-amber-600"
    return "text-red-600"
  }

  const getTrendIcon = (trend?: number) => {
    if (trend === undefined) return null
    if (trend > 0) return <TrendingUp className="h-3 w-3 text-green-600" />
    if (trend < 0) return <TrendingDown className="h-3 w-3 text-red-600" />
    return null
  }

  // Calculate running total for waterfall
  let runningTotal = grossIncome
  const waterfallItems = breakdown.map((item) => {
    const result = {
      ...item,
      runningTotal: runningTotal - item.value,
    }
    runningTotal -= item.value
    return result
  })

  return (
    <Card className="border-emerald-200">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-emerald-100">
              <PieChart className="h-5 w-5 text-emerald-700" />
            </div>
            <div>
              <CardTitle className="text-base">Margin Breakdown</CardTitle>
              <CardDescription>From gross to net</CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-xl font-bold ${getMarginColor(netMargin)}`}>
              {formatPercent(netMargin)}
            </span>
            {netMarginTrend !== undefined && (
              <Badge
                variant="outline"
                className={`text-xs flex items-center gap-1 ${
                  netMarginTrend >= 0
                    ? "border-green-200 text-green-700"
                    : "border-red-200 text-red-700"
                }`}
              >
                {getTrendIcon(netMarginTrend)}
                {netMarginTrend >= 0 ? "+" : ""}
                {formatPercent(netMarginTrend)}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Waterfall Breakdown */}
        <div className="space-y-3">
          {/* Gross Income */}
          <div className="flex items-center justify-between p-3 rounded-lg bg-green-50 border border-green-200">
            <div className="flex items-center gap-2">
              <DollarSign className="h-4 w-4 text-green-600" />
              <span className="font-medium text-green-800">Gross Income</span>
            </div>
            <span className="text-lg font-bold text-green-600">
              {formatCurrency(grossIncome)}
            </span>
          </div>

          {/* Deductions */}
          {waterfallItems.map((item, idx) => (
            <div
              key={item.label}
              className="flex items-center justify-between p-2 rounded-lg bg-muted/50 border-l-4 border-red-300"
            >
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <span className="text-sm font-medium">{item.label}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm text-red-600">
                      -{formatCurrency(item.value)}
                    </span>
                    {item.trend !== undefined && (
                      <Badge variant="outline" className="text-xs">
                        {getTrendIcon(item.trend)}
                        {item.trend > 0 ? "+" : ""}
                        {formatPercent(item.trend)}
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-2 mt-1">
                  <Progress
                    value={item.percentOfGross}
                    className="h-1.5 flex-1 [&>div]:bg-red-400"
                  />
                  <span className="text-xs text-muted-foreground w-12 text-right">
                    {formatPercent(item.percentOfGross)}
                  </span>
                </div>
              </div>
            </div>
          ))}

          {/* Net Profit */}
          <div className="flex items-center justify-between p-3 rounded-lg bg-violet-50 border border-violet-200">
            <div className="flex items-center gap-2">
              <Percent className="h-4 w-4 text-violet-600" />
              <span className="font-medium text-violet-800">Net Profit</span>
            </div>
            <span className={`text-lg font-bold ${runningTotal >= 0 ? "text-violet-600" : "text-red-600"}`}>
              {formatCurrency(runningTotal)}
            </span>
          </div>
        </div>

        {/* Margin by Source */}
        {bySource && bySource.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2">Margin by Source</h4>
            <div className="space-y-2">
              {bySource.slice(0, 4).map((source) => (
                <div
                  key={source.source}
                  className="flex items-center justify-between p-2 rounded-lg bg-muted/30"
                >
                  <span className="text-sm">{source.source}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-muted-foreground">
                      {formatCurrency(source.revenue)}
                    </span>
                    <Badge
                      variant="outline"
                      className={`text-xs ${
                        source.margin >= 30
                          ? "border-green-200 text-green-700"
                          : source.margin >= 20
                            ? "border-amber-200 text-amber-700"
                            : "border-red-200 text-red-700"
                      }`}
                    >
                      {formatPercent(source.margin)}
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
