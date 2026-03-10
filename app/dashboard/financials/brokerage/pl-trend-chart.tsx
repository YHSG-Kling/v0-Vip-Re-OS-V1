"use client"

import {
  ComposedChart,
  Bar,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts"

interface PLTrendChartProps {
  data: Array<{
    period_label: string
    gross_commission_income: number | null
    brokerage_net: number | null
    agent_splits_paid: number | null
  }>
}

export function PLTrendChart({ data }: PLTrendChartProps) {
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

  const chartData = data.map(item => ({
    period: item.period_label,
    gci: item.gross_commission_income || 0,
    brokerageNet: item.brokerage_net || 0,
    agentSplits: item.agent_splits_paid || 0,
  }))

  if (chartData.length === 0) {
    return (
      <div className="h-80 flex items-center justify-center text-muted-foreground">
        No trend data available
      </div>
    )
  }

  return (
    <div className="h-80">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
          <XAxis
            dataKey="period"
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
              name === "gci" ? "GCI" : name === "brokerageNet" ? "Brokerage Net" : "Agent Splits",
            ]}
            contentStyle={{
              backgroundColor: "hsl(var(--background))",
              border: "1px solid hsl(var(--border))",
              borderRadius: "8px",
            }}
          />
          <Legend
            verticalAlign="top"
            height={36}
            formatter={(value) => {
              if (value === "gci") return "GCI"
              if (value === "brokerageNet") return "Brokerage Net"
              if (value === "agentSplits") return "Agent Splits"
              return value
            }}
          />
          <Bar dataKey="gci" fill="#3b82f6" radius={[4, 4, 0, 0]} />
          <Bar dataKey="agentSplits" fill="#f59e0b" radius={[4, 4, 0, 0]} />
          <Line
            type="monotone"
            dataKey="brokerageNet"
            stroke="#10b981"
            strokeWidth={3}
            dot={{ fill: "#10b981", strokeWidth: 2, r: 4 }}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  )
}
