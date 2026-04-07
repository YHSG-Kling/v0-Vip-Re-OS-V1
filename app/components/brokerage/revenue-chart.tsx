"use client"

import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { TrendingUp, DollarSign, Clock } from "lucide-react"

interface ForecastPeriod {
  month?: string
  period?: string
  projected_gci?: number
  actual_gci?: number
  deal_count?: number
}

interface BrokerageRevenueChartProps {
  forecast?: ForecastPeriod[] | null
  totalGCI?: number
  pendingCommissions?: number
}

export function BrokerageRevenueChart({
  forecast = [],
  totalGCI = 0,
  pendingCommissions = 0,
}: BrokerageRevenueChartProps) {
  const formatCurrency = (amount: number) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount)

  const periods = (forecast ?? []).slice(0, 6)
  const maxValue = Math.max(
    ...periods.map((p) => Math.max(p.projected_gci ?? 0, p.actual_gci ?? 0)),
    1,
  )

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <DollarSign className="w-5 h-5" />
              Revenue Overview
            </CardTitle>
            <CardDescription>GCI forecast &amp; actuals</CardDescription>
          </div>
          <div className="text-right space-y-1">
            <div>
              <p className="text-xs text-muted-foreground">Total GCI (YTD)</p>
              <p className="text-xl font-bold text-emerald-600">{formatCurrency(totalGCI)}</p>
            </div>
            {pendingCommissions > 0 && (
              <Badge variant="secondary" className="gap-1 text-xs">
                <Clock className="w-3 h-3" />
                {formatCurrency(pendingCommissions)} pending
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {periods.length > 0 ? (
          <div className="space-y-3">
            {periods.map((period, i) => {
              const label = period.month ?? period.period ?? `Period ${i + 1}`
              const projected = period.projected_gci ?? 0
              const actual = period.actual_gci ?? 0
              const deals = period.deal_count ?? 0
              const barValue = actual > 0 ? actual : projected

              return (
                <div key={label} className="space-y-1">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{label}</span>
                    <span className="text-muted-foreground">
                      {formatCurrency(barValue)}
                      {deals > 0 && ` · ${deals} deal${deals !== 1 ? "s" : ""}`}
                    </span>
                  </div>
                  <div className="relative h-2 bg-muted rounded-full overflow-hidden">
                    {projected > 0 && (
                      <div
                        className="absolute inset-y-0 left-0 bg-muted-foreground/30 rounded-full"
                        style={{ width: `${(projected / maxValue) * 100}%` }}
                      />
                    )}
                    {actual > 0 && (
                      <div
                        className="absolute inset-y-0 left-0 bg-primary rounded-full transition-all"
                        style={{ width: `${(actual / maxValue) * 100}%` }}
                      />
                    )}
                    {actual === 0 && projected > 0 && (
                      <div
                        className="absolute inset-y-0 left-0 bg-primary/40 rounded-full transition-all"
                        style={{ width: `${(projected / maxValue) * 100}%` }}
                      />
                    )}
                  </div>
                  {projected > 0 && actual > 0 && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <TrendingUp className="w-3 h-3" />
                      <span>
                        {actual >= projected
                          ? `+${formatCurrency(actual - projected)} vs forecast`
                          : `-${formatCurrency(projected - actual)} below forecast`}
                      </span>
                    </div>
                  )}
                </div>
              )
            })}
            <div className="flex items-center gap-4 pt-2 text-xs text-muted-foreground border-t">
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-2 bg-primary rounded" /> Actual
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-3 h-2 bg-muted-foreground/30 rounded" /> Forecast
              </span>
            </div>
          </div>
        ) : (
          <div className="text-center py-8 text-muted-foreground">
            <DollarSign className="w-12 h-12 mx-auto mb-4 opacity-20" />
            <p>No forecast data available</p>
            <p className="text-xs mt-1">
              Total GCI: {formatCurrency(totalGCI)}
              {pendingCommissions > 0 && ` · ${formatCurrency(pendingCommissions)} pending`}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
