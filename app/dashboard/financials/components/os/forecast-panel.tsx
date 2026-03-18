"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { TrendingUp, Calendar, Target, ArrowRight } from "lucide-react"

interface ForecastPanelProps {
  projections: {
    month: string
    projectedRevenue: number
    projectedExpenses: number
    projectedProfit: number
    confidence: "high" | "medium" | "low"
  }[]
  yearEndProjection?: {
    projectedIncome: number
    projectedExpenses: number
    projectedProfit: number
    profitMargin: number
  }
  pipelineValue?: number
}

export function ForecastPanel({
  projections,
  yearEndProjection,
  pipelineValue,
}: ForecastPanelProps) {
  const formatCurrency = (val: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(val)

  const confidenceColors = {
    high: "bg-green-100 text-green-700 border-green-200",
    medium: "bg-amber-100 text-amber-700 border-amber-200",
    low: "bg-red-100 text-red-700 border-red-200",
  }

  const upcomingMonths = projections.slice(0, 3)

  return (
    <Card className="border-blue-200">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-blue-100">
              <TrendingUp className="h-5 w-5 text-blue-700" />
            </div>
            <div>
              <CardTitle className="text-base">Financial Forecast</CardTitle>
              <CardDescription>Projected revenue and profitability</CardDescription>
            </div>
          </div>
          {pipelineValue !== undefined && (
            <Badge variant="outline" className="border-amber-200 text-amber-700 bg-amber-50">
              Pipeline: {formatCurrency(pipelineValue)}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Year End Projection */}
        {yearEndProjection && (
          <div className="p-4 rounded-lg bg-gradient-to-r from-blue-50 to-violet-50 border border-blue-200">
            <div className="flex items-center gap-2 mb-3">
              <Target className="h-4 w-4 text-blue-600" />
              <span className="text-sm font-medium text-blue-800">Year-End Projection</span>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <p className="text-xs text-muted-foreground">Projected Income</p>
                <p className="text-lg font-bold text-green-600">
                  {formatCurrency(yearEndProjection.projectedIncome)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Projected Expenses</p>
                <p className="text-lg font-bold text-red-600">
                  {formatCurrency(yearEndProjection.projectedExpenses)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Projected Profit</p>
                <p className={`text-lg font-bold ${yearEndProjection.projectedProfit >= 0 ? "text-violet-600" : "text-red-600"}`}>
                  {formatCurrency(yearEndProjection.projectedProfit)}
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Profit Margin</p>
                <p className={`text-lg font-bold ${yearEndProjection.profitMargin >= 25 ? "text-green-600" : yearEndProjection.profitMargin >= 15 ? "text-amber-600" : "text-red-600"}`}>
                  {yearEndProjection.profitMargin.toFixed(1)}%
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Monthly Projections */}
        {upcomingMonths.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
              <Calendar className="h-4 w-4" />
              Upcoming Months
            </h4>
            <div className="space-y-2">
              {upcomingMonths.map((month, idx) => (
                <div
                  key={month.month}
                  className="flex items-center justify-between p-3 rounded-lg bg-muted/50"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-20">
                      <p className="text-sm font-medium">{month.month}</p>
                    </div>
                    <Badge
                      variant="outline"
                      className={`text-xs ${confidenceColors[month.confidence]}`}
                    >
                      {month.confidence} conf.
                    </Badge>
                  </div>
                  <div className="flex items-center gap-4 text-sm">
                    <div className="text-right">
                      <span className="text-green-600 font-medium">
                        {formatCurrency(month.projectedRevenue)}
                      </span>
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground" />
                    <div className="text-right">
                      <span
                        className={`font-bold ${
                          month.projectedProfit >= 0 ? "text-violet-600" : "text-red-600"
                        }`}
                      >
                        {formatCurrency(month.projectedProfit)}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Empty State */}
        {projections.length === 0 && !yearEndProjection && (
          <div className="text-center py-6 text-muted-foreground">
            <TrendingUp className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">Forecast requires at least 3 months of data</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
