"use client"

import { useState } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import {
  Receipt,
  TrendingUp,
  TrendingDown,
  ChevronRight,
  PieChart,
  Calendar,
  Plus,
} from "lucide-react"
import Link from "next/link"

interface ExpenseCategory {
  category: string
  amount: number
  percentOfTotal: number
  changeFromPrior?: number
}

interface ExpenseIntelligencePanelProps {
  summary: {
    mtd: number
    qtd: number
    ytd: number
    recurring: number
  }
  categories: ExpenseCategory[]
  aiInsight?: string
  onAddExpense?: () => void
}

export function ExpenseIntelligencePanel({
  summary,
  categories,
  aiInsight,
  onAddExpense,
}: ExpenseIntelligencePanelProps) {
  const [viewPeriod, setViewPeriod] = useState<"mtd" | "qtd" | "ytd">("mtd")

  const formatCurrency = (val: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(val)

  const periodValue = {
    mtd: summary.mtd,
    qtd: summary.qtd,
    ytd: summary.ytd,
  }

  const categoryColors = [
    "bg-violet-500",
    "bg-blue-500",
    "bg-green-500",
    "bg-amber-500",
    "bg-red-500",
    "bg-pink-500",
    "bg-indigo-500",
    "bg-teal-500",
  ]

  const sortedCategories = [...categories].sort((a, b) => b.amount - a.amount)
  const topCategories = sortedCategories.slice(0, 5)

  return (
    <Card className="border-orange-200">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="p-2 rounded-lg bg-orange-100">
              <Receipt className="h-5 w-5 text-orange-700" />
            </div>
            <div>
              <CardTitle className="text-base">Expense Intelligence</CardTitle>
              <CardDescription>Track spending and optimize costs</CardDescription>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {onAddExpense && (
              <Button variant="outline" size="sm" onClick={onAddExpense}>
                <Plus className="h-4 w-4 mr-1" />
                Add
              </Button>
            )}
            <Link href="/dashboard/financials/expenses">
              <Button variant="ghost" size="sm">
                View All
                <ChevronRight className="h-4 w-4 ml-1" />
              </Button>
            </Link>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Period Toggle */}
        <div className="flex items-center gap-1 p-1 bg-muted rounded-lg">
          {(["mtd", "qtd", "ytd"] as const).map((period) => (
            <button
              key={period}
              onClick={() => setViewPeriod(period)}
              className={`flex-1 px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                viewPeriod === period
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {period.toUpperCase()}
            </button>
          ))}
        </div>

        {/* Summary Stats */}
        <div className="grid grid-cols-2 gap-3">
          <div className="p-3 rounded-lg bg-orange-50 border border-orange-200">
            <div className="flex items-center gap-2 mb-1">
              <Calendar className="h-4 w-4 text-orange-600" />
              <span className="text-xs text-orange-700">{viewPeriod.toUpperCase()} Total</span>
            </div>
            <p className="text-xl font-bold text-orange-600">
              {formatCurrency(periodValue[viewPeriod])}
            </p>
          </div>
          <div className="p-3 rounded-lg bg-blue-50 border border-blue-200">
            <div className="flex items-center gap-2 mb-1">
              <Receipt className="h-4 w-4 text-blue-600" />
              <span className="text-xs text-blue-700">Recurring</span>
            </div>
            <p className="text-xl font-bold text-blue-600">
              {formatCurrency(summary.recurring)}
            </p>
            <p className="text-xs text-blue-600">/month</p>
          </div>
        </div>

        {/* Category Breakdown */}
        {topCategories.length > 0 && (
          <div>
            <h4 className="text-sm font-medium mb-2 flex items-center gap-2">
              <PieChart className="h-4 w-4" />
              Top Categories
            </h4>
            <div className="space-y-2">
              {topCategories.map((cat, idx) => (
                <div key={cat.category} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <div
                        className={`w-3 h-3 rounded-full ${categoryColors[idx % categoryColors.length]}`}
                      />
                      <span className="font-medium">{cat.category}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground">
                        {formatCurrency(cat.amount)}
                      </span>
                      {cat.changeFromPrior !== undefined && (
                        <Badge
                          variant="outline"
                          className={`text-xs ${
                            cat.changeFromPrior > 0
                              ? "border-red-200 text-red-600"
                              : cat.changeFromPrior < 0
                                ? "border-green-200 text-green-600"
                                : ""
                          }`}
                        >
                          {cat.changeFromPrior > 0 ? (
                            <TrendingUp className="h-3 w-3 mr-1" />
                          ) : cat.changeFromPrior < 0 ? (
                            <TrendingDown className="h-3 w-3 mr-1" />
                          ) : null}
                          {cat.changeFromPrior > 0 ? "+" : ""}
                          {cat.changeFromPrior.toFixed(0)}%
                        </Badge>
                      )}
                    </div>
                  </div>
                  <Progress
                    value={cat.percentOfTotal}
                    className={`h-1.5 [&>div]:${categoryColors[idx % categoryColors.length]}`}
                  />
                </div>
              ))}
            </div>
          </div>
        )}

        {/* AI Insight */}
        {aiInsight && (
          <div className="p-3 rounded-lg border border-violet-200 bg-violet-50/50">
            <p className="text-sm text-violet-800">
              <span className="font-medium">AI Insight:</span> {aiInsight}
            </p>
          </div>
        )}

        {/* Empty State */}
        {categories.length === 0 && (
          <div className="text-center py-6 text-muted-foreground">
            <Receipt className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p className="text-sm">No expenses recorded yet</p>
            {onAddExpense && (
              <Button variant="link" size="sm" onClick={onAddExpense} className="mt-2">
                Add your first expense
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
