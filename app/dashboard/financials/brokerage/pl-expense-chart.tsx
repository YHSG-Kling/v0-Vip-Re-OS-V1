"use client"

import { PieChart, Pie, Cell, ResponsiveContainer, Legend, Tooltip } from "recharts"

interface PLExpenseChartProps {
  agentSplits: number
  techExpenses: number
  marketingExpenses: number
  officeExpenses: number
  operatingExpenses: number
}

export function PLExpenseChart({
  agentSplits,
  techExpenses,
  marketingExpenses,
  officeExpenses,
  operatingExpenses,
}: PLExpenseChartProps) {
  const data = [
    { name: "Agent Splits", value: agentSplits, color: "#3b82f6" },
    { name: "Technology", value: techExpenses, color: "#8b5cf6" },
    { name: "Marketing", value: marketingExpenses, color: "#10b981" },
    { name: "Office", value: officeExpenses, color: "#f59e0b" },
    { name: "Operations", value: operatingExpenses, color: "#6b7280" },
  ].filter(item => item.value > 0)

  const total = data.reduce((sum, item) => sum + item.value, 0)

  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
      maximumFractionDigits: 0,
    }).format(val)
  }

  if (total === 0) {
    return (
      <div className="h-64 flex items-center justify-center text-muted-foreground">
        No expense data available
      </div>
    )
  }

  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            cx="50%"
            cy="50%"
            innerRadius={60}
            outerRadius={90}
            paddingAngle={2}
            dataKey="value"
            label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
            labelLine={false}
          >
            {data.map((entry, index) => (
              <Cell key={`cell-${index}`} fill={entry.color} />
            ))}
          </Pie>
          <Tooltip
            formatter={((value: number) => formatCurrency(value)) as any}
            contentStyle={{
              backgroundColor: "hsl(var(--background))",
              border: "1px solid hsl(var(--border))",
              borderRadius: "8px",
            }}
          />
          <Legend
            verticalAlign="bottom"
            height={36}
            formatter={(value, entry: any) => (
              <span className="text-sm">{value}</span>
            )}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  )
}
