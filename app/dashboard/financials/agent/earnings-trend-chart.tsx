"use client"

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Line,
  ComposedChart,
  Legend,
} from "recharts"

interface EarningsTrendChartProps {
  data: Array<{
    month: string
    gross: number
    net: number
  }>
}

export function EarningsTrendChart({ data }: EarningsTrendChartProps) {
  const formatCurrency = (value: number) => {
    if (value >= 1000) {
      return `$${(value / 1000).toFixed(0)}k`
    }
    return `$${value}`
  }

  const formatTooltipValue = (value: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value)
  }

  return (
    <div className="h-[300px]">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          <XAxis
            dataKey="month"
            tick={{ fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            className="text-muted-foreground"
          />
          <YAxis
            tickFormatter={formatCurrency}
            tick={{ fontSize: 12 }}
            tickLine={false}
            axisLine={false}
            className="text-muted-foreground"
          />
          <Tooltip
            formatter={(value: number, name: string) => [
              formatTooltipValue(value),
              name === "net" ? "Agent Net" : "Gross Commission",
            ]}
            contentStyle={{
              backgroundColor: "hsl(var(--card))",
              border: "1px solid hsl(var(--border))",
              borderRadius: "8px",
            }}
            labelStyle={{ color: "hsl(var(--foreground))" }}
          />
          <Legend
            formatter={(value) => (
              <span className="text-sm">
                {value === "net" ? "Agent Net" : "Gross Commission"}
              </span>
            )}
          />
          <Bar
            dataKey="net"
            fill="#22c55e"
            radius={[4, 4, 0, 0]}
            name="net"
          />
          <Line
            type="monotone"
            dataKey="gross"
            stroke="#3b82f6"
            strokeWidth={2}
            dot={{ fill: "#3b82f6", strokeWidth: 2, r: 4 }}
            name="gross"
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
