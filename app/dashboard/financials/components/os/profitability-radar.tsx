"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import {
  TrendingUp,
  TrendingDown,
  Minus,
  DollarSign,
  Target,
  PieChart,
  BarChart3,
} from "lucide-react"

interface ProfitabilityRadarProps {
  metrics: {
    grossIncome: number
    netProfit: number
    profitMargin: number
    expenseRatio: number
    revenueGrowth?: number // YoY or MoM
    targetProgress?: number // % to goal
  }
  period: "mtd" | "ytd" | "custom"
  periodLabel?: string
  comparisonLabel?: string
}

export function ProfitabilityRadar({
  metrics,
  period,
  periodLabel,
  comparisonLabel,
}: ProfitabilityRadarProps) {
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

  const getGrowthIcon = (growth?: number) => {
    if (growth === undefined) return null
    if (growth > 0)
      return <TrendingUp className="h-4 w-4 text-green-600" />
    if (growth < 0)
      return <TrendingDown className="h-4 w-4 text-red-600" />
    return <Minus className="h-4 w-4 text-muted-foreground" />
  }

  const getPeriodTitle = () => {
    if (periodLabel) return periodLabel
    if (period === "mtd") return "Month to Date"
    if (period === "ytd") return "Year to Date"
    return "Custom Period"
  }

  return (
    <Card className="border-violet-200">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-violet-100">
              <BarChart3 className="h-5 w-5 text-violet-700" />
            </div>
            <div>
              <CardTitle className="text-base">Profitability Radar</CardTitle>
              <CardDescription>{getPeriodTitle()}</CardDescription>
            </div>
          </div>
          {metrics.revenueGrowth !== undefined && (
            <Badge
              variant="outline"
              className={`flex items-center gap-1 ${
                metrics.revenueGrowth >= 0
                  ? "border-green-300 text-green-700"
                  : "border-red-300 text-red-700"
              }`}
            >
              {getGrowthIcon(metrics.revenueGrowth)}
              {metrics.revenueGrowth >= 0 ? "+" : ""}
              {formatPercent(metrics.revenueGrowth)}
              {comparisonLabel && (
                <span className="text-xs ml-1">{comparisonLabel}</span>
              )}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Primary Metrics Grid */}
        <div className="grid grid-cols-2 gap-4">
          <div className="p-3 rounded-lg bg-muted/50">
            <div className="flex items-center gap-2 mb-1">
              <DollarSign className="h-4 w-4 text-green-600" />
              <span className="text-xs text-muted-foreground">Gross Income</span>
            </div>
            <p className="text-xl font-bold text-green-600">
              {formatCurrency(metrics.grossIncome)}
            </p>
          </div>
          <div className="p-3 rounded-lg bg-muted/50">
            <div className="flex items-center gap-2 mb-1">
              <TrendingUp className="h-4 w-4 text-violet-600" />
              <span className="text-xs text-muted-foreground">Net Profit</span>
            </div>
            <p className={`text-xl font-bold ${metrics.netProfit >= 0 ? "text-violet-600" : "text-red-600"}`}>
              {formatCurrency(metrics.netProfit)}
            </p>
          </div>
        </div>

        {/* Profit Margin Bar */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium flex items-center gap-2">
              <PieChart className="h-4 w-4" />
              Profit Margin
            </span>
            <span className={`text-sm font-bold ${getMarginColor(metrics.profitMargin)}`}>
              {formatPercent(metrics.profitMargin)}
            </span>
          </div>
          <Progress
            value={Math.min(metrics.profitMargin, 100)}
            className="h-2"
          />
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>0%</span>
            <span>25%</span>
            <span>50%</span>
            <span>75%</span>
            <span>100%</span>
          </div>
        </div>

        {/* Expense Ratio */}
        <div className="p-3 rounded-lg border border-amber-200 bg-amber-50/50">
          <div className="flex items-center justify-between">
            <span className="text-sm text-amber-800">Expense Ratio</span>
            <span className="text-sm font-bold text-amber-700">
              {formatPercent(metrics.expenseRatio)}
            </span>
          </div>
          <p className="text-xs text-amber-600 mt-1">
            {metrics.expenseRatio <= 30
              ? "Excellent cost control"
              : metrics.expenseRatio <= 50
                ? "Healthy expense ratio"
                : "Consider expense optimization"}
          </p>
        </div>

        {/* Target Progress */}
        {metrics.targetProgress !== undefined && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium flex items-center gap-2">
                <Target className="h-4 w-4" />
                Goal Progress
              </span>
              <span
                className={`text-sm font-bold ${
                  metrics.targetProgress >= 100
                    ? "text-green-600"
                    : metrics.targetProgress >= 75
                      ? "text-blue-600"
                      : metrics.targetProgress >= 50
                        ? "text-amber-600"
                        : "text-red-600"
                }`}
              >
                {formatPercent(metrics.targetProgress)}
              </span>
            </div>
            <Progress
              value={Math.min(metrics.targetProgress, 100)}
              className={`h-2 ${
                metrics.targetProgress >= 100
                  ? "[&>div]:bg-green-500"
                  : metrics.targetProgress >= 75
                    ? "[&>div]:bg-blue-500"
                    : metrics.targetProgress >= 50
                      ? "[&>div]:bg-amber-500"
                      : "[&>div]:bg-red-500"
              }`}
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
