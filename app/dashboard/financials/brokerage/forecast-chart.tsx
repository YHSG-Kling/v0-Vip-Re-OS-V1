"use client"

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts"

interface ForecastChartProps {
  data: Array<{
    forecast_month: string
    projected_revenue: number | null
    actual_revenue?: number | null
  }>
}

export function ForecastChart({ data }: ForecastChartProps) {
  const formatCurrency = (val: number) => {
    if (val >= 1000000) {
      return `$${(val / 1000000).toFixed(1)}M`
    }
    if (val >= 1000) {
      return `$${(val / 1000).toFixed(0)}K`
    }
    return `$${val}`
  }

  const formatTooltipCurrency = (val: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(val)
  }

  const chartData = data.map(item => {
    const month = new Date(item.forecast_month).toLocaleDateString("en-US", {
      month: "short",
      year: "2-digit",
    })
    return {
      month,
      projected: item.projected_revenue || 0,
      actual: item.actual_revenue || 0,
    }
  })

  if (chartData.length === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-muted-foreground">
        No forecast data available
      </div>
    )
  }

  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={chartData} barCategoryGap="20%">
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          <XAxis
            dataKey="month"
            tick={{ fontSize: 12 }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tickFormatter={formatCurrency}
            tick={{ fontSize: 12 }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            formatter={(value: number, name: string) => [
              formatTooltipCurrency(value),
              name === "projected" ? "Projected" : "Actual",
            ]}
            contentStyle={{
              backgroundColor: "hsl(var(--background))",
              border: "1px solid hsl(var(--border))",
              borderRadius: "8px",
            }}
          />
          <Legend verticalAlign="top" height={36} />
          <Bar
            dataKey="projected"
            name="Projected"
            fill="#94a3b8"
            radius={[4, 4, 0, 0]}
          />
          <Bar
            dataKey="actual"
            name="Actual"
            fill="#3b82f6"
            radius={[4, 4, 0, 0]}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}
